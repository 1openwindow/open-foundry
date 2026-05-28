import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, posix, relative, resolve, sep } from "node:path";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";

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
let artifactContainerClientPromise;

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

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function contentTypeForPath(path) {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".md":
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".vtt":
      return "text/vtt; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".zip":
      return "application/zip";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    default:
      return "application/octet-stream";
  }
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

function resolveArtifactPath(urlPathname) {
  const encodedRelativePath = urlPathname.slice("/artifacts/".length);
  if (encodedRelativePath.length === 0) throw new HttpError(400, "artifact path is required");

  let relativePath;
  try {
    relativePath = decodeURIComponent(encodedRelativePath);
  } catch (error) {
    throw new HttpError(400, `invalid artifact path encoding: ${error.message}`);
  }

  if (relativePath.includes("\0")) throw new HttpError(400, "artifact path contains invalid characters");
  const requested = resolve(filesDir, relativePath);
  if (!isInside(filesDir, requested)) {
    throw new HttpError(400, `artifact path must stay within FILES_DIR (${filesDir})`);
  }
  return requested;
}

async function sendArtifactFile(res, path) {
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new HttpError(404, "artifact not found");
    }
    throw error;
  }

  if (!fileStat.isFile()) throw new HttpError(404, "artifact not found");

  res.writeHead(200, {
    "content-type": contentTypeForPath(path),
    "content-length": fileStat.size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });

  await new Promise((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("end", resolveStream);
    stream.pipe(res);
  });
}

function staticWebPublishingEnabled() {
  return artifactPublishMode === "static-web" && Boolean(artifactStorageAccount && artifactStaticWebEndpoint);
}

function getArtifactContainerClient() {
  if (!staticWebPublishingEnabled()) return undefined;
  artifactContainerClientPromise ??= Promise.resolve().then(() => {
    const credential = new DefaultAzureCredential({
      managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined,
    });
    const serviceClient = new BlobServiceClient(`https://${artifactStorageAccount}.blob.core.windows.net`, credential);
    return serviceClient.getContainerClient(artifactStaticWebContainer);
  });
  return artifactContainerClientPromise;
}

function likelyArtifactPrompt(prompt) {
  return /\b(html|artifact|artifacts|file|files|report|mp3|mp4|video|audio|zip|download|webpage|page|presentation|slides?)\b/i.test(prompt) ||
    /文件|网页|页面|报告|音频|视频|下载|产物|生成|汇报|演示|幻灯片|可播放|预览/.test(prompt);
}

function likelyHtmlPresentationPrompt(prompt) {
  return /\b(html|webpage|page|report|presentation|slides?|hyperframes?)\b/i.test(prompt) ||
    /网页|页面|报告|汇报|演示|幻灯片|可播放|预览/.test(prompt);
}

function withArtifactPromptHint(prompt, artifactDir) {
  if (!artifactPromptHints || !likelyArtifactPrompt(prompt)) return prompt;
  const hints = [
    "Artifact delivery contract:",
    `- Write all generated downloadable files under: ${artifactDir}`,
    "- Do not write downloadable artifacts outside that directory unless the user explicitly asks.",
    "- Use relative paths between files inside that directory, for example ./narration.mp3 from index.html.",
    "- When finished, summarize generated file names only. Do not paste full generated file contents into chat unless asked.",
  ];

  if (likelyHtmlPresentationPrompt(prompt)) {
    hints.push(
      "",
      "Browser-playable HTML report/presentation contract:",
      "- Generate index.html as a standalone static website; do not rely on external CDN or external JavaScript.",
      "- Generate script.md for speaker notes or narration draft.",
      "- Generate artifact-manifest.json listing the files that should be published.",
      "- Prefer a 1920x1080 16:9 scene-based presentation over one long scrolling page.",
      "- Use <section class=\"scene\" data-start=\"...\" data-duration=\"...\"> for each scene.",
      "- CSS must hide inactive scenes and show only .scene.active: .scene { opacity: 0; pointer-events: none; } .scene.active { opacity: 1; pointer-events: auto; }",
      "- JavaScript must read data-start/data-duration and switch the active scene over time.",
      "- Add simple play/pause, previous/next, and progress controls.",
      "- Initial view must show scene 1, not the final scene. Do not allow all scenes to be visible at once.",
    );
  }

  return [hints.join("\n"), "", prompt].join("\n");
}

function encodeStaticWebPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function listArtifactFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const child = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listArtifactFiles(child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

async function readArtifactManifest(root) {
  const manifestPath = resolve(root, "artifact-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    log("warn", "artifact_manifest_ignored", { manifestPath, error: serializeError(error) });
    return undefined;
  }

  if (!Array.isArray(manifest.artifacts)) return undefined;
  return manifest.artifacts
    .map((entry) => {
      if (!entry || typeof entry.path !== "string") return undefined;
      const localPath = resolve(root, entry.path);
      if (!isInside(root, localPath)) return undefined;
      return {
        localPath,
        name: typeof entry.name === "string" ? entry.name : basename(entry.path),
        description: typeof entry.description === "string" ? entry.description : undefined,
        contentType: typeof entry.contentType === "string" ? entry.contentType : undefined,
      };
    })
    .filter(Boolean);
}

async function collectArtifactEntries(root) {
  const manifestEntries = await readArtifactManifest(root);
  if (manifestEntries?.length) return manifestEntries;
  return (await listArtifactFiles(root))
    .filter((filePath) => basename(filePath) !== "artifact-manifest.json")
    .map((localPath) => ({ localPath, name: basename(localPath) }));
}

async function publishStaticWebArtifacts({ artifactId, artifactDir, requestId, sessionId }) {
  if (!staticWebPublishingEnabled()) return [];

  const containerClient = await getArtifactContainerClient();
  const entries = await collectArtifactEntries(artifactDir);
  if (!entries.length) return [];

  let totalBytes = 0;
  const artifacts = [];
  const endpoint = artifactStaticWebEndpoint.replace(/\/+$/, "");
  const root = resolve(artifactDir);

  for (const entry of entries) {
    const fileStat = await stat(entry.localPath);
    if (!fileStat.isFile()) continue;
    totalBytes += fileStat.size;
    if (totalBytes > artifactMaxPublishBytes) {
      throw new HttpError(413, `artifact publish size exceeds ${artifactMaxPublishBytes} bytes`);
    }

    const relativePath = relative(root, entry.localPath).split(sep).join("/");
    const blobName = posix.join(artifactBlobPrefix, artifactId, relativePath);
    const contentType = entry.contentType ?? contentTypeForPath(entry.localPath);
    await containerClient.getBlockBlobClient(blobName).uploadFile(entry.localPath, {
      blobHTTPHeaders: { blobContentType: contentType },
    });

    artifacts.push({
      name: entry.name ?? basename(entry.localPath),
      description: entry.description,
      path: relativePath,
      contentType,
      size: fileStat.size,
      url: `${endpoint}/${encodeStaticWebPath(blobName)}`,
    });
  }

  log("info", "artifacts_published", {
    requestId,
    sessionId,
    artifactId,
    count: artifacts.length,
    totalBytes,
    mode: artifactPublishMode,
  });
  return artifacts;
}

function appendArtifactLinks(output, artifacts) {
  if (!artifacts?.length) return output;
  const links = artifacts.map((artifact) => `- [${artifact.name}](${artifact.url})`).join("\n");
  return `${output.trimEnd()}\n\nArtifacts:\n\n${links}`;
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

function removeArgWithValue(args, name) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

function buildPiArgs(sessionDir) {
  let args = piArgs.filter((arg) => arg !== "--no-session" && arg !== "--continue" && arg !== "-c");
  args = removeArgWithValue(args, "--session-dir");
  return [...args, "--continue", "--session-dir", sessionDir];
}

function extractTextContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function extractFallbackTextFromAgentEnd(event) {
  if (!Array.isArray(event.messages)) return "";

  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index];
    if (message?.role !== "assistant") continue;
    const text = extractTextContent(message.content).trim();
    if (text.length > 0) return text;
  }

  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index];
    if (message?.role !== "toolResult") continue;
    const text = extractTextContent(message.content).trim();
    if (text.length > 0) return text;
  }

  return "";
}

function extractAgentEndError(event) {
  if (!Array.isArray(event.messages)) return undefined;
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index];
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "error" && typeof message.errorMessage === "string") {
      return message.errorMessage;
    }
  }
  return undefined;
}

async function runPiPrompt(prompt, options) {
  if (mock) {
    return {
      text: `mock response: ${prompt}`,
      events: [],
      sessionId: options.sessionId,
      mock: true,
      piExitCode: undefined,
    };
  }

  const id = randomUUID();
  const args = buildPiArgs(options.piSessionDir);
  const child = spawn(piBin, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: piAgentDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderr = "";
  let text = "";
  const events = [];
  let promptAccepted = false;
  let settled = false;
  let piExitCode;

  return new Promise((resolveResult, reject) => {
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill("SIGTERM");
      if (error) reject(error);
      else resolveResult(result);
    };

    const timer = setTimeout(() => {
      finish(new HttpError(504, `pi request timed out after ${requestTimeoutMs}ms`, { stderr }));
    }, requestTimeoutMs);

    child.on("error", (error) => {
      finish(new HttpError(502, `failed to start pi: ${error.message}`));
    });

    child.on("close", (code) => {
      piExitCode = code ?? undefined;
      if (!settled && code !== 0) {
        finish(new HttpError(502, `pi exited with code ${code}`, { stderr }));
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        handleRpcLine(line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    function writeRpc(payload) {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    function handleRpcLine(line) {
      if (line.trim().length === 0) return;

      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        finish(new HttpError(502, `Failed to parse pi RPC output: ${error.message}`, { line, stderr }));
        return;
      }

      events.push(event);

      if (event.type === "response" && event.id === id) {
        promptAccepted = event.success === true;
        if (!event.success) {
          finish(new HttpError(502, event.error ?? "pi rejected prompt", { stderr }));
        }
        return;
      }

      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          text += update.delta;
          options.onTextDelta?.(update.delta);
        }
        if (update?.type === "error") {
          finish(new HttpError(502, update.error ?? update.reason ?? "pi stream error", { stderr }));
        }
        return;
      }

      if (event.type === "extension_ui_request" && event.id) {
        writeRpc({ type: "extension_ui_response", id: event.id, cancelled: true });
        return;
      }

      if (event.type === "agent_end") {
        const agentError = extractAgentEndError(event);
        if (agentError) {
          finish(new HttpError(502, agentError, { stderr }));
          return;
        }

        finish(undefined, {
          text: text.length > 0 ? text : extractFallbackTextFromAgentEnd(event),
          events,
          promptAccepted,
          sessionId: options.sessionId,
          mock: false,
          piExitCode,
        });
      }
    }

    writeRpc({ id, type: "prompt", message: prompt });
  });
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
    const effectivePrompt = withArtifactPromptHint(prompt, artifactDir);
    const result = await runPiPrompt(effectivePrompt, { requestId, sessionId, cwd, piSessionDir, onTextDelta });
    const latencyMs = Date.now() - started;
    let artifacts = [];
    let output = result.text;
    try {
      artifacts = await publishStaticWebArtifacts({ artifactId, artifactDir, requestId, sessionId });
      output = appendArtifactLinks(output, artifacts);
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

async function loadJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function configureFoundryOpenAIProvider() {
  if (!process.env.PI_OPENAI_API_KEY && !process.env.FOUNDRY_OPENAI_API_KEY) return;

  const modelsPath = resolve(piAgentDir, "models.json");
  const config = await loadJsonFile(modelsPath);
  const providers = config.providers && typeof config.providers === "object" ? config.providers : {};
  providers.foundry = {
    baseUrl: foundryOpenAIBaseUrl,
    api: "openai-responses",
    apiKey: process.env.PI_OPENAI_API_KEY ? "PI_OPENAI_API_KEY" : "FOUNDRY_OPENAI_API_KEY",
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
  log("info", "foundry_openai_provider_configured", {
    provider: "foundry",
    model: foundryOpenAIModel,
    baseUrl: foundryOpenAIBaseUrl,
    modelsPath,
  });
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
await configureFoundryOpenAIProvider();

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
          enabled: staticWebPublishingEnabled(),
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
      const artifactPath = resolveArtifactPath(url.pathname);
      await sendArtifactFile(res, artifactPath);
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
