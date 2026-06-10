import { resolve, dirname } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

// OpenCode harness adapter (HARNESS=opencode).
//
// Drives the OpenCode server through @opencode-ai/sdk: createOpencodeServer
// spawns `opencode serve` (from the opencode-ai CLI) with our provider config
// injected via OPENCODE_CONFIG_CONTENT, then a typed HTTP client talks to it.
// The Foundry model is registered as a custom "foundry" provider backed by the
// bundled @ai-sdk/openai-compatible (or @ai-sdk/azure) SDK, so no provider npm
// is downloaded at runtime. BYOK is API-key only here, so managed-identity is
// rejected up front by the runtime contract.
//
// Foundry's per-invocation sessionId maps onto an OpenCode session: OpenCode
// mints its own session id on session.create(), so we capture it, persist it
// next to the Foundry session, and replay it on later turns to preserve state.
//
// Streaming is token-granular: we subscribe to the server's /event stream and
// forward `message.part.updated` text deltas; the backend's SSE heartbeat
// covers the silent phases before the first token.
export function createOpencodeSdkAdapter({
  requestTimeoutMs,
  mock,
  HttpError,
  log,
  foundryOpenAIBaseUrl,
  foundryOpenAIModel,
  stateDir,
}) {
  const isMock = Boolean(mock);
  // Keep OpenCode state (config, sessions, logs) under STATE_DIR via XDG dirs,
  // never the developer's ~/.local/share/opencode interactive config.
  const opencodeHome = resolve(stateDir, "opencode-home");
  const providerId = "foundry";

  let createOpencodeServer;
  let createOpencodeClient;
  let server;
  let client;
  let providerSummary;
  // Whichever agent the OpenCode session.prompt should run under. Empty uses the
  // server's default primary agent (build).
  const agent = (process.env.OPENCODE_AGENT ?? "").trim() || undefined;

  // Build the OpenCode config object that registers the Foundry-backed provider.
  // The Foundry OF_OPENAI_BASE_URL is already an OpenAI-compatible endpoint (the
  // same triple pi/codex use), so we point the bundled @ai-sdk/openai provider at
  // it as-is — no Azure path rewriting. @ai-sdk/openai drives the /responses API
  // and maps reasoning params correctly (e.g. gpt-5.x needs max_completion_tokens,
  // which the generic openai-compatible SDK gets wrong). Azure's /openai/v1
  // endpoint rejects a dated api-version, so we omit it unless explicitly set.
  function buildConfig() {
    const npm = (process.env.OPENCODE_PROVIDER_NPM ?? "@ai-sdk/openai").trim() || "@ai-sdk/openai";
    const baseURL = foundryOpenAIBaseUrl.replace(/\/+$/, "");
    const apiVersion = (process.env.OPENCODE_API_VERSION ?? "").trim();

    const options = {
      baseURL,
      apiKey: process.env.OF_OPENAI_API_KEY,
      ...(apiVersion ? { queryParams: { "api-version": apiVersion } } : {}),
    };

    const config = {
      // The container is the isolation boundary, so auto-approve every action
      // instead of blocking on interactive permission prompts.
      permission: { edit: "allow", bash: "allow", webfetch: "allow" },
      provider: {
        [providerId]: {
          npm,
          name: "Foundry",
          options,
          models: {
            [foundryOpenAIModel]: { name: `Foundry ${foundryOpenAIModel}` },
          },
        },
      },
    };
    return { config, summary: { npm, baseURL, apiVersion: apiVersion || undefined } };
  }

  async function init() {
    if (isMock) return;
    let sdk;
    try {
      sdk = await import("@opencode-ai/sdk");
    } catch (err) {
      if (err?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "HARNESS=opencode but @opencode-ai/sdk is not installed in this runtime image. " +
            "Use the OpenCode image (opencode-foundry-runtime), or set HARNESS=pi.",
        );
      }
      throw err;
    }
    createOpencodeServer = sdk.createOpencodeServer;
    createOpencodeClient = sdk.createOpencodeClient;
    await mkdir(opencodeHome, { recursive: true });
  }

  async function configureModelProvider() {
    if (isMock) return;
    if (!foundryOpenAIBaseUrl || !foundryOpenAIModel) return;
    const { config, summary } = buildConfig();
    providerSummary = summary;
    // Relocate OpenCode's XDG dirs under STATE_DIR so the server never touches
    // the developer's interactive config/data/cache.
    process.env.XDG_DATA_HOME = resolve(opencodeHome, "data");
    process.env.XDG_CONFIG_HOME = resolve(opencodeHome, "config");
    process.env.XDG_CACHE_HOME = resolve(opencodeHome, "cache");
    process.env.XDG_STATE_HOME = resolve(opencodeHome, "state");

    server = await createOpencodeServer({
      hostname: "127.0.0.1",
      port: 0, // let the OS pick a free port
      config,
      // Server boot can pull bundled assets on a cold start; give it headroom.
      timeout: 60000,
    });
    client = createOpencodeClient({ baseUrl: server.url });
    log("info", "opencode_provider_configured", {
      provider: providerId,
      npm: summary.npm,
      baseUrl: summary.baseURL,
      model: foundryOpenAIModel,
      serverUrl: server.url,
    });
  }

  function sessionIdPath(piSessionDir) {
    // The backend mkdir's piSessionDir, so its parent (the Foundry session root)
    // already exists. One OpenCode session id per Foundry session.
    return resolve(dirname(piSessionDir), "opencode-session.json");
  }

  async function readSessionId(piSessionDir) {
    try {
      const parsed = JSON.parse(await readFile(sessionIdPath(piSessionDir), "utf8"));
      return typeof parsed?.sessionId === "string" ? parsed.sessionId : undefined;
    } catch {
      return undefined;
    }
  }

  async function writeSessionId(piSessionDir, sessionId) {
    try {
      await writeFile(sessionIdPath(piSessionDir), JSON.stringify({ sessionId }), "utf8");
    } catch (err) {
      log("warning", "opencode_session_persist_failed", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  function unwrap(result) {
    // The generated client returns { data, error, response }; surface errors.
    if (result?.error) {
      const message = typeof result.error === "string" ? result.error : JSON.stringify(result.error);
      throw new HttpError(502, `OpenCode request failed: ${message}`);
    }
    return result?.data ?? result;
  }

  // Pull the assistant text out of a session.prompt response (info + parts).
  function extractText(response) {
    const parts = Array.isArray(response?.parts) ? response.parts : [];
    return parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }

  async function ensureSession(piSessionDir, cwd) {
    const existing = await readSessionId(piSessionDir);
    if (existing) return existing;
    // Bind the session to the workspace directory so OpenCode loads its project
    // context (AGENTS.md, .opencode/) from there, not the server's /app cwd.
    const created = unwrap(await client.session.create({ query: { directory: cwd }, body: { title: "foundry" } }));
    const id = created?.id;
    if (!id) throw new HttpError(502, "OpenCode session.create returned no id");
    await writeSessionId(piSessionDir, id);
    return id;
  }

  async function invoke(prompt, options) {
    if (isMock) {
      return { text: `mock response: ${prompt}`, sessionId: options.sessionId, mock: true };
    }
    if (!client || !server) {
      throw new HttpError(502, "OpenCode server is not configured; OF_OPENAI_BASE_URL/OF_OPENAI_MODEL must be set");
    }

    const opencodeSessionId = await ensureSession(options.piSessionDir, options.cwd);

    // Stream tokens by subscribing to the server event bus and filtering text
    // deltas for this session. The subscription is torn down once the turn ends.
    const controller = new AbortController();
    let streamed = "";
    const streamDone = (async () => {
      try {
        // event.subscribe returns the SSE result ({ stream }) directly, not the
        // { data, error } envelope the other methods use. Token deltas arrive as
        // `message.part.delta` events (field=text); `message.part.updated`
        // carries only the cumulative part, not incremental deltas.
        const events = await client.event.subscribe({ signal: controller.signal });
        for await (const event of events.stream) {
          if (controller.signal.aborted) break;
          if (event?.type !== "message.part.delta") continue;
          const props = event.properties;
          if (props?.sessionID !== opencodeSessionId) continue;
          if (props.field === "text" && typeof props.delta === "string" && props.delta.length > 0) {
            streamed += props.delta;
            options.onTextDelta?.(props.delta);
          }
        }
      } catch {
        // Aborted on turn completion, or the stream closed; non-fatal.
      }
    })();

    const timer = requestTimeoutMs
      ? setTimeout(() => controller.abort(), requestTimeoutMs)
      : undefined;

    try {
      const response = unwrap(
        await client.session.prompt({
          path: { id: opencodeSessionId },
          query: { directory: options.cwd },
          body: {
            ...(agent ? { agent } : {}),
            model: { providerID: providerId, modelID: foundryOpenAIModel },
            parts: [{ type: "text", text: prompt }],
          },
        }),
      );

      const text = extractText(response) || streamed;
      if (!text) throw new HttpError(502, "OpenCode returned no assistant message");
      return { text, sessionId: options.sessionId, mock: false };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted) {
        throw new HttpError(504, `OpenCode invocation timed out after ${requestTimeoutMs}ms`);
      }
      throw new HttpError(502, `OpenCode invocation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      await streamDone.catch(() => {});
    }
  }

  async function dispose() {
    if (server) {
      try {
        server.close();
      } catch {
        /* already gone */
      }
      server = undefined;
      client = undefined;
    }
  }

  return { init, configureModelProvider, invoke, dispose };
}
