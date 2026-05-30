#!/usr/bin/env node
// Managed by the pi-foundry skill.
// This deploy-time adapter script is copied from the pi-foundry skill adapter bundle.
// Do not edit directly unless debugging the adapter.
// To update, run the pi-foundry skill migration flow.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";

function command(commandName, commandArgs, options = {}) {
  return execFileSync(commandName, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 120000,
    env: process.env,
  }).trim();
}

function parseEnvValues(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function parseToken(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  const json = JSON.parse(trimmed);
  return json.token ?? json.accessToken;
}

async function armFetch(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? text ?? response.statusText;
    const code = body?.error?.code ? `${body.error.code}: ` : "";
    throw new Error(`ARM ${response.status} ${response.statusText}: ${code}${message}`);
  }
  return body;
}

function roleAssignmentGuid(scope, roleDefinitionId, principalId) {
  const hash = createHash("sha256").update(`${scope}|${roleDefinitionId}|${principalId}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readConfiguredAgentName() {
  try {
    const text = readFileSync(".azd/pi-foundry/pi-foundry.yaml", "utf8");
    return text.match(/^\s*name:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  } catch {
    return undefined;
  }
}

function findAgentOutputs(values, expectedName) {
  const entries = Object.entries(values).filter(([key, value]) => key.startsWith("AGENT_") && key.endsWith("_NAME") && (!expectedName || value === expectedName));
  const nameEntry = entries[0] ?? Object.entries(values).find(([key]) => key.startsWith("AGENT_") && key.endsWith("_NAME"));
  if (!nameEntry) return {};
  const prefix = nameEntry[0].slice(0, -"_NAME".length);
  return {
    name: nameEntry[1],
    version: values[`${prefix}_VERSION`],
    endpoint: values[`${prefix}_INVOCATIONS_ENDPOINT`],
  };
}

function collectAgentPrincipals(agent) {
  const principals = [];
  if (agent.instance_identity?.principal_id) principals.push({ label: "instance_identity", principalId: agent.instance_identity.principal_id });
  if (agent.blueprint?.principal_id) principals.push({ label: "blueprint", principalId: agent.blueprint.principal_id });
  const seen = new Set();
  return principals.filter((entry) => {
    if (seen.has(entry.principalId)) return false;
    seen.add(entry.principalId);
    return true;
  });
}

async function findStorageAccountResourceId({ token, subscriptionId, storageAccount }) {
  const filter = encodeURIComponent("resourceType eq 'Microsoft.Storage/storageAccounts'");
  const url = `https://management.azure.com/subscriptions/${subscriptionId}/resources?api-version=2021-04-01&$filter=${filter}`;
  const resources = await armFetch(token, url);
  const match = resources.value?.find((resource) => resource.name === storageAccount);
  if (!match?.id) throw new Error(`Storage account not found in subscription ${subscriptionId}: ${storageAccount}`);
  return match.id;
}

async function grantRole({ token, scope, principalId, label }) {
  const roleDefinitionId = `${scope}/providers/Microsoft.Authorization/roleDefinitions/${STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID}`;
  const assignmentId = roleAssignmentGuid(scope, roleDefinitionId, principalId);
  const url = `https://management.azure.com${scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentId}?api-version=2022-04-01`;
  try {
    await armFetch(token, url, {
      method: "PUT",
      body: JSON.stringify({ properties: { roleDefinitionId, principalId, principalType: "ServicePrincipal" } }),
    });
    console.log(`✓ artifact RBAC granted to ${label} (${principalId})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("RoleAssignmentExists")) {
      console.log(`✓ artifact RBAC already exists for ${label} (${principalId})`);
      return;
    }
    throw error;
  }
}

async function maybeGrantArtifactRbac(values, outputs) {
  if (values.ARTIFACT_PUBLISH_MODE !== "static-web") {
    console.log("pi-foundry: artifact publishing is not static-web; skipping artifact RBAC.");
    return;
  }
  if (!values.ARTIFACT_STORAGE_ACCOUNT) {
    console.log("pi-foundry: ARTIFACT_STORAGE_ACCOUNT is not set; skipping artifact RBAC.");
    return;
  }
  if (!outputs.name) {
    console.log("pi-foundry: could not infer deployed agent name from azd env outputs; skipping artifact RBAC.");
    return;
  }

  const subscriptionId = values.AZURE_SUBSCRIPTION_ID;
  const tenantId = values.AZURE_TENANT_ID;
  if (!subscriptionId || !tenantId) {
    console.log("pi-foundry: AZURE_SUBSCRIPTION_ID/AZURE_TENANT_ID missing; skipping artifact RBAC.");
    return;
  }

  const agent = JSON.parse(command("azd", ["ai", "agent", "show", outputs.name, "--output", "json", "--no-prompt"]));
  const principals = collectAgentPrincipals(agent);
  if (principals.length === 0) {
    console.log(`pi-foundry: no managed identities found for ${outputs.name}; skipping artifact RBAC.`);
    return;
  }

  const token = parseToken(command("azd", ["auth", "token", "--scope", "https://management.azure.com/.default", "--tenant-id", tenantId]));
  const scope = await findStorageAccountResourceId({ token, subscriptionId, storageAccount: values.ARTIFACT_STORAGE_ACCOUNT });
  for (const principal of principals) await grantRole({ token, scope, principalId: principal.principalId, label: principal.label });
}

async function main() {
  console.log("pi-foundry postdeploy");
  const values = parseEnvValues(command("azd", ["env", "get-values"]));
  const outputs = findAgentOutputs(values, readConfiguredAgentName());

  if (outputs.name) console.log(`Agent:   ${outputs.name}`);
  if (outputs.version) console.log(`Version: ${outputs.version}`);
  if (outputs.endpoint) console.log(`Endpoint: ${outputs.endpoint}`);

  try {
    await maybeGrantArtifactRbac(values, outputs);
  } catch (error) {
    console.log(`pi-foundry: warning: artifact RBAC automation failed: ${error instanceof Error ? error.message : String(error)}`);
    console.log("pi-foundry: deployment is still complete. Grant artifact RBAC manually if artifact publishing fails.");
  }

  if (outputs.name && outputs.version) {
    console.log("Try:");
    console.log(`  azd ai agent invoke ${outputs.name} --protocol invocations --version ${outputs.version} --new-session --timeout 900 'Say exactly: ok'`);
  }
}

main().catch((error) => {
  console.log(`pi-foundry: warning: postdeploy failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 0;
});
