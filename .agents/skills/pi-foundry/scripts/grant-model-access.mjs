#!/usr/bin/env node
// grant-model-access.mjs — keyless (managed-identity) prerequisite.
//
// When PI_MODEL_AUTH=managed-identity, the Hosted Agent calls the model with its
// own Instance Identity instead of an API key. That identity needs a data-plane
// role on the model account, or invocations fail with 401/403. This script grants
// `Cognitive Services OpenAI User` to the agent's Instance Identity on the model
// account, via ARM REST (no `az` CLI required — it reuses `azd auth token`).
//
// It is idempotent: an already-existing assignment is treated as success.
//
// Usage:
//   grant-model-access.mjs [--agent <name>] [--principal-id <guid>]
//                          [--scope <account-arm-id>] [--role-id <guid>] [--dry-run]
//
// Defaults (all overridable):
//   --agent        from agent.yaml `name:` or azd env AGENT_*_NAME
//   --principal-id from `azd ai agent show <agent>` "Instance Identity Principal ID"
//   --scope        AZURE_AI_PROJECT_ID with the trailing /projects/<project> stripped
//   --role-id      5e0bd9bd-7b93-4f28-af87-19fc36ad61bd (Cognitive Services OpenAI User)

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { azdEnvValues, installCrashHandlers, parseArgs, run, tryRun } from "./_lib.mjs";

installCrashHandlers();

const OPENAI_USER_ROLE_ID = "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd";

const args = parseArgs(process.argv.slice(2), { flags: ["dry-run"] });
if (args.help) {
  console.error("Usage: grant-model-access.mjs [--agent <name>] [--principal-id <guid>] [--scope <account-arm-id>] [--role-id <guid>] [--dry-run]");
  process.exit(0);
}

const env = azdEnvValues();
const agent = args.agent ?? readAgentNameFromYaml() ?? findAgentName(env);

const scope = args.scope ?? accountScope(env);
if (!scope) throw new Error("model account scope not found; pass --scope <account-arm-id> or set AZURE_AI_PROJECT_ID via configure-env.mjs");

const subscription = scope.match(/\/subscriptions\/([^/]+)/)?.[1];
if (!subscription) throw new Error(`--scope is not a valid ARM resource id: ${scope}`);

const principalId = args["principal-id"] ?? resolvePrincipalId(agent);
if (!principalId) throw new Error("Instance Identity Principal ID not found; pass --principal-id, or deploy the agent first (`azd deploy`)");

const roleId = args["role-id"] ?? OPENAI_USER_ROLE_ID;
const roleDefinitionId = `/subscriptions/${subscription}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`;

console.error(`principal: ${principalId}`);
console.error(`role:      ${roleId} (Cognitive Services OpenAI User)`);
console.error(`scope:     ${scope}`);

if (args["dry-run"]) {
  console.log("dry-run: no role assignment created");
  process.exit(0);
}

const assignmentId = randomUUID();
const url = `https://management.azure.com${scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentId}?api-version=2022-04-01`;
const token = azdToken("https://management.azure.com/.default");

const res = await fetch(url, {
  method: "PUT",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    properties: { roleDefinitionId, principalId, principalType: "ServicePrincipal" },
  }),
});
const text = await res.text();

if (res.ok) {
  console.log("granted: Cognitive Services OpenAI User");
} else if (res.status === 409 || /RoleAssignmentExists/.test(text)) {
  console.log("already granted: Cognitive Services OpenAI User (no change)");
} else {
  throw new Error(`HTTP ${res.status} PUT roleAssignments\n${text}`);
}

// ---------------------------------------------------------------------------

function accountScope(values) {
  const projectId = values.AZURE_AI_PROJECT_ID;
  if (!projectId) return undefined;
  return projectId.replace(/\/projects\/[^/]+$/, "");
}

function resolvePrincipalId(agentName) {
  if (!agentName) return undefined;
  const out = tryRun("azd", ["ai", "agent", "show", agentName, "--no-prompt"]);
  if (!out) return undefined;
  return out.match(/Instance Identity Principal ID\s+([0-9a-fA-F-]{36})/)?.[1];
}

function azdToken(scope) {
  const out = run("azd", ["auth", "token", "--scope", scope, "--output", "json"], { stdio: ["ignore", "pipe", "inherit"] });
  const token = JSON.parse(out).token;
  if (!token) throw new Error(`azd auth token returned no token for scope ${scope}`);
  return token;
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
