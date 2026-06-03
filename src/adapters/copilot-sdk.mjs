import { resolve } from "node:path";

// GitHub Copilot harness adapter (HARNESS=copilot).
//
// Drives the Copilot CLI runtime through @github/copilot-sdk's typed JSON-RPC
// client. Foundry's per-invocation sessionId maps 1:1 onto a Copilot session;
// the model is reached via BYOK (provider config), which is API-key only —
// managed-identity is rejected up front by the runtime contract.
export function createCopilotSdkAdapter({
  requestTimeoutMs,
  mock,
  HttpError,
  log,
  foundryOpenAIBaseUrl,
  foundryOpenAIModel,
  stateDir,
}) {
  const isMock = Boolean(mock);
  // Keep Copilot session/config state under STATE_DIR, never the user's HOME.
  const copilotHome = resolve(stateDir, "copilot-home");

  let CopilotClient;
  let approveAll;
  let client;
  let provider;

  function resolveApiKey() {
    return process.env.PI_OPENAI_API_KEY ?? process.env.FOUNDRY_OPENAI_API_KEY;
  }

  // Azure's BYOK provider expects the resource root; pi-style base URLs often
  // carry an /openai/v1 (or /openai, /v1) suffix, so strip it back to the root.
  function normalizeAzureBaseUrl(raw) {
    return raw
      .replace(/\/+$/, "")
      .replace(/\/openai\/v1$/i, "")
      .replace(/\/openai$/i, "")
      .replace(/\/v1$/i, "");
  }

  function buildProvider() {
    const explicitType = (process.env.COPILOT_PROVIDER_TYPE ?? "").trim().toLowerCase();
    const type = explicitType || (/\.azure\.com|azure/i.test(foundryOpenAIBaseUrl) ? "azure" : "openai");
    const wireApi = (process.env.COPILOT_WIRE_API ?? "completions").trim().toLowerCase();
    const apiKey = resolveApiKey();
    const baseUrl = type === "azure"
      ? normalizeAzureBaseUrl(foundryOpenAIBaseUrl)
      : foundryOpenAIBaseUrl.replace(/\/+$/, "");

    return {
      type,
      wireApi,
      baseUrl,
      apiKey,
      modelId: foundryOpenAIModel,
      wireModel: foundryOpenAIModel,
      ...(type === "azure"
        ? { azure: { apiVersion: (process.env.COPILOT_API_VERSION ?? "2024-10-21").trim() } }
        : {}),
    };
  }

  async function init() {
    if (isMock) return;
    let sdk;
    try {
      sdk = await import("@github/copilot-sdk");
    } catch (err) {
      if (err?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "HARNESS=copilot but @github/copilot-sdk is not installed in this runtime image. " +
            "Use the Copilot image (ghcp-foundry-runtime), or set HARNESS=pi.",
        );
      }
      throw err;
    }
    CopilotClient = sdk.CopilotClient;
    approveAll = sdk.approveAll;
    client = new CopilotClient({ baseDirectory: copilotHome, logLevel: "error" });
    await client.start();
  }

  async function configureModelProvider() {
    if (isMock) return;
    if (!foundryOpenAIBaseUrl || !foundryOpenAIModel) return;
    provider = buildProvider();
    log("info", "copilot_provider_configured", {
      type: provider.type,
      wireApi: provider.wireApi,
      baseUrl: provider.baseUrl,
      model: foundryOpenAIModel,
      wireModel: provider.wireModel,
    });
  }

  async function invoke(prompt, options) {
    if (isMock) {
      return { text: `mock response: ${prompt}`, sessionId: options.sessionId, mock: true };
    }

    const sessionConfig = {
      model: foundryOpenAIModel,
      provider,
      onPermissionRequest: approveAll,
      streaming: true,
      workingDirectory: options.cwd,
    };

    let session;
    try {
      // Resume to continue the conversation; first turn for a sessionId throws,
      // so fall back to creating the session with the same id.
      session = await client.resumeSession(options.sessionId, sessionConfig);
    } catch {
      session = await client.createSession({ ...sessionConfig, sessionId: options.sessionId });
    }

    let streamed = "";
    const offDelta = session.on("assistant.message_delta", (event) => {
      const delta = event?.data?.deltaContent;
      if (delta) {
        streamed += delta;
        options.onTextDelta?.(delta);
      }
    });

    try {
      const result = await session.sendAndWait({ prompt }, requestTimeoutMs);
      const text = result?.data?.content ?? streamed;
      if (!text) throw new HttpError(502, "Copilot returned no assistant message");
      return { text, sessionId: options.sessionId, mock: false };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `Copilot invocation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      offDelta();
      await session.disconnect().catch(() => {});
    }
  }

  async function dispose() {
    if (client) {
      await client.stop().catch(() => {});
      client = undefined;
    }
  }

  return { init, configureModelProvider, invoke, dispose };
}
