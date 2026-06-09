import { resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

// pi harness adapter (HARNESS=pi, the default).
//
// Drives pi-coding-agent in-process through its public SDK (createAgentSession),
// mirroring the codex/copilot SDK adapters — no `pi --mode rpc` subprocess and no
// PI_ARGS. The Foundry/Azure OpenAI model is reached by registering a custom
// "foundry" provider in models.json (api: openai-responses, baseUrl from
// OF_OPENAI_BASE_URL) and supplying the key as a runtime override on AuthStorage
// (apikey mode) or a freshly minted AAD bearer per turn (managed-identity mode).
//
// Foundry's per-invocation sessionId maps onto a pi session dir: SessionManager
// .continueRecent(cwd, piSessionDir) continues the most recent conversation in
// that dir (or starts one), preserving state across turns — the SDK equivalent of
// the old `pi --continue --session-dir <dir>`.
//
// The in-process AgentSession emits the same events the RPC transport serialized
// (message_update/text_delta, agent_end with messages), so streaming is real and
// token-granular: each text_delta is forwarded to onTextDelta as it arrives.
export function createPiSdkAdapter({
  requestTimeoutMs,
  mock,
  HttpError,
  log,
  foundryOpenAIBaseUrl,
  foundryOpenAIModel,
  piAgentDir,
  modelAuth = "apikey",
  modelTokenScope,
}) {
  const isMock = Boolean(mock);
  const managedIdentity = modelAuth === "managed-identity";

  let createAgentSession;
  let AuthStorage;
  let ModelRegistry;
  let SessionManager;
  let authStorage;
  let modelRegistry;
  let model;

  function extractTextContent(content) {
    if (!Array.isArray(content)) return "";
    return content
      .filter((item) => item && item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
  }

  function extractFallbackText(messages) {
    if (!Array.isArray(messages)) return "";
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant") continue;
      const text = extractTextContent(message.content).trim();
      if (text.length > 0) return text;
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "toolResult") continue;
      const text = extractTextContent(message.content).trim();
      if (text.length > 0) return text;
    }
    return "";
  }

  function extractAgentEndError(messages) {
    if (!Array.isArray(messages)) return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant") continue;
      if (message.stopReason === "error" && typeof message.errorMessage === "string") {
        return message.errorMessage;
      }
    }
    return undefined;
  }

  async function loadJsonFile(path) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
      throw error;
    }
  }

  async function init() {
    if (isMock) return;
    let sdk;
    try {
      sdk = await import("@earendil-works/pi-coding-agent");
    } catch (err) {
      if (err?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "HARNESS=pi but @earendil-works/pi-coding-agent is not installed in this runtime image. " +
            "Use the pi image (pi-foundry-runtime), or set HARNESS=copilot/codex.",
        );
      }
      throw err;
    }
    ({ createAgentSession, AuthStorage, ModelRegistry, SessionManager } = sdk);
    await mkdir(piAgentDir, { recursive: true });
  }

  // Register the Foundry-backed model as a custom provider in models.json, then
  // build the AuthStorage + ModelRegistry the per-turn sessions reuse. The API key
  // is never written to models.json; it is supplied as a runtime override (apikey)
  // or minted per turn (managed-identity) so nothing secret touches disk.
  async function configureModelProvider() {
    if (isMock) return;
    if (!foundryOpenAIBaseUrl || !foundryOpenAIModel) return;
    // Never clobber a developer's interactive pi config dir.
    const home = process.env.HOME ?? "";
    if (home && piAgentDir === resolve(home, ".pi/agent")) {
      log("warn", "foundry_provider_skipped", { reason: "PI_CODING_AGENT_DIR resolves to ~/.pi/agent; refusing to overwrite interactive pi config", piAgentDir });
      return;
    }

    const modelsPath = resolve(piAgentDir, "models.json");
    const config = await loadJsonFile(modelsPath);
    const providers = config.providers && typeof config.providers === "object" ? config.providers : {};
    providers.foundry = {
      baseUrl: foundryOpenAIBaseUrl,
      api: "openai-responses",
      models: [
        {
          id: foundryOpenAIModel,
          name: `Foundry ${foundryOpenAIModel}`,
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 16384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
    config.providers = providers;
    await writeFile(modelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    authStorage = AuthStorage.create(resolve(piAgentDir, "auth.json"));
    modelRegistry = ModelRegistry.create(authStorage, modelsPath);
    model = modelRegistry.find("foundry", foundryOpenAIModel);
    if (!model) {
      throw new Error(`pi ModelRegistry could not resolve foundry/${foundryOpenAIModel} from ${modelsPath}`);
    }
    // apikey mode resolves OF_OPENAI_API_KEY once; managed-identity mints a fresh
    // bearer per turn in invoke().
    if (!managedIdentity && process.env.OF_OPENAI_API_KEY) {
      authStorage.setRuntimeApiKey("foundry", process.env.OF_OPENAI_API_KEY);
    }
    log("info", "foundry_openai_provider_configured", {
      provider: "foundry",
      model: foundryOpenAIModel,
      baseUrl: foundryOpenAIBaseUrl,
      modelsPath,
      modelAuth,
    });
  }

  async function mintManagedIdentityToken() {
    const { DefaultAzureCredential } = await import("@azure/identity");
    const scope = modelTokenScope || "https://cognitiveservices.azure.com/.default";
    const credential = new DefaultAzureCredential({
      managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined,
    });
    const token = await credential.getToken(scope);
    if (!token?.token) throw new Error("DefaultAzureCredential returned an empty token");
    return token.token;
  }

  async function invoke(prompt, options) {
    if (isMock) {
      return { text: `mock response: ${prompt}`, sessionId: options.sessionId, mock: true };
    }
    if (!model || !authStorage || !modelRegistry) {
      throw new HttpError(502, "pi provider is not configured; OF_OPENAI_BASE_URL/OF_OPENAI_MODEL must be set");
    }

    if (managedIdentity) {
      try {
        authStorage.setRuntimeApiKey("foundry", await mintManagedIdentityToken());
      } catch (error) {
        throw new HttpError(502, `failed to mint AAD token for managed-identity auth: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const sessionManager = SessionManager.continueRecent(options.cwd, options.piSessionDir);
    const { session } = await createAgentSession({
      cwd: options.cwd,
      agentDir: piAgentDir,
      authStorage,
      modelRegistry,
      model,
      sessionManager,
    });

    let text = "";
    let agentEndMessages;
    let timedOut = false;

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          text += update.delta;
          options.onTextDelta?.(update.delta);
        } else if (update?.type === "error") {
          // Transient stream hiccup; pi auto-retries. Final outcome is the
          // assistant stopReason on agent_end, checked after the turn settles.
          log("warning", "pi_stream_error", { message: update.errorMessage ?? update.reason ?? "unknown" });
        }
      } else if (event.type === "agent_end") {
        agentEndMessages = event.messages;
      }
    });

    const timer = requestTimeoutMs
      ? setTimeout(() => {
          timedOut = true;
          Promise.resolve(session.abort?.()).catch(() => {});
        }, requestTimeoutMs)
      : undefined;

    try {
      await session.prompt(prompt);
    } catch (error) {
      throw new HttpError(502, `pi invocation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
      session.dispose();
    }

    if (timedOut) {
      throw new HttpError(504, `pi request timed out after ${requestTimeoutMs}ms`);
    }
    const agentError = extractAgentEndError(agentEndMessages);
    if (agentError) {
      throw new HttpError(502, agentError);
    }
    return {
      text: text.length > 0 ? text : extractFallbackText(agentEndMessages),
      sessionId: options.sessionId,
      mock: false,
    };
  }

  async function dispose() {
    // Sessions are disposed per invoke; nothing persistent to tear down.
  }

  return { init, configureModelProvider, invoke, dispose };
}
