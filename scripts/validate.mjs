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

function commandResult(command, args = [], options = {}) {
  try {
    return { ok: true, stdout: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: options.cwd }).trim() };
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
    fail("generated agent.yaml should specify resources.cpu and resources.memory");
    return;
  }

  const pair = `${cpuMatch[1]}/${memoryMatch[1]}`;
  const validPairs = new Set(["0.25/0.5Gi", "0.5/1Gi", "1/2Gi", "2/4Gi"]);
  if (validPairs.has(pair)) pass(`generated agent.yaml uses valid Hosted Agent resource tier ${pair}`);
  else fail(`generated agent.yaml uses invalid Hosted Agent resource tier ${pair}; expected one of ${Array.from(validPairs).join(", ")}`);
}

async function main() {
  const requiredFiles = [
    "README.md",
    "Dockerfile.runtime",
    "examples/demo-agent/Dockerfile",
    "examples/demo-agent/demo-workspace/README.md",
    "examples/demo-agent/.agents/skills/edge-tts/SKILL.md",
    "examples/demo-agent/.agents/skills/gpt-image-2/SKILL.md",
    "examples/demo-agent/.agents/skills/hyperframes/SKILL.md",
    "examples/full-repo-deploy/azure.yaml",
    "examples/full-repo-deploy/agent.yaml",
    "examples/full-repo-deploy/agent.manifest.yaml",
    "src/backend.mjs",
    ".env.example",
    "docs/reference/agent.config.example.yaml",
    "docs/byo-pi-agent.md",
    "docs/demo-checklist.md",
    "docs/handoff.md",
    "docs/skill-managed-ux.md",
    "docs/runtime-image.md",
    "docs/skill-adapter-design.md",
    "src/runtime/artifacts.mjs",
    "scripts/runtime-image-build.sh",
    "scripts/runtime-image-acr-build.mjs",
    "scripts/runtime-image-smoke.sh",
    "scripts/grant-artifact-rbac.mjs",
    "scripts/demo-remote-artifact.sh",
    "runtime/official-invocations/README.md",
    "runtime/official-invocations/main.py",
    "runtime/official-invocations/requirements.txt",
    "runtime/official-invocations/entrypoint.sh",
    "runtime/official-invocations/smoke-local.sh",
    ".agents/skills/pi-foundry/SKILL.md",
    ".agents/skills/pi-foundry/assets/adapter/README.md",
    ".agents/skills/pi-foundry/assets/adapter/render.mjs",
    ".agents/skills/pi-foundry/assets/adapter/doctor.mjs",
    ".agents/skills/pi-foundry/assets/adapter/postdeploy.mjs",
    ".agents/skills/pi-foundry/assets/adapter/azd-agent.mjs",
    ".agents/skills/pi-foundry/assets/adapter/dockerignore.block",
    ".agents/skills/pi-foundry/assets/adapter/adapter-manifest.json",
    ".agents/skills/pi-foundry/scripts/inspect-repo.mjs",
    ".agents/skills/pi-foundry/scripts/init-adapter.mjs",
    ".agents/skills/pi-foundry/scripts/update-config.mjs",
    ".agents/skills/pi-foundry/scripts/merge-dockerignore.mjs",
    ".agents/skills/pi-foundry/scripts/configure-env.mjs",
    ".agents/skills/pi-foundry/scripts/smoke-invoke.mjs",
    ".agents/skills/pi-foundry/scripts/migrate-adapter.mjs",
    ".agents/skills/pi-foundry/references/vision.md",
    ".agents/skills/pi-foundry/references/yaml-ownership.md",
    ".agents/skills/pi-foundry/references/env-vars.md",
    ".agents/skills/pi-foundry/references/runtime-images.json",
    ".agents/skills/pi-foundry/references/troubleshooting.md",
    ".agents/skills/pi-foundry/references/adapter-contract.md",
  ];

  for (const file of requiredFiles) {
    if (await fileExists(file)) pass(`found ${file}`);
    else fail(`missing ${file}`);
  }

  const nodeVersion = process.version;
  if (compareNodeVersion(nodeVersion, "22.19.0") >= 0) pass(`Node ${nodeVersion} satisfies >=22.19.0`);
  else fail(`Node ${nodeVersion} is too old; expected >=22.19.0`);

  const installSmoke = commandResult("bash", ["-lc", `
    set -euo pipefail
    repo=$PWD
    tmp=$(mktemp -d)
    cd "$tmp"
    node "$repo/.agents/skills/pi-foundry/scripts/install-adapter.mjs" --agent-name hello-world-agent
    test ! -e agent.yaml
    test ! -e agent.manifest.yaml
    test -f .azd/pi-foundry/generated/agent.yaml
    test -f .azd/pi-foundry/generated/agent.manifest.yaml
    test -f .azd/pi-foundry/azd-agent.mjs
    grep -q 'azd-agent.mjs package --all' azure.yaml
    grep -q 'azd-agent.mjs deploy --all' azure.yaml
    node .azd/pi-foundry/azd-agent.mjs deploy --help >/dev/null
    test ! -e agent.yaml
    test ! -e agent.manifest.yaml
    node .azd/pi-foundry/render.mjs --check
    python3 -c "from pathlib import Path; p=Path('azure.yaml'); p.write_text('\\n'.join(line for line in p.read_text().splitlines() if not line.startswith('#')) + '\\n')"
    node .azd/pi-foundry/render.mjs
    node .azd/pi-foundry/render.mjs --check
  `], { cwd: "." });
  if (installSmoke.ok) pass("pi-foundry skill can install adapter assets, keep generated agent YAML under .azd, and recover normalized azure.yaml");
  else fail("pi-foundry skill install smoke failed");

  const rootAgentPreserve = commandResult("bash", ["-lc", `
    set -euo pipefail
    repo=$PWD
    tmp=$(mktemp -d)
    cd "$tmp"
    printf 'name: existing-user-agent\n' > agent.yaml
    node "$repo/.agents/skills/pi-foundry/scripts/install-adapter.mjs" --agent-name hello-world-agent
    grep -q 'existing-user-agent' agent.yaml
    node .azd/pi-foundry/azd-agent.mjs deploy --help >/dev/null
    grep -q 'existing-user-agent' agent.yaml
    node .azd/pi-foundry/render.mjs --check
  `], { cwd: "." });
  if (rootAgentPreserve.ok) pass("pi-foundry install does not overwrite user-owned root agent.yaml");
  else fail("pi-foundry root agent.yaml preservation check failed");

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
