#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";

const checks = [];
let failures = 0;
let warnings = 0;

function pass(message, details) {
  checks.push({ level: "pass", message, details });
}

function warn(message, details) {
  warnings += 1;
  checks.push({ level: "warn", message, details });
}

function fail(message, details) {
  failures += 1;
  checks.push({ level: "fail", message, details });
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
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeout ?? 15000,
        env: process.env,
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error.stderr === "string" ? error.stderr.trim() : "",
      message: error instanceof Error ? error.message : String(error),
    };
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

function validateResourceTier(yamlText, path) {
  const cpuMatch = yamlText.match(/^\s*cpu:\s*["']?([^"'\s]+)["']?\s*$/m);
  const memoryMatch = yamlText.match(/^\s*memory:\s*["']?([^"'\s]+)["']?\s*$/m);
  if (!cpuMatch || !memoryMatch) {
    fail(`${path} should specify resources.cpu and resources.memory`);
    return;
  }

  const pair = `${cpuMatch[1]}/${memoryMatch[1]}`;
  const validPairs = new Set(["0.25/0.5Gi", "0.5/1Gi", "1/2Gi", "2/4Gi"]);
  if (validPairs.has(pair)) pass(`${path} uses valid Hosted Agent resource tier ${pair}`);
  else fail(`${path} uses invalid Hosted Agent resource tier ${pair}`, `Expected one of ${Array.from(validPairs).join(", ")}`);
}

function parseAzdEnvValues(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
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

function hasValue(values, name) {
  return typeof values[name] === "string" && values[name].length > 0;
}

function redacted(value) {
  if (!value) return "<unset>";
  if (value.length <= 8) return "<set>";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function yamlScalar(text, dottedPath) {
  const parts = dottedPath.split(".");
  let indent = -1;
  let offset = 0;

  for (const part of parts) {
    const lines = text.slice(offset).split(/\r?\n/);
    let found;
    let consumed = 0;
    for (const line of lines) {
      const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
      const match = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
      if (match && match[1] === part && lineIndent > indent) {
        found = { line, lineIndent, rawValue: match[2] };
        break;
      }
      consumed += line.length + 1;
    }
    if (!found) return undefined;
    indent = found.lineIndent;
    offset += consumed + found.line.length + 1;
    if (part === parts.at(-1)) {
      const value = found.rawValue.replace(/\s+#.*$/, "").trim();
      if (!value) return undefined;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
      return value;
    }
  }
  return undefined;
}

function yamlListBlockContains(text, dottedPath, expected) {
  const key = dottedPath.split(".").at(-1);
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
    if (!match || match[2] !== key) continue;

    const keyIndent = match[1].length;
    const block = [];
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const child = lines[childIndex];
      if (!child.trim()) {
        block.push(child);
        continue;
      }
      const childIndent = child.match(/^\s*/)?.[0].length ?? 0;
      if (childIndent <= keyIndent) break;
      block.push(child);
    }
    if (block.some((line) => line.trim() === `- ${expected}`)) return true;
  }
  return false;
}

async function checkRepoShape() {
  const requiredFiles = [
    "README.md",
    "Dockerfile",
    "Dockerfile.runtime",
    "azure.yaml",
    "agent.yaml",
    "agent.manifest.yaml",
    "src/backend.mjs",
    "src/adapters/pi-rpc.mjs",
    ".env.example",
    "agent.config.example.yaml",
    "docs/byo-pi-agent.md",
    "docs/demo-checklist.md",
    "docs/handoff.md",
    "src/runtime/artifacts.mjs",
    "scripts/grant-artifact-rbac.mjs",
    "scripts/demo-remote-artifact.sh",
    "runtime/official-invocations/README.md",
    "runtime/official-invocations/main.py",
    "runtime/official-invocations/requirements.txt",
    "runtime/official-invocations/entrypoint.sh",
    "runtime/official-invocations/smoke-local.sh",
  ];

  for (const file of requiredFiles) {
    if (await fileExists(file)) pass(`found ${file}`);
    else fail(`missing ${file}`);
  }

  if (compareNodeVersion(process.version, "22.19.0") >= 0) pass(`Node ${process.version} satisfies >=22.19.0`);
  else fail(`Node ${process.version} is too old`, "Expected >=22.19.0");

  const agentYaml = await readOptional("agent.yaml");
  if (agentYaml) {
    validateResourceTier(agentYaml, "agent.yaml");
    const reserved = extractEnvNames(agentYaml).filter((name) => name.startsWith("AGENT_") || name.startsWith("FOUNDRY_"));
    if (reserved.length === 0) pass("agent.yaml avoids reserved AGENT_* and FOUNDRY_* env vars");
    else fail(`agent.yaml defines reserved env vars: ${reserved.join(", ")}`);
  }

  const manifest = await readOptional("agent.manifest.yaml");
  if (manifest) {
    const reserved = extractEnvNames(manifest).filter((name) => name.startsWith("AGENT_") || name.startsWith("FOUNDRY_"));
    if (reserved.length === 0) pass("agent.manifest.yaml avoids reserved AGENT_* and FOUNDRY_* env vars");
    else fail(`agent.manifest.yaml defines reserved env vars: ${reserved.join(", ")}`);
  }

  const gitignore = (await readOptional(".gitignore")) ?? "";
  if (/^\.azure\/?$/m.test(gitignore)) pass(".gitignore excludes .azure/");
  else warn(".gitignore should exclude .azure/ because it may contain local azd secrets");

  const azureYaml = (await readOptional("azure.yaml")) ?? "";
  if (/remoteBuild:\s*true/.test(azureYaml)) pass("azure.yaml enables docker.remoteBuild");
  else warn("azure.yaml does not enable docker.remoteBuild; local Docker may be required for deployment");
  if (/startupCommand:\s*runtime\/official-invocations\/entrypoint\.sh/.test(azureYaml) || /startupCommand:\s*\/app\/runtime\/official-invocations\/entrypoint\.sh/.test(azureYaml)) {
    pass("azure.yaml starts the official Invocations SDK entrypoint");
  } else {
    fail("azure.yaml should start runtime/official-invocations/entrypoint.sh, not the internal Node backend directly");
  }
}

function checkTools() {
  const azd = commandResult("azd", ["version"]);
  if (azd.ok) pass(`azd available: ${azd.stdout.split("\n")[0]}`);
  else warn("azd not available on PATH", "Remote deployment requires azd");

  const extensions = commandResult("azd", ["extension", "list"]);
  if (extensions.ok && extensions.stdout.includes("azure.ai.agents")) pass("azd azure.ai.agents extension is installed");
  else warn("azd azure.ai.agents extension not detected", "Install with: azd extension install azure.ai.agents");

  const pi = commandResult("pi", ["--version"]);
  if (pi.ok) pass(pi.stdout ? `pi available: ${pi.stdout.split("\n")[0]}` : "pi command is available");
  else warn("pi not available on PATH", "PI_MOCK=1 can test the wrapper; real local Pi smoke requires pi");

  const docker = commandResult("docker", ["ps"], { timeout: 10000 });
  if (docker.ok) pass("Docker daemon is reachable by current user");
  else {
    const combined = `${docker.stdout}\n${docker.stderr}\n${docker.message}`;
    if (combined.includes("permission denied") && combined.includes("docker.sock")) {
      warn(
        "Docker daemon permission denied for current user",
        "Fix with: sudo usermod -aG docker \"$USER\" && newgrp docker; if running under WSL/agent harness, restart the WSL/session so this process gets new group membership",
      );
    } else {
      warn("Docker daemon is not reachable", combined.split("\n").filter(Boolean).slice(0, 3).join(" | "));
    }
  }
}

function checkAgentConfig(values = {}) {
  return readOptional("agent.config.yaml").then(async (configText) => {
    if (!configText) {
      warn("agent.config.yaml not found", "Copy agent.config.example.yaml to agent.config.yaml when customizing a BYO Pi agent");
      return;
    }

    pass("agent.config.yaml is present");

    const runtimeType = yamlScalar(configText, "runtime.type");
    if (runtimeType === "pi-rpc") pass("agent.config.yaml runtime.type is pi-rpc");
    else warn(`agent.config.yaml runtime.type is ${runtimeType ?? "<unset>"}`, "This template currently supports pi-rpc as the primary path");

    if (yamlListBlockContains(configText, "runtime.args", "--mode")) pass("agent.config.yaml runtime args include --mode");
    else warn("agent.config.yaml runtime args should include --mode rpc");

    const configModel = yamlScalar(configText, "runtime.model");
    const envModel = values.PI_OPENAI_MODEL ?? process.env.PI_OPENAI_MODEL;
    if (configModel && envModel && configModel !== envModel) warn(`agent.config.yaml runtime.model (${configModel}) differs from PI_OPENAI_MODEL (${envModel})`);
    else if (configModel) pass(`agent.config.yaml runtime.model is ${configModel}`);

    const skillsPath = yamlScalar(configText, "skills.path") ?? ".agents/skills";
    if (await fileExists(skillsPath)) pass(`agent.config.yaml skills.path exists: ${skillsPath}`);
    else warn(`agent.config.yaml skills.path does not exist: ${skillsPath}`);

    const mcpConfig = yamlScalar(configText, "mcp.config");
    const mcpOptional = yamlScalar(configText, "mcp.optional") !== "false";
    if (mcpConfig) {
      if (await fileExists(mcpConfig)) pass(`agent.config.yaml mcp.config exists: ${mcpConfig}`);
      else if (mcpOptional) warn(`optional mcp.config not found: ${mcpConfig}`);
      else fail(`required mcp.config not found: ${mcpConfig}`);
    }

    const artifactMode = yamlScalar(configText, "artifacts.mode");
    const envArtifactMode = values.ARTIFACT_PUBLISH_MODE ?? process.env.ARTIFACT_PUBLISH_MODE;
    if (artifactMode && envArtifactMode && artifactMode !== envArtifactMode) {
      warn(`agent.config.yaml artifacts.mode (${artifactMode}) differs from ARTIFACT_PUBLISH_MODE (${envArtifactMode})`);
    } else if (artifactMode) {
      pass(`agent.config.yaml artifacts.mode is ${artifactMode}`);
    }
  });
}

async function checkAzdEnvironment() {
  const result = commandResult("azd", ["env", "get-values"]);
  if (!result.ok) {
    warn("azd environment values are not available", "Run azd env new <name> or azd env select <name>");
    await checkAgentConfig({});
    return;
  }

  const values = parseAzdEnvValues(result.stdout);
  if (hasValue(values, "AZURE_ENV_NAME")) pass(`azd env selected: ${values.AZURE_ENV_NAME}`);
  else warn("AZURE_ENV_NAME is not set in azd env");

  for (const name of ["AZURE_SUBSCRIPTION_ID", "AZURE_TENANT_ID", "AZURE_LOCATION", "FOUNDRY_PROJECT_ENDPOINT", "AZURE_AI_PROJECT_ID"]) {
    if (hasValue(values, name)) pass(`${name} is configured`);
    else warn(`${name} is not configured`);
  }

  if (hasValue(values, "AZURE_CONTAINER_REGISTRY_ENDPOINT")) pass("AZURE_CONTAINER_REGISTRY_ENDPOINT is configured");
  else warn("AZURE_CONTAINER_REGISTRY_ENDPOINT is not configured", "azd deploy may create/configure this, depending on environment");

  const allowedFoundryVars = new Set([
    "FOUNDRY_PROJECT_ENDPOINT",
  ]);
  const foundryReserved = Object.keys(values).filter((name) => name.startsWith("FOUNDRY_") && !allowedFoundryVars.has(name));
  const agentOutputs = Object.keys(values).filter((name) => name.startsWith("AGENT_"));
  if (foundryReserved.length === 0) pass("azd env does not contain custom reserved FOUNDRY_* input variables");
  else warn(`azd env contains reserved FOUNDRY_* variables: ${foundryReserved.join(", ")}`, "Avoid user-defined FOUNDRY_* variables; Foundry reserves this prefix");
  if (agentOutputs.length === 0) pass("azd env has no AGENT_* deployment output variables yet");
  else pass(`azd env contains ${agentOutputs.length} AGENT_* deployment output variables from prior deploys`);

  const piMock = values.PI_MOCK ?? process.env.PI_MOCK;
  const piArgs = values.PI_ARGS ?? process.env.PI_ARGS;
  if (hasValue({ PI_ARGS: piArgs }, "PI_ARGS")) {
    if (/--mode\s+rpc/.test(piArgs)) pass("PI_ARGS includes --mode rpc");
    else fail("PI_ARGS should include --mode rpc");
    if (piArgs.includes("--no-session")) pass("PI_ARGS includes --no-session; wrapper will replace it with per-session --continue/--session-dir");
    else warn("PI_ARGS does not include --no-session", "This can be valid, but verify the wrapper-owned session mapping still behaves as intended");
  } else {
    warn("PI_ARGS is not configured in azd env", "Default is --mode rpc --no-session for local runs");
  }

  if (piMock === "1" || piMock === "true") {
    pass("PI_MOCK is enabled; real model credentials are not required for wrapper smoke tests");
  } else {
    if (hasValue(values, "PI_MOCK")) pass(`PI_MOCK=${values.PI_MOCK}`);
    else warn("PI_MOCK is not configured; deployment may default to real Pi mode");

    for (const name of ["PI_OPENAI_BASE_URL", "PI_OPENAI_MODEL"]) {
      if (hasValue(values, name)) pass(`${name} is configured: ${values[name]}`);
      else warn(`${name} is not configured`, "Required when using the generated foundry provider");
    }

    if (hasValue(values, "PI_OPENAI_API_KEY")) pass(`PI_OPENAI_API_KEY is configured: ${redacted(values.PI_OPENAI_API_KEY)}`);
    else warn("PI_OPENAI_API_KEY is not configured", "Real remote model invocation will fail if PI_ARGS uses provider foundry");
  }

  const artifactMode = values.ARTIFACT_PUBLISH_MODE ?? process.env.ARTIFACT_PUBLISH_MODE ?? "disabled";
  if (artifactMode === "static-web") {
    pass("ARTIFACT_PUBLISH_MODE=static-web");
    for (const name of ["ARTIFACT_STORAGE_ACCOUNT", "ARTIFACT_STATIC_WEB_ENDPOINT", "ARTIFACT_STATIC_WEB_CONTAINER", "ARTIFACT_BLOB_PREFIX"]) {
      if (hasValue(values, name)) pass(`${name} is configured`);
      else warn(`${name} is not configured`, "static-web artifact publishing may fail");
    }
  } else if (artifactMode === "disabled") {
    warn("ARTIFACT_PUBLISH_MODE=disabled", "Remote generated artifacts will not be returned as clickable public links");
  } else {
    warn(`ARTIFACT_PUBLISH_MODE=${artifactMode}`, "Known modes: disabled, static-web");
  }

  return checkAgentConfig(values);
}

function printReport() {
  for (const check of checks) {
    const symbol = check.level === "pass" ? "✓" : check.level === "warn" ? "⚠" : "✗";
    console.log(`${symbol} ${check.message}`);
    if (check.details) console.log(`  ${check.details}`);
  }
  console.log(`\nDoctor summary: ${checks.length - failures - warnings} passed, ${warnings} warned, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

await checkRepoShape();
checkTools();
await checkAzdEnvironment();
printReport();
