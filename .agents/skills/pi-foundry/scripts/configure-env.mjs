#!/usr/bin/env node
import { execFileSync } from "node:child_process";

function usage() {
  console.error(`Usage: configure-env.mjs [options]\n\nSets pi-foundry azd environment values. Secrets must come from environment variables.\n\nOptions:\n  --env-name <name>                 Create/select azd environment if needed.\n  --acr <registry.azurecr.io>\n  --model <model>\n  --base-url <url>\n  --api-key-env <ENV_VAR_NAME>       Reads secret from process env; never pass the key as an arg.\n  --mock <0|1>\n  --timeout-ms <ms>\n  --artifact-mode <disabled|static-web>\n  --artifact-storage-account <name>\n  --artifact-static-web-endpoint <url>\n  --artifact-blob-prefix <prefix>\n`);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values[arg.slice(2)] = value;
    index += 1;
  }
  return values;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: 120000,
    env: process.env,
  })?.trim();
}

function tryRun(command, args) {
  try {
    return run(command, args, { quiet: true });
  } catch {
    return undefined;
  }
}

function azdSet(name, value, { secret = false } = {}) {
  if (value === undefined || value === "") return;
  run("azd", ["env", "set", name, String(value)]);
  console.log(`configured ${name}${secret ? "=<secret>" : ""}`);
}

const args = parseArgs(process.argv.slice(2));

if (args["env-name"]) {
  const currentValues = tryRun("azd", ["env", "get-values"]);
  if (!currentValues) {
    tryRun("azd", ["env", "new", args["env-name"]]) ?? run("azd", ["env", "select", args["env-name"]]);
  } else {
    run("azd", ["env", "select", args["env-name"]]);
  }
}

azdSet("AZURE_CONTAINER_REGISTRY_ENDPOINT", args.acr);
azdSet("PI_MOCK", args.mock ?? "0");
azdSet("REQUEST_TIMEOUT_MS", args["timeout-ms"] ?? "600000");
azdSet("ENABLE_DIAGNOSTICS", "0");

if (args.model) {
  azdSet("PI_OPENAI_MODEL", args.model);
  azdSet("PI_ARGS", `--mode rpc --no-session --provider foundry --model ${args.model}`);
}
azdSet("PI_OPENAI_BASE_URL", args["base-url"]);

if (args["api-key-env"]) {
  const secret = process.env[args["api-key-env"]];
  if (!secret) throw new Error(`Environment variable ${args["api-key-env"]} is not set`);
  azdSet("PI_OPENAI_API_KEY", secret, { secret: true });
}

azdSet("ARTIFACT_PUBLISH_MODE", args["artifact-mode"]);
azdSet("ARTIFACT_STORAGE_ACCOUNT", args["artifact-storage-account"]);
azdSet("ARTIFACT_STATIC_WEB_ENDPOINT", args["artifact-static-web-endpoint"]);
azdSet("ARTIFACT_STATIC_WEB_CONTAINER", args["artifact-mode"] === "static-web" ? "$web" : undefined);
azdSet("ARTIFACT_BLOB_PREFIX", args["artifact-blob-prefix"]);

console.log("azd env configuration complete");
