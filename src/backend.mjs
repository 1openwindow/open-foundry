import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { createPiRpcAdapter } from "./adapters/pi-rpc.mjs";
import { validateRuntimeEnv } from "./contract.mjs";

// Invocations protocol wire constants (see azure-ai-agentserver-invocations).
const INVOCATION_ID_HEADER = "x-agent-invocation-id";
const SESSION_ID_HEADER = "x-agent-session-id";
const REQUEST_ID_HEADER = "x-request-id";
const CLIENT_REQUEST_ID_HEADER = "x-ms-client-request-id";
const ERROR_SOURCE_HEADER = "x-platform-error-source";
const ERROR_DETAIL_HEADER = "x-platform-error-detail";
const MAX_ERROR_DETAIL_LENGTH = 2048;
// Foundry-injected default session id; lower priority than the agent_session_id query param.
const platformSessionId = process.env.FOUNDRY_AGENT_SESSION_ID ?? "";
const serverVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return `pi-foundry/${pkg.version ?? "0.0.0"}`;
  } catch {
    return "pi-foundry";
  }
})();

// Foundry injects PORT (default 8088 per the invocations contract).
const port = Number.parseInt(process.env.PORT ?? "8088", 10);
const host = process.env.HOST ?? "0.0.0.0";
const requestTimeoutMs = Number.parseInt(process.env.REQUEST_TIMEOUT_MS ?? "300000", 10);
// Foundry's APIM gateway drops a streamed response after ~120s with no body bytes
// (408 "operation was timeout"). Emit an SSE keepalive comment on this interval so
// silent phases (tool execution, uploads) keep the gateway idle timer from firing.
// Set to 0 to disable. Default 20s gives a ~6x margin under the observed ~120s cap.
const sseHeartbeatMs = Number.parseInt(process.env.SSE_HEARTBEAT_MS ?? "20000", 10);
const piBin = process.env.PI_BIN ?? "pi";
const piArgs = parseArgs(process.env.PI_ARGS ?? "--mode rpc --no-session");
const mock = process.env.PI_MOCK === "1" || process.env.PI_MOCK === "true";
const diagnosticsEnabled = process.env.ENABLE_DIAGNOSTICS === "1" || process.env.ENABLE_DIAGNOSTICS === "true";
const workspaceDir = resolve(process.env.WORKSPACE_DIR ?? process.cwd());
const stateDir = resolve(process.env.STATE_DIR ?? `${process.env.HOME ?? "/tmp"}/.pi-foundry`);
const sessionsDir = resolve(process.env.SESSIONS_DIR ?? `${stateDir}/sessions`);
// Default per-runtime, NEVER ~/.pi/agent — that path is the developer's interactive pi config dir
// and clobbering it from a server-side process is a footgun.
const piAgentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? `${stateDir}/pi-agent`);
const foundryOpenAIBaseUrl = process.env.PI_OPENAI_BASE_URL ?? process.env.FOUNDRY_OPENAI_BASE_URL;
const foundryOpenAIModel = process.env.PI_OPENAI_MODEL ?? process.env.FOUNDRY_OPENAI_MODEL;
// Model auth mode: "apikey" (default, BYOK) or "managed-identity" (keyless, AAD token via
// DefaultAzureCredential injected per pi process through a pi `!command` apiKey).
const modelAuth = (process.env.PI_MODEL_AUTH ?? "apikey").trim().toLowerCase() === "managed-identity"
  ? "managed-identity"
  : "apikey";
const modelTokenScope = process.env.FOUNDRY_TOKEN_SCOPE ?? "https://cognitiveservices.azure.com/.default";

// Fail-fast: validate env against the runtime contract before any side effects.
{
  const issues = validateRuntimeEnv(process.env, { mock });
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  for (const warning of warnings) console.warn(JSON.stringify({ level: "warn", message: "env_warning", time: new Date().toISOString(), ...warning }));
  if (errors.length > 0) {
    for (const error of errors) console.error(JSON.stringify({ level: "error", message: "env_error", time: new Date().toISOString(), ...error }));
    console.error(JSON.stringify({ level: "error", message: "startup_aborted", time: new Date().toISOString(), reason: "missing required runtime env; run `pi-foundry doctor` inside the container for details." }));
    process.exit(1);
  }
}
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
  modelAuth,
  modelTokenScope,
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

// Mirrors the SDK's _sanitize_id: validate user-provided IDs (<=256 chars,
// [a-zA-Z0-9-_.:]) and fall back to a safe value instead of erroring. The ':'
// is allowed because platform session ids can look like "name:version".
const ID_RE = /^[a-zA-Z0-9\-_.:]+$/;
function sanitizeId(value, fallback) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !ID_RE.test(value)) {
    return fallback;
  }
  return value;
}

function parseTraceId(traceparent) {
  if (typeof traceparent !== "string") return undefined;
  const parts = traceparent.trim().split("-");
  if (parts.length >= 4 && parts[1].length === 32 && parts[1] !== "0".repeat(32)) return parts[1];
  return undefined;
}

function errorCodeForStatus(status) {
  switch (status) {
    case 400: return "invalid_request";
    case 404: return "not_found";
    case 501: return "not_implemented";
    case 502: return "upstream_error";
    case 504: return "upstream_timeout";
    default: return "internal_error";
  }
}

function sendError(res, { status, message, code, source = "upstream", detail, invocationId, sessionId }) {
  if (invocationId) res.setHeader(INVOCATION_ID_HEADER, invocationId);
  if (sessionId) res.setHeader(SESSION_ID_HEADER, sessionId);
  res.setHeader(ERROR_SOURCE_HEADER, source);
  if (detail) {
    const value = detail.length > MAX_ERROR_DETAIL_LENGTH
      ? `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH - "...[truncated]".length)}...[truncated]`
      : detail;
    res.setHeader(ERROR_DETAIL_HEADER, value);
  }
  const body = JSON.stringify({ error: { code: code ?? errorCodeForStatus(status), message } });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleInvocation(payload, invocationId, sessionId, onTextDelta) {
  if (isDiagnosticsRequest(payload)) {
    const diagnostics = await runFoundryOpenAIDiagnostics();
    const diagnosticsText = JSON.stringify(diagnostics, null, 2);
    return {
      statusCode: diagnostics.ok === false ? 502 : 200,
      body: { output: diagnosticsText, modelText: diagnosticsText, sessionId, mock: false },
    };
  }

  const prompt = extractPrompt(payload);
  if (!prompt) {
    throw new HttpError(400, "Request body must include message, prompt, input, or input.message, or be a non-empty plain text body");
  }

  const sessionRoot = resolve(sessionsDir, sessionId);
  const piSessionDir = resolve(sessionRoot, "pi-sessions");
  const cwd = resolveInvocationCwd(payload.cwd);
  const started = Date.now();

  await mkdir(piSessionDir, { recursive: true });

  log("info", "invocation_start", {
    invocationId,
    sessionId,
    cwd,
    piSessionDir,
    promptLength: prompt.length,
  });

  try {
    const result = await piAdapter.invoke(prompt, { requestId: invocationId, sessionId, cwd, piSessionDir, onTextDelta });
    const latencyMs = Date.now() - started;
    const modelText = result.text;
    const output = modelText;

    log("info", "invocation_end", {
      invocationId,
      sessionId,
      latencyMs,
      outputLength: output.length,
      mock: result.mock,
      piExitCode: result.piExitCode,
    });
    return {
      statusCode: 200,
      body: {
        output,
        modelText,
        sessionId: result.sessionId,
        mock: result.mock,
      },
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    log("error", "invocation_error", {
      invocationId,
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
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // B2: resolve request correlation id (incoming x-request-id -> UUID).
  const requestId = sanitizeId(req.headers[REQUEST_ID_HEADER], "") || randomUUID();
  const clientRequestId = typeof req.headers[CLIENT_REQUEST_ID_HEADER] === "string" ? req.headers[CLIENT_REQUEST_ID_HEADER] : undefined;
  const traceId = parseTraceId(req.headers.traceparent);
  const startedAt = Date.now();

  // B2/B3: platform headers on every response. setHeader values survive writeHead
  // unless explicitly overridden, so this covers JSON, SSE, and error paths.
  res.setHeader(REQUEST_ID_HEADER, requestId);
  res.setHeader("x-platform-server", serverVersion);

  // B1: inbound request logging (start + completion).
  log("info", "request_start", { requestId, method, path, clientRequestId, traceId });
  res.on("finish", () => {
    log(res.statusCode >= 400 ? "warn" : "info", "request_end", {
      requestId, method, path, status: res.statusCode, latencyMs: Date.now() - startedAt,
    });
  });

  // Scoped so the catch-all error handler can echo invocation/session ids.
  let invocationId;
  let sessionId;

  try {
    if (method === "GET" && (path === "/health" || path === "/readiness")) {
      sendJson(res, 200, {
        status: "healthy",
        service: "pi-foundry",
        mock,
        workspaceDir,
        stateDir,
        sessionsDir,
        piAgentDir,
        foundryOpenAIConfigured: Boolean(process.env.PI_OPENAI_API_KEY ?? process.env.FOUNDRY_OPENAI_API_KEY),
        foundryOpenAIModel: foundryOpenAIModel ?? null,
        diagnosticsEnabled,
      });
      return;
    }

    if (method === "GET" && path === "/invocations/docs/openapi.json") {
      sendJson(res, 200, openApiSpec);
      return;
    }

    if (method === "POST" && path === "/invocations") {
      const bodyText = await readBodyText(req);
      const payload = parseInvocationBody(bodyText, req.headers["content-type"] ?? "");

      // A2: invocation id from the platform header, else a generated UUID.
      invocationId = sanitizeId(req.headers[INVOCATION_ID_HEADER], randomUUID());
      // A3: session id resolution order — agent_session_id query param ->
      // FOUNDRY_AGENT_SESSION_ID env -> request body sessionId -> generated UUID.
      sessionId = sanitizeId(
        url.searchParams.get("agent_session_id") || platformSessionId || payload.sessionId || "",
        randomUUID(),
      );
      // A5: echo invocation/session ids on the response (success and error).
      res.setHeader(INVOCATION_ID_HEADER, invocationId);
      res.setHeader(SESSION_ID_HEADER, sessionId);

      if (wantsEventStream(req, url)) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        // Keep the gateway idle timer alive during silent phases (tool runs, uploads).
        // SSE comments (`:`-prefixed) are ignored by every spec-compliant parser, so
        // they never surface as token/done events.
        const heartbeat = sseHeartbeatMs > 0
          ? setInterval(() => { try { res.write(": keepalive\n\n"); } catch { /* connection gone */ } }, sseHeartbeatMs)
          : undefined;
        res.on("close", () => { if (heartbeat) clearInterval(heartbeat); });

        try {
          const result = await handleInvocation(payload, invocationId, sessionId, (delta) => {
            writeSse(res, { type: "token", content: delta });
          });
          // SSE contract: token events are model deltas ONLY.
          writeSse(res, {
            type: "done",
            full_text: result.body.modelText,
            session_id: result.body.sessionId,
            invocation_id: invocationId,
            request_id: requestId,
          });
        } catch (streamError) {
          // Status line already sent; surface the failure as a terminal SSE event.
          log("error", "invocation_stream_error", { requestId, invocationId, sessionId, error: serializeError(streamError) });
          writeSse(res, {
            type: "error",
            message: streamError instanceof Error ? streamError.message : String(streamError),
            invocation_id: invocationId,
            request_id: requestId,
          });
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
        res.end();
        return;
      }

      const result = await handleInvocation(payload, invocationId, sessionId);
      // Non-SSE JSON response: `output` is the model text; raw `modelText` is omitted
      // from the envelope since it duplicates `output`.
      const { modelText: _omitted, ...jsonBody } = result.body;
      sendJson(res, result.statusCode, { invocationId, requestId, ...jsonBody });
      return;
    }

    if (method === "GET" && path.startsWith("/invocations/")) {
      sendError(res, { status: 501, message: "Long-running invocation polling is not implemented" });
      return;
    }

    sendError(res, { status: 404, message: "Not found" });
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : 500;
    const message = status >= 500
      ? "Internal server error"
      : (error instanceof Error ? error.message : String(error));
    const detail = status >= 500 && error instanceof Error ? `${error.name}: ${error.message}` : undefined;
    sendError(res, { status, message, detail, invocationId, sessionId });
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
    stateDir,
    sessionsDir,
    piAgentDir,
  });
});
