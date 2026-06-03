#!/usr/bin/env node
// configure-env.mjs — set azd env values for a pi-foundry deployment.
//
// Never prints secret values. Reads secrets only from process env or a dotenv file;
// never accepts secrets as command-line args. Knows the env contract from
// references/contract.json so additions to the contract automatically propagate.
//
// Usage:
//   configure-env.mjs --agent-name <name> [options]
//
// Options:
//   --env-name <name>                        Create/select azd env if needed.
//   --from-env-file <path>                   Whitelisted copy from a dotenv file (no AGENT_*).
//   --agent-name <name>                      (required) Agent name.
//   --acr <registry.azurecr.io>
//   --foundry-project-endpoint <url>
//   --azure-ai-project-id <resource-id>
//   --azure-subscription-id <id>
//   --azure-tenant-id <id>
//   --azure-location <region>
//   --model <model>                          Sets PI_OPENAI_MODEL and reconstructs PI_ARGS.
//   --base-url <url>                         Sets PI_OPENAI_BASE_URL.
//   --api-key-env <ENV_VAR_NAME>             Reads PI_OPENAI_API_KEY from process env (never via flag).
//   --model-auth <apikey|managed-identity>   Sets PI_MODEL_AUTH. Default apikey. managed-identity is keyless
//                                            (DefaultAzureCredential); no api key required.
//   --mock <0|1>                             Default 0.
//   --timeout-ms <ms>                        Default 600000.

import { installCrashHandlers, loadContract, parseArgs, parseDotenv, run, tryRun, isSecretName } from "./_lib.mjs";
import { readFileSync } from "node:fs";

installCrashHandlers();

const args = parseArgs(process.argv.slice(2));

if (args.help || !args["agent-name"]) {
  console.error(`Usage: configure-env.mjs --agent-name <name> [options]
See script header for the option list.`);
  process.exit(args.help ? 0 : 2);
}

const contract = await loadContract();
const fileValues = args["from-env-file"] ? parseDotenv(readFileSync(args["from-env-file"], "utf8")) : {};

if (args["env-name"]) {
  if (tryRun("azd", ["env", "select", args["env-name"]]) === undefined) {
    run("azd", ["env", "new", args["env-name"]]);
  }
}

// Validate --from-env-file does not carry over reserved or source-agent state.
if (args["from-env-file"]) {
  const blocked = Object.keys(fileValues).filter((name) =>
    contract.env.reservedPrefixes.some((prefix) => name.startsWith(prefix)) &&
    !contract.env.reservedAllowedExceptions.includes(name),
  );
  for (const name of blocked) {
    console.log(`skipping reserved variable from env file: ${name}`);
    delete fileValues[name];
  }
}

// azd-required infra values
const subscriptionId = prefer(args["azure-subscription-id"], fileValues.AZURE_SUBSCRIPTION_ID);
const foundryEndpoint = prefer(args["foundry-project-endpoint"], fileValues.FOUNDRY_PROJECT_ENDPOINT);
let tenantId = prefer(args["azure-tenant-id"], fileValues.AZURE_TENANT_ID);
let projectId = prefer(args["azure-ai-project-id"], fileValues.AZURE_AI_PROJECT_ID);

// AZURE_TENANT_ID and AZURE_AI_PROJECT_ID are both required by `azd deploy` but are awkward
// to look up by hand, so derive them from the subscription + Foundry endpoint when missing.
if (subscriptionId && (!tenantId || !projectId)) {
  if (!tenantId) tenantId = await deriveTenantId(subscriptionId);
  if (!projectId && foundryEndpoint) projectId = await deriveProjectId(subscriptionId, foundryEndpoint);
}

azdSet("AZURE_SUBSCRIPTION_ID", subscriptionId);
azdSet("AZURE_TENANT_ID", tenantId);
azdSet("AZURE_LOCATION", prefer(args["azure-location"], fileValues.AZURE_LOCATION));
azdSet("FOUNDRY_PROJECT_ENDPOINT", foundryEndpoint);
azdSet("AZURE_AI_PROJECT_ID", projectId);
azdSet("AZURE_CONTAINER_REGISTRY_ENDPOINT", prefer(args.acr, fileValues.AZURE_CONTAINER_REGISTRY_ENDPOINT));

// Runtime base
azdSet("PI_MOCK", prefer(args.mock, fileValues.PI_MOCK, "0"));
azdSet("REQUEST_TIMEOUT_MS", prefer(args["timeout-ms"], fileValues.REQUEST_TIMEOUT_MS, "600000"));
azdSet("ENABLE_DIAGNOSTICS", prefer(fileValues.ENABLE_DIAGNOSTICS, "0"));

// The harness (pi vs copilot) is fixed by the runtime image, so it is not an azd env knob.
// Copilot's apikey-only BYOK constraint is enforced by the runtime contract at startup.

// Model
const model = prefer(args.model, fileValues.PI_OPENAI_MODEL);
if (model) {
  azdSet("PI_OPENAI_MODEL", model);
  azdSet("PI_ARGS", prefer(fileValues.PI_ARGS, `--mode rpc --no-session --provider foundry --model ${model}`));
}
azdSet("PI_OPENAI_BASE_URL", prefer(args["base-url"], fileValues.PI_OPENAI_BASE_URL));

// Model auth mode: apikey (default, BYOK) or managed-identity (keyless). Validated against
// the contract so accepted values stay in sync with the runtime.
const modelAuth = prefer(args["model-auth"], fileValues.PI_MODEL_AUTH);
if (modelAuth) {
  const spec = contract.env.runtime.find((knob) => knob.name === "PI_MODEL_AUTH");
  const accepts = spec?.accepts ?? ["apikey", "managed-identity"];
  if (!accepts.includes(modelAuth)) {
    throw new Error(`Invalid --model-auth '${modelAuth}'; expected one of: ${accepts.join(", ")}`);
  }
  azdSet("PI_MODEL_AUTH", modelAuth);
}

const keyless = modelAuth === "managed-identity";
if (args["api-key-env"]) {
  const secret = process.env[args["api-key-env"]];
  if (!secret) throw new Error(`Environment variable ${args["api-key-env"]} is not set`);
  azdSet("PI_OPENAI_API_KEY", secret);
} else if (fileValues.PI_OPENAI_API_KEY) {
  azdSet("PI_OPENAI_API_KEY", fileValues.PI_OPENAI_API_KEY);
} else if (!keyless) {
  console.log("note: no PI_OPENAI_API_KEY provided; set one via --api-key-env, or use --model-auth managed-identity for keyless auth.");
}

console.log("");
console.log("azd env configuration complete.");

// Preflight: `azd deploy` fails cryptically without these two. Surface it now, not at deploy time.
const missingForDeploy = [
  !projectId && "AZURE_AI_PROJECT_ID (pass --azure-ai-project-id, or --azure-subscription-id + --foundry-project-endpoint to derive it)",
  !tenantId && "AZURE_TENANT_ID (pass --azure-tenant-id, or --azure-subscription-id to derive it)",
].filter(Boolean);
if (missingForDeploy.length) {
  console.log("");
  console.log("WARNING: `azd deploy` will fail until these are set:");
  for (const item of missingForDeploy) console.log(`  - ${item}`);
}

// ---------------------------------------------------------------------------

function prefer(...values) {
  return values.find((value) => value !== undefined && value !== "");
}

// Mint an ARM token via azd (already authenticated) and GET a management resource.
async function armGet(path) {
  const out = run("azd", ["auth", "token", "--scope", "https://management.azure.com/.default", "--output", "json"], { quiet: true });
  const token = JSON.parse(out).token;
  const res = await fetch(`https://management.azure.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`ARM GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function deriveTenantId(subscriptionId) {
  try {
    const body = await armGet(`/subscriptions/${subscriptionId}?api-version=2022-12-01`);
    return body.tenantId;
  } catch (error) {
    console.log(`note: could not derive AZURE_TENANT_ID (${error.message}); pass --azure-tenant-id if azd deploy fails.`);
    return undefined;
  }
}

// Foundry endpoint looks like https://<account>.services.ai.azure.com/api/projects/<project>.
// Resolve the account's ARM id by name, then append /projects/<project>.
async function deriveProjectId(subscriptionId, endpoint) {
  try {
    const url = new URL(endpoint);
    const account = url.hostname.split(".")[0];
    const project = url.pathname.match(/\/projects\/([^/]+)/)?.[1];
    if (!account || !project) throw new Error("endpoint not in <account>.services.ai.azure.com/api/projects/<project> form");
    const list = await armGet(`/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/accounts?api-version=2025-04-01-preview`);
    const match = (list.value ?? []).find((a) => a.name === account);
    if (!match) throw new Error(`CognitiveServices account '${account}' not found in subscription`);
    return `${match.id}/projects/${project}`;
  } catch (error) {
    console.log(`note: could not derive AZURE_AI_PROJECT_ID (${error.message}); pass --azure-ai-project-id if azd deploy fails.`);
    return undefined;
  }
}

function azdSet(name, value) {
  if (value === undefined || value === "") return;
  // KEY=value form prevents azd from parsing values that begin with -- (e.g. PI_ARGS)
  // or contain shell-sensitive characters (e.g. $web).
  run("azd", ["env", "set", `${name}=${String(value)}`], { quiet: true });
  console.log(`set ${name}${isSecretName(name) ? "=<redacted>" : `=${value}`}`);
}
