#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const endpoint = process.env.FOUNDRY_INVOCATIONS_ENDPOINT;
const tenantId = process.env.FOUNDRY_TENANT_ID ?? process.env.AZURE_TENANT_ID;
const tokenScope = process.env.FOUNDRY_TOKEN_SCOPE ?? "https://ai.azure.com/.default";
const tokenCommandCwd = process.env.FOUNDRY_TOKEN_COMMAND_CWD;
const modelId = process.env.FOUNDRY_MODEL ?? "gpt-5.4-mini";
const providerName = process.env.FOUNDRY_PROVIDER_NAME ?? "foundry";
const sessionId = argValue("--session") ?? process.env.FOUNDRY_AGENT_SESSION_ID ?? `paseo-${randomUUID()}`;

if (!endpoint) {
  console.error("FOUNDRY_INVOCATIONS_ENDPOINT is required");
  process.exit(2);
}

let thinkingLevel = "medium";
let model = {
  provider: providerName,
  id: modelId,
  name: process.env.FOUNDRY_MODEL_LABEL ?? `Foundry ${modelId}`,
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 16384,
};

const userEntries = [];
const messages = [];
let isStreaming = false;
let agentStarted = false;
let tokenCache = null;
let tokenExpiresAt = 0;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function respond(command, success = true, data = undefined, error = undefined) {
  write({ id: command.id, type: "response", command: command.type, success, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
}

function getState() {
  return {
    model,
    thinkingLevel,
    isStreaming,
    isCompacting: false,
    sessionId,
    sessionName: "Foundry pi-foundry",
    messageCount: messages.length,
    pendingMessageCount: 0,
  };
}

function getToken() {
  const now = Date.now();
  if (process.env.FOUNDRY_BEARER_TOKEN) return process.env.FOUNDRY_BEARER_TOKEN;
  if (tokenCache && now < tokenExpiresAt - 60_000) return tokenCache;

  const args = ["auth", "token", "--scope", tokenScope];
  if (tenantId) args.push("--tenant-id", tenantId);
  const result = spawnSync("azd", args, {
    cwd: tokenCommandCwd || process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`azd auth token failed: ${result.stderr || result.stdout}`.trim());
  }
  tokenCache = result.stdout.trim();
  // azd prints a raw JWT. Keep a conservative cache TTL.
  tokenExpiresAt = now + 30 * 60 * 1000;
  return tokenCache;
}

function appendQuery(url, params) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

function promptText(command) {
  return typeof command.message === "string" ? command.message : "";
}

function parseCapturePrompt(text) {
  const match = /^\/paseo_capture_entries\s+([A-Za-z0-9_-]+)\s*$/.exec(text.trim());
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function parseTreePrompt(text) {
  const match = /^\/paseo_tree\s+([A-Za-z0-9_-]+)\s*$/.exec(text.trim());
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function emitEntryCapture(reason, requestId) {
  write({
    type: "extension_ui_request",
    id: `notify-${randomUUID()}`,
    method: "notify",
    message:
      "PASEO_ENTRY_CAPTURE " +
      JSON.stringify({
        reason,
        requestId,
        entries: userEntries,
      }),
    level: "info",
  });
}

function formatArtifactLinks(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return "";
  return `\n\nArtifacts:\n\n${artifacts
    .filter((artifact) => artifact && typeof artifact.url === "string")
    .map((artifact) => `- [${artifact.name ?? artifact.path ?? "artifact"}](${artifact.url})`)
    .join("\n")}`;
}

function emitCommandResult(requestId, result) {
  write({
    type: "extension_ui_request",
    id: `notify-${randomUUID()}`,
    method: "notify",
    message: "PASEO_COMMAND_RESULT " + JSON.stringify({ requestId, ...result }),
    level: result.ok ? "info" : "error",
  });
}

async function invokeFoundry(text, command) {
  if (!agentStarted) {
    agentStarted = true;
    write({ type: "agent_start" });
    emitEntryCapture("session_start");
  }

  const userEntry = {
    id: `user-${randomUUID()}`,
    parentId: userEntries.at(-1)?.id ?? null,
    text,
  };
  userEntries.push(userEntry);
  const userMessage = { role: "user", content: text };
  messages.push(userMessage);

  isStreaming = true;
  let assistantText = "";
  const assistantMessage = { role: "assistant", content: [], provider: providerName, model: model.id };

  write({ type: "turn_start" });
  write({ type: "message_end", message: userMessage });
  write({ type: "message_start", message: assistantMessage });
  respond(command, true);

  try {
    const url = appendQuery(endpoint, {
      agent_session_id: sessionId,
      stream: "true",
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${getToken()}`,
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: text }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Foundry invocation failed: ${response.status} ${body}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice("data:".length).trim();
          if (!raw || raw === "[DONE]") continue;
          const event = JSON.parse(raw);
          if (event.type === "token" && typeof event.content === "string") {
            assistantText += event.content;
            write({
              type: "message_update",
              message: assistantMessage,
              assistantMessageEvent: { type: "text_delta", delta: event.content },
            });
          } else if (event.type === "done") {
            if (typeof event.full_text === "string" && !assistantText) assistantText = event.full_text;
            const artifactLinks = formatArtifactLinks(event.artifacts);
            if (artifactLinks && !assistantText.includes(artifactLinks.trim())) {
              assistantText += artifactLinks;
              write({
                type: "message_update",
                message: assistantMessage,
                assistantMessageEvent: { type: "text_delta", delta: artifactLinks },
              });
            }
          }
        }
        sep = buffer.indexOf("\n\n");
      }
    }

    assistantMessage.content = [{ type: "text", text: assistantText }];
    messages.push(assistantMessage);
    write({ type: "message_end", message: assistantMessage });
    emitEntryCapture("turn_end");
    write({ type: "agent_end", messages: [...messages] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assistantMessage.errorMessage = message;
    assistantMessage.stopReason = "error";
    assistantMessage.content = [{ type: "text", text: message }];
    messages.push(assistantMessage);
    write({ type: "agent_end", messages: [...messages] });
  } finally {
    isStreaming = false;
  }
}

async function handle(command) {
  try {
    switch (command.type) {
      case "get_state":
        respond(command, true, getState());
        break;
      case "get_messages":
        respond(command, true, { messages });
        break;
      case "get_available_models":
        respond(command, true, { models: [model] });
        break;
      case "set_model":
        model = { ...model, provider: command.provider ?? providerName, id: command.modelId ?? model.id, name: command.modelId ?? model.name };
        respond(command, true, model);
        break;
      case "set_thinking_level":
        thinkingLevel = command.level ?? thinkingLevel;
        respond(command, true);
        break;
      case "get_session_stats":
        respond(command, true, {});
        break;
      case "get_commands":
        respond(command, true, {
          commands: [
            { name: "paseo_capture_entries", description: "Internal Paseo entry capture bridge", source: "extension" },
            { name: "paseo_tree", description: "Internal Paseo tree navigation bridge", source: "extension" },
          ],
        });
        break;
      case "abort":
        respond(command, true);
        break;
      case "prompt": {
        const text = promptText(command);
        const capture = parseCapturePrompt(text);
        if (capture) {
          emitEntryCapture(capture.reason ?? "command", capture.requestId);
          respond(command, true);
          break;
        }
        const tree = parseTreePrompt(text);
        if (tree) {
          emitEntryCapture("tree_navigation");
          emitCommandResult(tree.requestId, { ok: false, error: "Foundry shim does not support Pi tree rewind" });
          respond(command, true);
          break;
        }
        void invokeFoundry(text, command);
        break;
      }
      default:
        respond(command, false, undefined, `unsupported command: ${command.type}`);
    }
  } catch (error) {
    respond(command, false, undefined, error instanceof Error ? error.message : String(error));
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch (error) {
    console.error(`invalid JSON RPC line: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  void handle(command);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
