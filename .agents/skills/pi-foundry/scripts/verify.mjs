#!/usr/bin/env node
// verify.mjs — smoke test a deployed Hosted Agent over the invocations protocol.
//
// Why not `azd ai agent invoke`? As of the azure.ai.agents preview, Hosted Agent
// session creation requires the opt-in header `Foundry-Features: HostedAgents=V1Preview`,
// which the CLI does not send (you get HTTP 403 preview_feature_required). So this script
// talks to the REST endpoint directly: it mints a data-plane token with `azd auth token`,
// creates a session, then POSTs the invocation — sending the preview header on both calls.
//
// Usage:
//   verify.mjs [--agent <name>] [--message <text>] [--session <id>]
//              [--scope <aad-scope>] [--preview <feature-flag>] [--timeout <seconds>]
//
// Prints the session id (stderr) so you can chain a second call for continuity:
//   SID=$(verify.mjs --message 'Remember the word mango. Reply: stored' 2>&1 >/dev/null | sed -n 's/^session: //p')
//   verify.mjs --session "$SID" --message 'What word did I tell you? Reply with just the word.'

import { readFileSync } from "node:fs";
import { azdEnvValues, installCrashHandlers, parseArgs, run } from "./_lib.mjs";

installCrashHandlers();

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.error("Usage: verify.mjs [--agent <name>] [--message <text>] [--session <id>] [--scope <scope>] [--preview <flag>] [--timeout <seconds>]");
  process.exit(0);
}

const env = azdEnvValues();
const expectedName = readAgentNameFromYaml();
const agent = args.agent ?? expectedName ?? findAgentName(env);
if (!agent) throw new Error("agent name not provided and none found in agent.yaml or azd env");

const endpoint = invocationsEndpoint(env, agent);
const base = endpoint.replace(/\/protocols\/invocations.*$/, "");
const apiVersion = new URL(endpoint).searchParams.get("api-version") ?? "v1";
const scope = args.scope ?? "https://ai.azure.com/.default";
const preview = args.preview ?? "HostedAgents=V1Preview";
const message = args.message ?? "Say exactly: ok";
const timeoutMs = Number(args.timeout ?? "900") * 1000;

const token = azdToken(scope);
const headers = {
  Authorization: `Bearer ${token}`,
  "Foundry-Features": preview,
  "Content-Type": "application/json",
};

const sessionId = args.session ?? (await createSession());
console.error(`session: ${sessionId}`);

const url = `${base}/protocols/invocations?api-version=${apiVersion}&agent_session_id=${encodeURIComponent(sessionId)}`;
const response = await fetchJson(url, { method: "POST", headers, body: JSON.stringify({ input: message }) });
console.log(typeof response === "string" ? response : JSON.stringify(response, null, 2));

// ---------------------------------------------------------------------------

async function createSession() {
  const url = `${base}/sessions?api-version=${apiVersion}`;
  const body = await fetchJson(url, { method: "POST", headers, body: "{}" });
  const id = body?.agent_session_id;
  if (!id) throw new Error(`session creation returned no agent_session_id: ${JSON.stringify(body)}`);
  return id;
}

async function fetchJson(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${init.method} ${url}\n${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text; // SSE or non-JSON body
  }
}

function azdToken(scope) {
  const out = run("azd", ["auth", "token", "--scope", scope, "--output", "json"], { stdio: ["ignore", "pipe", "inherit"] });
  const token = JSON.parse(out).token;
  if (!token) throw new Error(`azd auth token returned no token for scope ${scope}`);
  return token;
}

function invocationsEndpoint(values, agentName) {
  const entry = Object.entries(values).find(([key]) => key.startsWith("AGENT_") && key.endsWith("_INVOCATIONS_ENDPOINT"));
  if (entry) return entry[1];
  const project = values.FOUNDRY_PROJECT_ENDPOINT?.replace(/\/$/, "");
  if (!project) throw new Error("no AGENT_*_INVOCATIONS_ENDPOINT or FOUNDRY_PROJECT_ENDPOINT in azd env; run `azd deploy` first");
  return `${project}/agents/${agentName}/endpoint/protocols/invocations?api-version=v1`;
}

function readAgentNameFromYaml() {
  try {
    return readFileSync("agent.yaml", "utf8").match(/^\s*name:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  } catch {
    return undefined;
  }
}

function findAgentName(values) {
  return Object.entries(values).find(([key]) => key.startsWith("AGENT_") && key.endsWith("_NAME"))?.[1];
}
