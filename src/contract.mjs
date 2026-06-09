// open-foundry runtime image contract — single source of truth.
//
// This file is consumed in three places:
//   1. src/backend.mjs           validates env at startup, fails fast on missing required vars.
//   2. src/cli.mjs               exposes `open-foundry contract` and `open-foundry doctor`.
//   3. .agents/skills/open-foundry/references/contract.json
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
  // Harness table — single source of truth for the harness ↔ runtime-image map
  // and each harness's capabilities. Consumed by validateRuntimeEnv below and by
  // .agents/skills/open-foundry/scripts/_lib.mjs (inferHarnessFromRuntimeImage,
  // resolveModelAuth). `modelAuth` lists the auth modes the harness supports;
  // a harness without "managed-identity" is API-key-only (BYOK). Adding a harness
  // = add one row here (+ its adapter, an index.mjs case, and a
  // Dockerfile.runtime stage), then run `node scripts/emit-contract.mjs`.
  harnesses: [
    {
      harness: "pi",
      imagePrefix: "pi-foundry-runtime",
      runtimeImage: "ghcr.io/1openwindow/pi-foundry-runtime:0.1",
      modelAuth: ["apikey", "managed-identity"],
    },
    {
      harness: "copilot",
      imagePrefix: "ghcp-foundry-runtime",
      runtimeImage: "ghcr.io/1openwindow/ghcp-foundry-runtime:0.1",
      modelAuth: ["apikey"],
    },
    {
      harness: "codex",
      imagePrefix: "codex-foundry-runtime",
      runtimeImage: "ghcr.io/1openwindow/codex-foundry-runtime:0.1",
      modelAuth: ["apikey"],
    },
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
    // Required inside the runtime container, unless OF_MOCK=1.
    // OF_OPENAI_API_KEY is only required in apikey auth mode; OF_MODEL_AUTH=managed-identity
    // mints AAD tokens via DefaultAzureCredential instead of a static key.
    requiredWhenLive: ["OF_OPENAI_API_KEY", "OF_OPENAI_BASE_URL", "OF_OPENAI_MODEL"],
    requiredWhenLiveKeyless: ["OF_OPENAI_BASE_URL", "OF_OPENAI_MODEL"],
    // Optional runtime knobs with their defaults / accepted shapes.
    runtime: [
      { name: "HARNESS", default: "pi", accepts: ["pi", "copilot", "codex"], note: "Agent harness. copilot drives GitHub Copilot via @github/copilot-sdk; codex drives OpenAI Codex via @openai/codex-sdk. Both reach the model through BYOK (apikey only)." },
      { name: "PI_ARGS", default: "--mode rpc --no-session", note: "Append --provider foundry --model <model> when using OF_OPENAI_*." },
      { name: "OF_MOCK", default: "0", accepts: ["0", "1", "true", "false"] },
      { name: "OF_MODEL_AUTH", default: "apikey", accepts: ["apikey", "managed-identity"], note: "managed-identity mints AAD bearer tokens via DefaultAzureCredential; no OF_OPENAI_API_KEY needed. Not supported on API-key-only harnesses (copilot, codex)." },
      { name: "FOUNDRY_TOKEN_SCOPE", default: "https://cognitiveservices.azure.com/.default", note: "AAD scope used when OF_MODEL_AUTH=managed-identity." },
      { name: "COPILOT_PROVIDER_TYPE", default: "(auto)", accepts: ["azure", "openai"], note: "HARNESS=copilot BYOK provider type. Auto-detected from OF_OPENAI_BASE_URL (azure when the host is *.azure.com)." },
      { name: "COPILOT_WIRE_API", default: "completions", accepts: ["responses", "completions"], note: "HARNESS=copilot BYOK wire API format." },
      { name: "COPILOT_API_VERSION", default: "2025-04-01-preview", note: "HARNESS=copilot Azure provider api-version." },
      { name: "CODEX_PROVIDER_TYPE", default: "(auto)", accepts: ["azure", "openai"], note: "HARNESS=codex BYOK provider type. Auto-detected from OF_OPENAI_BASE_URL (azure when the host is *.azure.com)." },
      { name: "CODEX_WIRE_API", default: "responses", accepts: ["responses", "chat"], note: "HARNESS=codex provider wire API format." },
      { name: "CODEX_API_VERSION", default: "2025-04-01-preview", note: "HARNESS=codex Azure provider api-version." },
      { name: "REQUEST_TIMEOUT_MS", default: "300000" },
      { name: "SSE_HEARTBEAT_MS", default: "20000", note: "SSE keepalive interval; emits a `:` comment so Foundry's ~120s APIM idle timeout never fires during silent phases. 0 disables." },
      { name: "ENABLE_DIAGNOSTICS", default: "0", accepts: ["0", "1", "true", "false"] },
      { name: "WORKSPACE_DIR", default: "/workspace" },
      { name: "STATE_DIR", default: "${HOME}/.open-foundry" },
      { name: "SESSIONS_DIR", default: "${STATE_DIR}/sessions" },
      { name: "PI_CODING_AGENT_DIR", default: "${STATE_DIR}/pi-agent", note: "Never defaults to ~/.pi/agent; that would clobber a developer's interactive pi config." },
    ],
  },
};

// Auth modes a harness supports, read from the harnesses table (single source of
// truth). Unknown harnesses fall back to API-key-only. A harness whose modelAuth
// omits "managed-identity" has no keyless path (BYOK is API-key only).
export function harnessModelAuthModes(harness) {
  const row = contract.harnesses.find((h) => h.harness === harness);
  return Array.isArray(row?.modelAuth) ? row.modelAuth : ["apikey"];
}

export function harnessSupportsManagedIdentity(harness) {
  return harnessModelAuthModes(harness).includes("managed-identity");
}

export function validateRuntimeEnv(env, { mock } = {}) {
  const issues = [];
  const knownHarnesses = contract.harnesses.map((h) => h.harness);
  const harness = String(env.HARNESS ?? "").trim().toLowerCase() || "pi";
  if (!knownHarnesses.includes(harness)) {
    issues.push({ severity: "error", name: "HARNESS", message: `HARNESS must be one of ${knownHarnesses.join(", ")} (got "${harness}").` });
  }
  // API-key-only harnesses (modelAuth without "managed-identity", e.g. copilot/codex)
  // reach the model through BYOK and have no keyless path, so reject managed-identity
  // here instead of failing at the first model call.
  const requestedKeyless = String(env.OF_MODEL_AUTH ?? "").trim().toLowerCase() === "managed-identity";
  if (requestedKeyless && knownHarnesses.includes(harness) && !harnessSupportsManagedIdentity(harness)) {
    issues.push({ severity: "error", name: "OF_MODEL_AUTH", message: `HARNESS=${harness} does not support OF_MODEL_AUTH=managed-identity; BYOK requires an API key (set OF_OPENAI_API_KEY).` });
  }
  // Validate harness knobs at startup so a typo fails fast here, not as an opaque
  // SDK error on the first invocation. Only enforced for the relevant harness.
  const knobsByHarness = {
    copilot: ["COPILOT_PROVIDER_TYPE", "COPILOT_WIRE_API"],
    codex: ["CODEX_PROVIDER_TYPE", "CODEX_WIRE_API"],
  };
  for (const name of knobsByHarness[harness] ?? []) {
    const value = String(env[name] ?? "").trim().toLowerCase();
    if (!value) continue;
    const accepts = contract.env.runtime.find((knob) => knob.name === name)?.accepts ?? [];
    if (!accepts.includes(value)) {
      issues.push({ severity: "error", name, message: `${name} must be one of ${accepts.join(", ")} (got "${value}").` });
    }
  }
  if (!mock) {
    const keyless = requestedKeyless && harnessSupportsManagedIdentity(harness);
    const required = keyless ? contract.env.requiredWhenLiveKeyless : contract.env.requiredWhenLive;
    for (const name of required) {
      if (!env[name] || String(env[name]).trim() === "") {
        const hint = keyless
          ? "set it via azd env, or set OF_MOCK=1 for offline mode"
          : "set it via azd env, set OF_MODEL_AUTH=managed-identity for keyless auth, or set OF_MOCK=1 for offline mode";
        issues.push({ severity: "error", name, message: `${name} is required (${hint}).` });
      }
    }
  }
  for (const name of Object.keys(env)) {
    if (!contract.env.reservedPrefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (contract.env.reservedAllowedExceptions.includes(name)) continue;
    if (name.startsWith("AGENT_")) continue; // populated by Foundry at runtime; informational, not user-set.
    if (name.startsWith("FOUNDRY_")) {
      // Foundry-injected vars and documented aliases the runtime reads; warn instead of erroring.
      if (["FOUNDRY_INVOCATIONS_ENDPOINT", "FOUNDRY_TENANT_ID", "FOUNDRY_TOKEN_SCOPE", "FOUNDRY_BEARER_TOKEN", "FOUNDRY_MODEL", "FOUNDRY_MODEL_LABEL", "FOUNDRY_PROVIDER_NAME", "FOUNDRY_AGENT_SESSION_ID", "FOUNDRY_TOKEN_COMMAND_CWD"].includes(name)) continue;
      issues.push({ severity: "warning", name, message: `${name} uses the reserved FOUNDRY_ prefix; Foundry may overwrite it. Rename unless it is an established alias.` });
    }
  }
  return issues;
}
