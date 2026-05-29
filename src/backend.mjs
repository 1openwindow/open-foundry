import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { createPiRpcAdapter } from "./adapters/pi-rpc.mjs";
import { createArtifactManager } from "./runtime/artifacts.mjs";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const host = process.env.HOST ?? "0.0.0.0";
const requestTimeoutMs = Number.parseInt(process.env.REQUEST_TIMEOUT_MS ?? "300000", 10);
const piBin = process.env.PI_BIN ?? "pi";
const piArgs = parseArgs(process.env.PI_ARGS ?? "--mode rpc --no-session");
const mock = process.env.PI_MOCK === "1" || process.env.PI_MOCK === "true";
const diagnosticsEnabled = process.env.ENABLE_DIAGNOSTICS === "1" || process.env.ENABLE_DIAGNOSTICS === "true";
const workspaceDir = resolve(process.env.WORKSPACE_DIR ?? process.cwd());
const filesDir = resolve(process.env.FILES_DIR ?? `${workspaceDir}/.files`);
const stateDir = resolve(process.env.STATE_DIR ?? `${process.env.HOME ?? "/tmp"}/.pi-foundry`);
const sessionsDir = resolve(process.env.SESSIONS_DIR ?? `${stateDir}/sessions`);
const piAgentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME ?? "/tmp"}/.pi/agent`);
const foundryOpenAIBaseUrl =
  process.env.PI_OPENAI_BASE_URL ??
  process.env.FOUNDRY_OPENAI_BASE_URL ??
  "https://zihch-test-wus3-resource.services.ai.azure.com/openai/v1";
const foundryOpenAIModel = process.env.PI_OPENAI_MODEL ?? process.env.FOUNDRY_OPENAI_MODEL ?? "gpt-5.4-mini";
const artifactPublishMode = process.env.ARTIFACT_PUBLISH_MODE ?? "disabled";
const artifactStorageAccount = process.env.ARTIFACT_STORAGE_ACCOUNT;
const artifactStaticWebEndpoint = process.env.ARTIFACT_STATIC_WEB_ENDPOINT;
const artifactStaticWebContainer = process.env.ARTIFACT_STATIC_WEB_CONTAINER ?? "$web";
const artifactBlobPrefix = (process.env.ARTIFACT_BLOB_PREFIX ?? "pi-foundry").replace(/^\/+|\/+$/g, "");
const artifactMaxPublishBytes = Number.parseInt(process.env.ARTIFACT_MAX_PUBLISH_BYTES ?? "104857600", 10);
const artifactPromptHints = process.env.ARTIFACT_PROMPT_HINTS !== "0" && process.env.ARTIFACT_PROMPT_HINTS !== "false";
class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

function parseArgs(value) {
  return value.trim().length === 0 ? [] : value.trim().split(/\s+/);
}

function log(level, message, fields = {}) {
  console.log(JSON.stringify({ level, message, time: new Date().toISOString(), ...fields }));
}

const piAdapter = createPiRpcAdapter({
  piBin,
  piArgs,
  piAgentDir,
  requestTimeoutMs,
  mock,
  HttpError,
  log,
  foundryOpenAIBaseUrl,
  foundryOpenAIModel,
});

const artifactManager = createArtifactManager({
  filesDir,
  artifactPublishMode,
  artifactStorageAccount,
  artifactStaticWebEndpoint,
  artifactStaticWebContainer,
  artifactBlobPrefix,
  artifactMaxPublishBytes,
  artifactPromptHints,
  HttpError,
  isInside,
  log,
});

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBodyText(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
  });
}

function parseInvocationBody(text, contentType) {
  if (text.trim().length === 0) return {};
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new HttpError(400, `Invalid JSON request body: ${error.message}`);
    }
  }
  return { message: text.trim() };
}

function extractPrompt(payload) {
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.prompt === "string") return payload.prompt;
  if (typeof payload.input === "string") return payload.input;
  if (payload.input && typeof payload.input.message === "string") return payload.input.message;
  return undefined;
}

function isDiagnosticsRequest(payload) {
  if (!diagnosticsEnabled) return false;
  if (payload?.diagnostics === true) return true;
  const prompt = extractPrompt(payload);
  return typeof prompt === "string" && prompt.trim() === "/diagnostics";
}

async function runFoundryOpenAIDiagnostics() {
  const apiKey = process.env.PI_OPENAI_API_KEY ?? process.env.FOUNDRY_OPENAI_API_KEY;
  if (!apiKey) return { configured: false, error: "PI_OPENAI_API_KEY is not set" };

  const started = Date.now();
  const response = await fetch(`${foundryOpenAIBaseUrl.replace(/\/+$/, "")}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: foundryOpenAIModel, input: "Say exactly: ok", stream: false }),
  });
  const text = await response.text();
  return {
    configured: true,
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    latencyMs: Date.now() - started,
    bodyPreview: text.slice(0, 1000),
  };
}

function wantsEventStream(req, url) {
  if (url.searchParams.get("stream") === "true") return true;
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/event-stream");
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function isInside(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function resolveInvocationCwd(value) {
  if (typeof value !== "string" || value.trim().length === 0) return workspaceDir;

  const requested = value.startsWith(sep) ? resolve(value) : resolve(workspaceDir, value);
  if (!isInside(workspaceDir, requested)) {
    throw new HttpError(400, `cwd must stay within WORKSPACE_DIR (${workspaceDir})`);
  }
  return requested;
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error instanceof HttpError && error.details !== undefined ? { details: error.details } : {}),
    };
  }
  return { message: String(error) };
}

function normalizeSessionId(value) {
  if (value === undefined || value === null || value === "") return randomUUID();
  if (typeof value !== "string") throw new HttpError(400, "sessionId must be a string");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new HttpError(400, "sessionId must be 1-128 characters and contain only letters, numbers, dots, underscores, or hyphens");
  }
  return value;
}

async function handleInvocation(payload, requestId, sessionIdOverride, onTextDelta) {
  if (isDiagnosticsRequest(payload)) {
    const diagnostics = await runFoundryOpenAIDiagnostics();
    return {
      statusCode: diagnostics.ok === false ? 502 : 200,
      body: { output: JSON.stringify(diagnostics, null, 2), sessionId: normalizeSessionId(sessionIdOverride ?? payload.sessionId), mock: false },
    };
  }

  const prompt = extractPrompt(payload);
  if (!prompt) {
    throw new HttpError(400, "Request body must include message, prompt, input, or input.message, or be a non-empty plain text body");
  }

  const sessionId = normalizeSessionId(sessionIdOverride ?? payload.sessionId);
  const sessionRoot = resolve(sessionsDir, sessionId);
  const piSessionDir = resolve(sessionRoot, "pi-sessions");
  const cwd = resolveInvocationCwd(payload.cwd);
  const started = Date.now();
  const artifactId = `${new Date(started).toISOString().slice(0, 10)}/${requestId}`;
  const artifactDir = resolve(filesDir, artifactId);

  await Promise.all([mkdir(piSessionDir, { recursive: true }), mkdir(artifactDir, { recursive: true })]);

  log("info", "invocation_start", {
    requestId,
    sessionId,
    cwd,
    piSessionDir,
    artifactDir,
    promptLength: prompt.length,
  });

  try {
    const effectivePrompt = artifactManager.withArtifactPromptHint(prompt, artifactDir);
    const result = await piAdapter.invoke(effectivePrompt, { requestId, sessionId, cwd, piSessionDir, onTextDelta });
    const latencyMs = Date.now() - started;
    let artifacts = [];
    let output = result.text;
    try {
      artifacts = await artifactManager.publishStaticWebArtifacts({ artifactId, artifactDir, requestId, sessionId });
      output = artifactManager.appendArtifactLinks(output, artifacts);
    } catch (publishError) {
      log("error", "artifact_publish_error", { requestId, sessionId, artifactId, error: serializeError(publishError) });
      output = `${output.trimEnd()}\n\nArtifact publishing failed: ${publishError instanceof Error ? publishError.message : String(publishError)}`;
    }

    log("info", "invocation_end", {
      requestId,
      sessionId,
      latencyMs,
      outputLength: output.length,
      artifactCount: artifacts.length,
      mock: result.mock,
      piExitCode: result.piExitCode,
    });
    return { statusCode: 200, body: { output, sessionId: result.sessionId, mock: result.mock, artifacts } };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    log("error", "invocation_error", {
      requestId,
      sessionId,
      latencyMs,
      statusCode,
      error: serializeError(error),
    });
    throw error;
  }
}

async function ensureRuntimeDirs() {
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(filesDir, { recursive: true }),
    mkdir(piAgentDir, { recursive: true }),
    mkdir(sessionsDir, { recursive: true }),
  ]);
}

const openApiSpec = {
  openapi: "3.0.3",
  info: { title: "pi-foundry Invocations API", version: "0.1.0" },
  paths: {
    "/health": { get: { responses: { 200: { description: "Health check" } } } },
    "/readiness": { get: { responses: { 200: { description: "Readiness check" } } } },
    "/artifacts/{path}": {
      get: {
        summary: "Serve generated artifact files from FILES_DIR",
        parameters: [
          {
            name: "path",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Relative artifact path under FILES_DIR",
          },
        ],
        responses: {
          200: { description: "Artifact file" },
          400: { description: "Invalid artifact path" },
          404: { description: "Artifact not found" },
        },
      },
    },
    "/invocations": {
      post: {
        summary: "Invoke pi",
        parameters: [
          {
            name: "agent_session_id",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Foundry Invocations session id. Mirrors response sessionId.",
          },
          {
            name: "stream",
            in: "query",
            required: false,
            schema: { type: "boolean" },
            description: "When true, return text/event-stream token and done events.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  input: { type: "string" },
                  sessionId: { type: "string" },
                  cwd: { type: "string" },
                },
              },
            },
            "text/plain": { schema: { type: "string" } },
          },
        },
        responses: {
          200: { description: "Invocation result as JSON or SSE" },
          400: { description: "Invalid request" },
          502: { description: "pi execution failed" },
          504: { description: "pi execution timed out" },
        },
      },
    },
  },
};

await ensureRuntimeDirs();
await piAdapter.configureFoundryOpenAIProvider();

const server = createServer(async (req, res) => {
  const requestId = randomUUID();
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/readiness")) {
      sendJson(res, 200, {
        ok: true,
        service: "pi-foundry",
        mock,
        workspaceDir,
        filesDir,
        stateDir,
        sessionsDir,
        piAgentDir,
        foundryOpenAIConfigured: Boolean(process.env.PI_OPENAI_API_KEY ?? process.env.FOUNDRY_OPENAI_API_KEY),
        foundryOpenAIModel,
        artifactPublishing: {
          mode: artifactPublishMode,
          enabled: artifactManager.staticWebPublishingEnabled(),
          storageAccount: artifactStorageAccount ?? null,
          staticWebEndpoint: artifactStaticWebEndpoint ?? null,
          blobPrefix: artifactBlobPrefix,
        },
        diagnosticsEnabled,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/invocations/docs/openapi.json") {
      sendJson(res, 200, openApiSpec);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/artifacts/")) {
      const artifactPath = artifactManager.resolveArtifactPath(url.pathname);
      await artifactManager.sendArtifactFile(res, artifactPath);
      return;
    }

    if (req.method === "POST" && url.pathname === "/invocations") {
      const bodyText = await readBodyText(req);
      const payload = parseInvocationBody(bodyText, req.headers["content-type"] ?? "");
      const sessionId = url.searchParams.get("agent_session_id") ?? undefined;

      if (wantsEventStream(req, url)) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        let streamedText = "";
        const result = await handleInvocation(payload, requestId, sessionId, (delta) => {
          streamedText += delta;
          writeSse(res, { type: "token", content: delta });
        });
        if (result.body.output.startsWith(streamedText) && result.body.output.length > streamedText.length) {
          writeSse(res, { type: "token", content: result.body.output.slice(streamedText.length) });
        }
        writeSse(res, {
          type: "done",
          full_text: result.body.output,
          session_id: result.body.sessionId,
          request_id: requestId,
          artifacts: result.body.artifacts ?? [],
        });
        res.end();
        return;
      }

      const result = await handleInvocation(payload, requestId, sessionId);
      sendJson(res, result.statusCode, { requestId, ...result.body });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/invocations/")) {
      sendJson(res, 501, { requestId, error: "Long-running invocation polling is not implemented" });
      return;
    }

    sendJson(res, 404, { requestId, error: "Not found" });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    sendJson(res, statusCode, { requestId, error: error instanceof Error ? error.message : String(error) });
  }
});

server.on("error", (error) => {
  log("error", "server_failed", { error: serializeError(error) });
  process.exitCode = 1;
});

server.listen(port, host, () => {
  log("info", "server_listening", {
    url: `http://${host}:${port}`,
    mode: mock ? "mock" : "pi-rpc",
    piBin,
    piArgs,
    workspaceDir,
    filesDir,
    stateDir,
    sessionsDir,
    piAgentDir,
  });
});
