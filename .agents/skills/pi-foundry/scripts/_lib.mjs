// Shared helpers for pi-foundry skill scripts.
// These scripts live inside the pi-foundry repo (skill location) and are NOT
// copied into user repos. They run with cwd = user repo.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function skillPath(...segments) {
  return resolve(SKILL_ROOT, ...segments);
}

export async function loadContract() {
  const text = await readFile(skillPath("references/contract.json"), "utf8");
  return JSON.parse(text);
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? (options.quiet ? ["ignore", "pipe", "pipe"] : "inherit"),
    timeout: options.timeout ?? 180000,
    env: process.env,
    cwd: options.cwd,
  })?.trim();
}

export function tryRun(command, args, options = {}) {
  try {
    return run(command, args, { ...options, quiet: true });
  } catch {
    return undefined;
  }
}

export function commandResult(command, args = [], options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeout ?? 120000,
        env: process.env,
        cwd: options.cwd,
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error.stderr === "string" ? error.stderr.trim() : "",
    };
  }
}

export function parseDotenv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function readDotenv(path) {
  return parseDotenv(readFileSync(path, "utf8"));
}

export function azdEnvValues() {
  const result = commandResult("azd", ["env", "get-values"]);
  if (!result.ok) return {};
  return parseDotenv(result.stdout);
}

export function isSecretName(name) {
  return /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(name);
}

export function redact(value) {
  if (!value) return "<unset>";
  if (value.length <= 8) return "<set>";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function parseArgs(argv, { flags = [] } = {}) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      result._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (flags.includes(key)) {
      result[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

// Harness inference. The runtime image is the single source of truth for the
// harness (pi vs copilot); these helpers only *read* that choice for local
// preflight and UX hints. They never decide the harness from repo structure.
export function inferHarnessFromRuntimeImage(image) {
  if (!image || typeof image !== "string") return "unknown";
  // Drop digest and tag, then take the final path segment (the repository name).
  const ref = image.split("@")[0];
  const lastColon = ref.lastIndexOf(":");
  const lastSlash = ref.lastIndexOf("/");
  const noTag = lastColon > lastSlash ? ref.slice(0, lastColon) : ref;
  const name = noTag.slice(noTag.lastIndexOf("/") + 1);
  if (name.includes("ghcp-foundry-runtime")) return "copilot";
  if (name.includes("pi-foundry-runtime")) return "pi";
  return "unknown";
}

// Parse the runtime image out of a bootstrapped Dockerfile. The template is:
//   ARG PI_FOUNDRY_RUNTIME_IMAGE=<image>
//   FROM ${PI_FOUNDRY_RUNTIME_IMAGE}
// but a user may have inlined the image into FROM directly, so handle both.
export function runtimeImageFromDockerfileText(text) {
  if (!text) return undefined;
  let argDefault;
  let fromRef;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const arg = line.match(/^ARG\s+PI_FOUNDRY_RUNTIME_IMAGE=(.+)$/i);
    if (arg) argDefault = arg[1].trim();
    const from = line.match(/^FROM\s+(\S+)/i);
    if (from) fromRef = from[1].trim();
  }
  if (fromRef && /^\$\{?PI_FOUNDRY_RUNTIME_IMAGE\}?$/.test(fromRef)) return argDefault;
  return fromRef ?? argDefault;
}

export function inferHarnessFromDockerfile(path = "Dockerfile") {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { harness: "unknown", image: undefined, found: false };
  }
  const image = runtimeImageFromDockerfileText(text);
  return { harness: inferHarnessFromRuntimeImage(image), image, found: true };
}

export function resolveModelAuth({ argValue, fileValue, harness }) {
  return argValue || fileValue || (harness === "copilot" ? "apikey" : undefined);
}

export function fail(message) {
  console.error(message instanceof Error ? message.message : String(message));
  process.exit(1);
}

export function installCrashHandlers() {
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
}
