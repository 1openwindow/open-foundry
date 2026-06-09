import { resolve, dirname } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

// OpenAI Codex harness adapter (HARNESS=codex).
//
// Drives the Codex CLI runtime through @openai/codex-sdk's typed thread API.
// The model is reached by injecting a Codex provider definition (via the SDK
// `config` option) that points at the Foundry/Azure OpenAI endpoint and reads
// the API key from OF_OPENAI_API_KEY (env_key). BYOK is API-key only here, so
// managed-identity is rejected up front by the runtime contract.
//
// Foundry's per-invocation sessionId maps onto a Codex thread: the thread_id is
// captured from the `thread.started` event, persisted next to the session, and
// replayed with resumeThread() on later turns to preserve conversation state.
//
// Streaming is item-granular, not token-granular: per live probes against
// Foundry gpt-5.x, agent_message text never arrives via incremental updates —
// it lands whole on `item.completed`. We forward that whole message once to
// onTextDelta; the backend's SSE heartbeat covers the silent phase before it.
export function createCodexSdkAdapter({
  requestTimeoutMs,
  mock,
  HttpError,
  log,
  foundryOpenAIBaseUrl,
  foundryOpenAIModel,
  stateDir,
}) {
  const isMock = Boolean(mock);
  // Keep Codex state (sessions, logs) under STATE_DIR, never the user's HOME
  // (~/.codex), so the runtime never clobbers a developer's interactive config.
  const codexHome = resolve(stateDir, "codex-home");

  let Codex;
  let codex;
  let providerSummary;

  // Azure's provider base_url expects the resource ".../openai" root; pi-style
  // base URLs often carry an extra /v1 (or none), so normalize to ".../openai".
  function normalizeAzureBaseUrl(raw) {
    const root = raw
      .replace(/\/+$/, "")
      .replace(/\/openai\/v1$/i, "")
      .replace(/\/openai$/i, "")
      .replace(/\/v1$/i, "");
    return `${root}/openai`;
  }

  // Build the Codex `config` overrides that define a Foundry-backed provider.
  // The SDK flattens this into repeated `--config key=value` CLI flags.
  function buildProviderConfig() {
    const explicitType = (process.env.CODEX_PROVIDER_TYPE ?? "").trim().toLowerCase();
    const type = explicitType || (/\.azure\.com|azure/i.test(foundryOpenAIBaseUrl) ? "azure" : "openai");
    const wireApi = (process.env.CODEX_WIRE_API ?? "responses").trim().toLowerCase();

    if (type === "azure") {
      const baseUrl = normalizeAzureBaseUrl(foundryOpenAIBaseUrl);
      const apiVersion = (process.env.CODEX_API_VERSION ?? "2025-04-01-preview").trim();
      return {
        type,
        baseUrl,
        wireApi,
        config: {
          model_provider: "azure",
          model: foundryOpenAIModel,
          model_providers: {
            azure: {
              name: "Foundry Azure",
              base_url: baseUrl,
              env_key: "OF_OPENAI_API_KEY",
              query_params: { "api-version": apiVersion },
              wire_api: wireApi,
            },
          },
        },
      };
    }

    const baseUrl = foundryOpenAIBaseUrl.replace(/\/+$/, "");
    return {
      type,
      baseUrl,
      wireApi,
      config: {
        model_provider: "foundry",
        model: foundryOpenAIModel,
        model_providers: {
          foundry: {
            name: "Foundry",
            base_url: baseUrl,
            env_key: "OF_OPENAI_API_KEY",
            wire_api: wireApi,
          },
        },
      },
    };
  }

  async function init() {
    if (isMock) return;
    let sdk;
    try {
      sdk = await import("@openai/codex-sdk");
    } catch (err) {
      if (err?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "HARNESS=codex but @openai/codex-sdk is not installed in this runtime image. " +
            "Use the Codex image (codex-foundry-runtime), or set HARNESS=pi.",
        );
      }
      throw err;
    }
    Codex = sdk.Codex;
    await mkdir(codexHome, { recursive: true });
  }

  async function configureModelProvider() {
    if (isMock) return;
    if (!foundryOpenAIBaseUrl || !foundryOpenAIModel) return;
    const built = buildProviderConfig();
    providerSummary = { type: built.type, wireApi: built.wireApi, baseUrl: built.baseUrl };
    // The CLI inherits the runtime's env (so env_key OF_OPENAI_API_KEY resolves)
    // plus CODEX_HOME relocated under STATE_DIR.
    codex = new Codex({
      config: built.config,
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    log("info", "codex_provider_configured", {
      type: built.type,
      wireApi: built.wireApi,
      baseUrl: built.baseUrl,
      model: foundryOpenAIModel,
    });
  }

  function threadIdPath(piSessionDir) {
    // sessionRoot = dirname(piSessionDir); the backend mkdir's piSessionDir, so
    // sessionRoot already exists. One thread id per Foundry session.
    return resolve(dirname(piSessionDir), "codex-thread.json");
  }

  async function readThreadId(piSessionDir) {
    try {
      const raw = await readFile(threadIdPath(piSessionDir), "utf8");
      const parsed = JSON.parse(raw);
      return typeof parsed?.threadId === "string" ? parsed.threadId : undefined;
    } catch {
      return undefined;
    }
  }

  async function writeThreadId(piSessionDir, threadId) {
    try {
      await writeFile(threadIdPath(piSessionDir), JSON.stringify({ threadId }), "utf8");
    } catch (err) {
      log("warning", "codex_thread_persist_failed", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function invoke(prompt, options) {
    if (isMock) {
      return { text: `mock response: ${prompt}`, sessionId: options.sessionId, mock: true };
    }

    const threadOptions = {
      workingDirectory: options.cwd,
      skipGitRepoCheck: true,
      // The container is already the isolation boundary, so run Codex with no
      // approvals and full filesystem access (no inner bubblewrap sandbox).
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    };

    const existingThreadId = await readThreadId(options.piSessionDir);
    const thread = existingThreadId
      ? codex.resumeThread(existingThreadId, threadOptions)
      : codex.startThread(threadOptions);

    const controller = new AbortController();
    const timer = requestTimeoutMs
      ? setTimeout(() => controller.abort(), requestTimeoutMs)
      : undefined;

    let finalText = "";
    let persistedThreadId = existingThreadId;
    let lastError = "";

    try {
      const { events } = await thread.runStreamed(prompt, { signal: controller.signal });
      for await (const event of events) {
        switch (event?.type) {
          case "thread.started": {
            const id = event.thread_id;
            if (id && id !== persistedThreadId) {
              persistedThreadId = id;
              await writeThreadId(options.piSessionDir, id);
            }
            break;
          }
          case "item.completed": {
            const item = event.item;
            if (item?.type === "agent_message" && typeof item.text === "string") {
              // Last agent_message wins. Codex streaming is item-granular (no
              // token deltas), and on a transient reconnect/retry it can re-emit
              // a partial then the full message — so we DON'T forward per-item
              // deltas here (that would double-render). The final text is sent
              // once below, after the turn settles.
              finalText = item.text;
            }
            break;
          }
          case "error":
            // Non-fatal: Codex emits `error` for transient reconnects/retries
            // (e.g. "Reconnecting... 1/5 (stream disconnected ...)") and recovers
            // on its own. Record it and keep iterating; only turn.failed is fatal.
            lastError = event.message ?? "unknown";
            log("warning", "codex_stream_error", { message: lastError });
            break;
          case "turn.failed":
            throw new HttpError(502, `Codex turn failed: ${event.error?.message ?? "unknown"}`);
          default:
            break;
        }
      }

      if (!finalText) {
        throw new HttpError(502, lastError
          ? `Codex stream ended without an assistant message (last error: ${lastError})`
          : "Codex returned no assistant message");
      }
      // Deliver the whole assistant message as a single stream delta once the
      // turn has settled; the backend's SSE heartbeat covered the silent phase.
      options.onTextDelta?.(finalText);
      return { text: finalText, sessionId: options.sessionId, mock: false };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted) {
        throw new HttpError(504, `Codex invocation timed out after ${requestTimeoutMs}ms`);
      }
      throw new HttpError(502, `Codex invocation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function dispose() {
    // The SDK spawns the Codex CLI per run; nothing persistent to tear down.
    codex = undefined;
  }

  return { init, configureModelProvider, invoke, dispose };
}
