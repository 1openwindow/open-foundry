// pi-foundry runtime image contract — single source of truth.
//
// This file is consumed in three places:
//   1. src/backend.mjs           validates env at startup, fails fast on missing required vars.
//   2. src/cli.mjs               exposes `pi-foundry contract` and `pi-foundry doctor`.
//   3. .agents/skills/pi-foundry/references/contract.json
//                                regenerated from this file by scripts/emit-contract.mjs.
//
// Edit here; then run `node scripts/emit-contract.mjs` to refresh the skill JSON.

export const contract = {
  schemaVersion: "1.0.0",
  runtime: {
    workspace: "/workspace",
    ports: { external: 8088 },
    startupCommand: "node /app/src/backend.mjs",
  },
  resourceTiers: [
    { cpu: "0.25", memory: "0.5Gi" },
    { cpu: "0.5", memory: "1Gi" },
    { cpu: "1", memory: "2Gi" },
    { cpu: "2", memory: "4Gi" },
  ],
  env: {
    reservedPrefixes: ["AGENT_", "FOUNDRY_"],
    reservedAllowedExceptions: ["FOUNDRY_PROJECT_ENDPOINT"],
    // azd / Foundry resource plumbing — required by the deployment, not by the runtime.
    requiredFromAzd: [
      "AZURE_SUBSCRIPTION_ID",
      "AZURE_TENANT_ID",
      "AZURE_LOCATION",
      "FOUNDRY_PROJECT_ENDPOINT",
      "AZURE_CONTAINER_REGISTRY_ENDPOINT",
    ],
    // Required inside the runtime container, unless PI_MOCK=1.
    // PI_OPENAI_API_KEY is only required in apikey auth mode; PI_MODEL_AUTH=managed-identity
    // mints AAD tokens via DefaultAzureCredential instead of a static key.
    requiredWhenLive: ["PI_OPENAI_API_KEY", "PI_OPENAI_BASE_URL", "PI_OPENAI_MODEL"],
    requiredWhenLiveKeyless: ["PI_OPENAI_BASE_URL", "PI_OPENAI_MODEL"],
    // Optional runtime knobs with their defaults / accepted shapes.
    runtime: [
      { name: "HARNESS", default: "pi", accepts: ["pi", "copilot"], note: "Agent harness. copilot drives GitHub Copilot via @github/copilot-sdk and reaches the model through BYOK (apikey only)." },
      { name: "PI_ARGS", default: "--mode rpc --no-session", note: "Append --provider foundry --model <model> when using PI_OPENAI_*." },
      { name: "PI_MOCK", default: "0", accepts: ["0", "1", "true", "false"] },
      { name: "PI_MODEL_AUTH", default: "apikey", accepts: ["apikey", "managed-identity"], note: "managed-identity mints AAD bearer tokens via DefaultAzureCredential; no PI_OPENAI_API_KEY needed. Not supported with HARNESS=copilot." },
      { name: "FOUNDRY_TOKEN_SCOPE", default: "https://cognitiveservices.azure.com/.default", note: "AAD scope used when PI_MODEL_AUTH=managed-identity." },
      { name: "COPILOT_PROVIDER_TYPE", default: "(auto)", accepts: ["azure", "openai"], note: "HARNESS=copilot BYOK provider type. Auto-detected from PI_OPENAI_BASE_URL (azure when the host is *.azure.com)." },
      { name: "COPILOT_WIRE_API", default: "completions", accepts: ["responses", "completions"], note: "HARNESS=copilot BYOK wire API format." },
      { name: "COPILOT_API_VERSION", default: "2025-04-01-preview", note: "HARNESS=copilot Azure provider api-version." },
      { name: "REQUEST_TIMEOUT_MS", default: "300000" },
      { name: "SSE_HEARTBEAT_MS", default: "20000", note: "SSE keepalive interval; emits a `:` comment so Foundry's ~120s APIM idle timeout never fires during silent phases. 0 disables." },
      { name: "ENABLE_DIAGNOSTICS", default: "0", accepts: ["0", "1", "true", "false"] },
      { name: "WORKSPACE_DIR", default: "/workspace" },
      { name: "STATE_DIR", default: "${HOME}/.pi-foundry" },
      { name: "SESSIONS_DIR", default: "${STATE_DIR}/sessions" },
      { name: "PI_CODING_AGENT_DIR", default: "${STATE_DIR}/pi-agent", note: "Never defaults to ~/.pi/agent; that would clobber a developer's interactive pi config." },
    ],
  },
};

export function validateRuntimeEnv(env, { mock } = {}) {
  const issues = [];
  const harness = String(env.HARNESS ?? "").trim().toLowerCase() || "pi";
  if (harness !== "pi" && harness !== "copilot") {
    issues.push({ severity: "error", name: "HARNESS", message: `HARNESS must be one of pi, copilot (got "${harness}").` });
  }
  // Copilot reaches the model through BYOK, which is API-key only; there is no
  // keyless path, so reject managed-identity instead of failing at first call.
  if (harness === "copilot" && String(env.PI_MODEL_AUTH ?? "").trim().toLowerCase() === "managed-identity") {
    issues.push({ severity: "error", name: "PI_MODEL_AUTH", message: "HARNESS=copilot does not support PI_MODEL_AUTH=managed-identity; Copilot BYOK requires an API key (set PI_OPENAI_API_KEY)." });
  }
  // Validate Copilot knobs at startup so a typo fails fast here, not as an opaque
  // SDK error on the first invocation. Only enforced for the copilot harness.
  if (harness === "copilot") {
    for (const name of ["COPILOT_PROVIDER_TYPE", "COPILOT_WIRE_API"]) {
      const value = String(env[name] ?? "").trim().toLowerCase();
      if (!value) continue;
      const accepts = contract.env.runtime.find((knob) => knob.name === name)?.accepts ?? [];
      if (!accepts.includes(value)) {
        issues.push({ severity: "error", name, message: `${name} must be one of ${accepts.join(", ")} (got "${value}").` });
      }
    }
  }
  if (!mock) {
    const keyless = harness !== "copilot" && String(env.PI_MODEL_AUTH ?? "").trim().toLowerCase() === "managed-identity";
    const required = keyless ? contract.env.requiredWhenLiveKeyless : contract.env.requiredWhenLive;
    for (const name of required) {
      if (!env[name] || String(env[name]).trim() === "") {
        const hint = keyless
          ? "set it via azd env, or set PI_MOCK=1 for offline mode"
          : "set it via azd env, set PI_MODEL_AUTH=managed-identity for keyless auth, or set PI_MOCK=1 for offline mode";
        issues.push({ severity: "error", name, message: `${name} is required (${hint}).` });
      }
    }
  }
  for (const name of Object.keys(env)) {
    if (!contract.env.reservedPrefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (contract.env.reservedAllowedExceptions.includes(name)) continue;
    if (name.startsWith("AGENT_")) continue; // populated by Foundry at runtime; informational, not user-set.
    if (name.startsWith("FOUNDRY_")) {
      // Legacy aliases the runtime still reads; warn instead of erroring.
      if (["FOUNDRY_OPENAI_API_KEY", "FOUNDRY_OPENAI_BASE_URL", "FOUNDRY_OPENAI_MODEL", "FOUNDRY_INVOCATIONS_ENDPOINT", "FOUNDRY_TENANT_ID", "FOUNDRY_TOKEN_SCOPE", "FOUNDRY_BEARER_TOKEN", "FOUNDRY_MODEL", "FOUNDRY_MODEL_LABEL", "FOUNDRY_PROVIDER_NAME", "FOUNDRY_AGENT_SESSION_ID", "FOUNDRY_TOKEN_COMMAND_CWD"].includes(name)) continue;
      issues.push({ severity: "warning", name, message: `${name} uses the reserved FOUNDRY_ prefix; Foundry may overwrite it. Rename unless it is an established alias.` });
    }
  }
  return issues;
}
