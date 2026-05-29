#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";

const checks = [];
let failures = 0;
let warnings = 0;

function pass(message) {
  checks.push({ level: "pass", message });
}

function warn(message) {
  warnings += 1;
  checks.push({ level: "warn", message });
}

function fail(message) {
  failures += 1;
  checks.push({ level: "fail", message });
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function commandResult(command, args = []) {
  try {
    return { ok: true, stdout: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function compareNodeVersion(actual, minimum) {
  const parse = (value) => value.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
  const a = parse(actual);
  const b = parse(minimum);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function extractEnvNames(yamlText) {
  const names = [];
  const regex = /^\s*-\s+name:\s*["']?([^"'\s]+)["']?\s*$/gm;
  let match;
  while ((match = regex.exec(yamlText)) !== null) names.push(match[1]);
  return names;
}

function validateResourceTier(yamlText) {
  const cpuMatch = yamlText.match(/^\s*cpu:\s*["']?([^"'\s]+)["']?\s*$/m);
  const memoryMatch = yamlText.match(/^\s*memory:\s*["']?([^"'\s]+)["']?\s*$/m);
  if (!cpuMatch || !memoryMatch) {
    fail("agent.yaml should specify resources.cpu and resources.memory");
    return;
  }

  const pair = `${cpuMatch[1]}/${memoryMatch[1]}`;
  const validPairs = new Set(["0.25/0.5Gi", "0.5/1Gi", "1/2Gi", "2/4Gi"]);
  if (validPairs.has(pair)) pass(`agent.yaml uses valid Hosted Agent resource tier ${pair}`);
  else fail(`agent.yaml uses invalid Hosted Agent resource tier ${pair}; expected one of ${Array.from(validPairs).join(", ")}`);
}

async function main() {
  const requiredFiles = [
    "README.md",
    "Dockerfile",
    "Dockerfile.official",
    "Dockerfile.runtime",
    "azure.yaml",
    "agent.yaml",
    "agent.manifest.yaml",
    "src/server.mjs",
    ".env.example",
    "agent.config.example.yaml",
    "docs/byo-pi-agent.md",
    "docs/existing-pi-agent-journey.md",
    "docs/deploy-existing-pi-agent.md",
    "docs/demo-checklist.md",
    "docs/handoff.md",
    "docs/azd-native-ux.md",
    "docs/runtime-image.md",
    "src/runtime/artifacts.mjs",
    "scripts/configure-agent.mjs",
    "scripts/create-wrapper.mjs",
    "scripts/copy-azd-env.mjs",
    "scripts/deploy-foundry.mjs",
    "scripts/install-azd-adapter.mjs",
    "scripts/runtime-image-build.sh",
    "scripts/runtime-image-acr-build.mjs",
    "scripts/runtime-image-smoke.sh",
    "scripts/import-pi-agent.mjs",
    "scripts/grant-artifact-rbac.mjs",
    "scripts/demo-remote-artifact.sh",
    "runtime/official-invocations/README.md",
    "runtime/official-invocations/main.py",
    "runtime/official-invocations/requirements.txt",
    "runtime/official-invocations/entrypoint.sh",
    "runtime/official-invocations/smoke-local.sh",
    "templates/azd-native/README.md",
    "templates/azd-native/azure.yaml",
    "templates/azd-native/agent.yaml",
    "templates/azd-native/agent.manifest.yaml",
    "templates/azd-native/.dockerignore",
    "templates/azd-native/.azd/pi-foundry/Dockerfile",
    "templates/azd-native/.azd/pi-foundry/doctor.mjs",
    "templates/azd-native/.azd/pi-foundry/postdeploy.mjs",
  ];

  for (const file of requiredFiles) {
    if (await fileExists(file)) pass(`found ${file}`);
    else fail(`missing ${file}`);
  }

  const nodeVersion = process.version;
  if (compareNodeVersion(nodeVersion, "22.19.0") >= 0) pass(`Node ${nodeVersion} satisfies >=22.19.0`);
  else fail(`Node ${nodeVersion} is too old; expected >=22.19.0`);

  const agentYaml = await readOptional("agent.yaml");
  if (agentYaml) {
    validateResourceTier(agentYaml);
    const reservedEnvNames = extractEnvNames(agentYaml).filter((name) => name.startsWith("AGENT_") || name.startsWith("FOUNDRY_"));
    if (reservedEnvNames.length === 0) pass("agent.yaml does not define reserved AGENT_* or FOUNDRY_* environment variables");
    else fail(`agent.yaml defines reserved environment variables: ${reservedEnvNames.join(", ")}`);
  }

  const manifestYaml = await readOptional("agent.manifest.yaml");
  if (manifestYaml) {
    const reservedEnvNames = extractEnvNames(manifestYaml).filter((name) => name.startsWith("AGENT_") || name.startsWith("FOUNDRY_"));
    if (reservedEnvNames.length === 0) pass("agent.manifest.yaml does not define reserved AGENT_* or FOUNDRY_* environment variables");
    else fail(`agent.manifest.yaml defines reserved environment variables: ${reservedEnvNames.join(", ")}`);
  }

  const envExample = await readOptional(".env.example");
  if (envExample) {
    const piArgsMatch = envExample.match(/^PI_ARGS=(.*)$/m);
    if (!piArgsMatch) warn(".env.example does not include PI_ARGS");
    else if (/--mode\s+rpc/.test(piArgsMatch[1])) pass(".env.example PI_ARGS includes --mode rpc");
    else fail(".env.example PI_ARGS should include --mode rpc");

    if (/^\.azure\/?$/m.test((await readOptional(".gitignore")) ?? "")) pass(".gitignore excludes .azure/");
    else warn(".gitignore should exclude .azure/ because it may contain local azd secrets");
  }

  const azdVersion = commandResult("azd", ["version"]);
  if (azdVersion.ok) pass(`azd is available: ${azdVersion.stdout.split("\n")[0]}`);
  else warn("azd is not available on PATH; remote deployment requires azd");

  const azdExtensions = commandResult("azd", ["extension", "list"]);
  if (azdExtensions.ok && azdExtensions.stdout.includes("azure.ai.agents")) pass("azd azure.ai.agents extension is installed");
  else warn("azd azure.ai.agents extension was not detected; install with: azd extension install azure.ai.agents");

  const piVersion = commandResult("pi", ["--version"]);
  if (piVersion.ok) pass(piVersion.stdout ? `pi is available: ${piVersion.stdout.split("\n")[0]}` : "pi command is available");
  else warn("pi is not available on PATH; local real-mode smoke tests require pi, but PI_MOCK=1 can still test the wrapper");

  for (const check of checks) {
    const symbol = check.level === "pass" ? "✓" : check.level === "warn" ? "⚠" : "✗";
    console.log(`${symbol} ${check.message}`);
  }

  console.log(`\nValidation summary: ${checks.length - failures - warnings} passed, ${warnings} warned, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

await main();
