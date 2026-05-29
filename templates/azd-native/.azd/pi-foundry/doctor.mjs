#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";

const checks = [];
let failures = 0;
let warnings = 0;

function pass(message) { checks.push({ level: "pass", message }); }
function warn(message) { warnings += 1; checks.push({ level: "warn", message }); }
function fail(message) { failures += 1; checks.push({ level: "fail", message }); }

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

async function readOptional(path) {
  try { return await readFile(path, "utf8"); } catch { return undefined; }
}

function commandResult(command, args = []) {
  try {
    return { ok: true, stdout: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }).trim() };
  } catch (error) {
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout.trim() : "", stderr: typeof error.stderr === "string" ? error.stderr.trim() : "" };
  }
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

function envHas(values, name) {
  return typeof values[name] === "string" && values[name].length > 0;
}

async function main() {
  const expectedFiles = [
    "azure.yaml",
    "agent.yaml",
    "agent.manifest.yaml",
    ".dockerignore",
    ".azd/pi-foundry/Dockerfile",
    ".azd/pi-foundry/README.md",
  ];

  for (const file of expectedFiles) {
    if (await exists(file)) pass(`found ${file}`);
    else fail(`missing ${file}`);
  }

  if (await exists(".agents/skills")) pass("found .agents/skills");
  else warn(".agents/skills not found; this may still be valid if skills are provided another way");

  const azureYaml = await readOptional("azure.yaml");
  if (azureYaml) {
    if (/host:\s*azure\.ai\.agent/.test(azureYaml)) pass("azure.yaml targets host azure.ai.agent");
    else fail("azure.yaml should target host azure.ai.agent");

    if (/path:\s*\.azd\/pi-foundry\/Dockerfile/.test(azureYaml)) pass("azure.yaml uses thin pi-foundry Dockerfile");
    else fail("azure.yaml should use docker.path .azd/pi-foundry/Dockerfile");

    if (/workflows:\s*[\s\S]*up:\s*[\s\S]*(package --all|package[\s\S]*--all)[\s\S]*(deploy --all|deploy[\s\S]*--all)/.test(azureYaml)) pass("azure.yaml overrides azd up to package and deploy");
    else warn("azure.yaml does not appear to override azd up; azd may try to provision infra/main.bicep");

    if (/postdeploy\.mjs/.test(azureYaml)) pass("azure.yaml runs pi-foundry postdeploy automation");
    else warn("azure.yaml does not run pi-foundry postdeploy automation; artifact RBAC may require manual grant");
  }

  const dockerfile = await readOptional(".azd/pi-foundry/Dockerfile");
  if (dockerfile) {
    if (/FROM\s+\$\{PI_FOUNDRY_RUNTIME_IMAGE\}|FROM\s+\S*pi-foundry-runtime/.test(dockerfile)) pass("thin Dockerfile uses pi-foundry runtime base image");
    else fail("thin Dockerfile should use a pi-foundry runtime base image");
    if (/COPY\s+\.\s+\/workspace/.test(dockerfile)) pass("thin Dockerfile copies repo to /workspace");
    else fail("thin Dockerfile should copy the existing repo to /workspace");
  }

  const dockerignore = await readOptional(".dockerignore");
  if (dockerignore) {
    for (const pattern of [".git", ".azure", ".env", "node_modules"]) {
      if (new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(dockerignore)) pass(`.dockerignore excludes ${pattern}`);
      else warn(`.dockerignore should exclude ${pattern}`);
    }
  }

  const agentYaml = await readOptional("agent.yaml");
  if (agentYaml) {
    const reserved = [...agentYaml.matchAll(/^\s*-\s+name:\s*["']?([^"'\s]+)["']?\s*$/gm)]
      .map((match) => match[1])
      .filter((name) => name.startsWith("AGENT_") || name.startsWith("FOUNDRY_"));
    if (reserved.length === 0) pass("agent.yaml does not define reserved AGENT_* or FOUNDRY_* env vars");
    else fail(`agent.yaml defines reserved env vars: ${reserved.join(", ")}`);
  }

  const azdVersion = commandResult("azd", ["version"]);
  if (azdVersion.ok) pass(`azd available: ${azdVersion.stdout.split("\n")[0]}`);
  else fail("azd is not available on PATH");

  const envResult = commandResult("azd", ["env", "get-values"]);
  if (envResult.ok) {
    pass("azd environment selected");
    const values = parseEnvValues(envResult.stdout);
    for (const name of ["FOUNDRY_PROJECT_ENDPOINT", "AZURE_CONTAINER_REGISTRY_ENDPOINT", "PI_ARGS", "REQUEST_TIMEOUT_MS"]) {
      if (envHas(values, name)) pass(`azd env has ${name}`);
      else fail(`azd env missing ${name}`);
    }
    if (/--mode\s+rpc/.test(values.PI_ARGS ?? "")) pass("PI_ARGS includes --mode rpc");
    else fail("PI_ARGS should include --mode rpc");

    if (values.PI_MOCK === "1" || values.PI_MOCK === "true") warn("PI_MOCK is enabled; remote deployment will not use a real model");
    else {
      for (const name of ["PI_OPENAI_API_KEY", "PI_OPENAI_BASE_URL", "PI_OPENAI_MODEL"]) {
        if (envHas(values, name)) pass(`azd env has ${name}`);
        else warn(`azd env missing ${name}; required for real model mode`);
      }
    }

    if (values.ARTIFACT_PUBLISH_MODE === "static-web") {
      for (const name of ["ARTIFACT_STORAGE_ACCOUNT", "ARTIFACT_STATIC_WEB_ENDPOINT", "ARTIFACT_BLOB_PREFIX"]) {
        if (envHas(values, name)) pass(`artifact env has ${name}`);
        else warn(`artifact static-web mode missing ${name}`);
      }
    }
  } else {
    fail("no azd environment selected; run azd env new <env-name> or azd env select <env-name>");
  }

  const aiDoctor = commandResult("azd", ["ai", "agent", "doctor", "--no-prompt"], { timeout: 180000 });
  if (aiDoctor.ok) pass("azd ai agent doctor passed");
  else warn("azd ai agent doctor reported issues; run it directly for details");

  for (const check of checks) {
    const symbol = check.level === "pass" ? "✓" : check.level === "warn" ? "⚠" : "✗";
    console.log(`${symbol} ${check.message}`);
  }
  console.log(`\npi-foundry adapter doctor: ${checks.length - warnings - failures} passed, ${warnings} warned, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
