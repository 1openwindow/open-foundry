#!/usr/bin/env node
// bootstrap.mjs — copy pi-foundry templates into the user's repo and substitute placeholders.
//
// Intended use: invoked by the pi-foundry skill (or directly by a developer) from inside
// the user's Pi agent repo. Writes 5 files at the repo root:
//   Dockerfile, azure.yaml, agent.yaml, agent.manifest.yaml, .dockerignore
// No .azd/pi-foundry/ framework, no lock files, no rendered intermediates.
//
// Usage:
//   bootstrap.mjs --agent-name <name> --runtime-image <acr>/pi-foundry-runtime:<tag> [options]
//
// Options:
//   --agent-name <name>         (required) Foundry Hosted Agent name. Lowercase letters/numbers/hyphens.
//   --runtime-image <image>     (required) Full pi-foundry runtime image reference.
//   --display-name <name>       Human-readable name. Defaults from agent name.
//   --cpu <value>               Default 2. Must be a valid Hosted Agent tier (see contract.json).
//   --memory <value>            Default 4Gi. Must pair with --cpu per contract.
//   --force                     Overwrite existing files. Without this, existing files are refused.
//   --no-dockerignore           Skip writing .dockerignore.

import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installCrashHandlers, loadContract, parseArgs, inferHarnessFromRuntimeImage } from "./_lib.mjs";

installCrashHandlers();

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(SCRIPT_DIR, "../templates");

const args = parseArgs(process.argv.slice(2), { flags: ["force", "no-dockerignore"] });

if (args.help || (!args["agent-name"] && !args["runtime-image"])) {
  console.error(`Usage: bootstrap.mjs --agent-name <name> --runtime-image <image> [options]

Options:
  --agent-name <name>         (required)
  --runtime-image <image>     (required)
  --display-name <name>       Defaults from agent name.
  --cpu <value>               Default 2.
  --memory <value>            Default 4Gi.
  --force                     Overwrite existing files.
  --no-dockerignore           Skip writing .dockerignore.`);
  process.exit(args.help ? 0 : 2);
}

const agentName = sanitize(args["agent-name"]);
const runtimeImage = args["runtime-image"];
if (!agentName) throw new Error("--agent-name is required");
if (!runtimeImage) throw new Error("--runtime-image is required (no public default; pass your org's pi-foundry-runtime image)");
if (!/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/.test(agentName)) {
  throw new Error(`--agent-name must be 3-64 chars, lowercase a-z/0-9/-, starting with a letter: got "${agentName}"`);
}

const displayName = args["display-name"] ?? defaultDisplayName(agentName);
const cpu = args.cpu ?? "2";
const memory = args.memory ?? "4Gi";

const contract = await loadContract();
const tierOk = contract.resourceTiers.some((tier) => tier.cpu === cpu && tier.memory === memory);
if (!tierOk) {
  const list = contract.resourceTiers.map((t) => `${t.cpu}/${t.memory}`).join(", ");
  throw new Error(`cpu=${cpu} memory=${memory} is not a valid Hosted Agent tier. Allowed: ${list}`);
}

await guardCwdIsNotSkillRepo();

const targets = [
  { template: "Dockerfile", path: "Dockerfile" },
  { template: "azure.yaml", path: "azure.yaml" },
  { template: "agent.yaml", path: "agent.yaml" },
  { template: "agent.manifest.yaml", path: "agent.manifest.yaml" },
];
if (!args["no-dockerignore"]) targets.push({ template: ".dockerignore", path: ".dockerignore" });

const substitutions = {
  "<agent-name>": agentName,
  "<display-name>": displayName,
  "<runtime-image>": runtimeImage,
};
const cpuMemoryPatch = { cpu, memory };

for (const target of targets) {
  await writeTarget(target, substitutions, cpuMemoryPatch);
}

console.log("");
console.log(`pi-foundry bootstrap complete for ${agentName}.`);

const harness = inferHarnessFromRuntimeImage(runtimeImage);
if (harness === "unknown") {
  console.log(`note: could not infer the harness from "${runtimeImage}"; ensure the image bakes ENV HARNESS=pi or copilot (pi-foundry-runtime = pi, ghcp-foundry-runtime = copilot).`);
} else {
  console.log(`harness: ${harness} (from runtime image)`);
}

console.log("Next:");
console.log("  1. node <skill>/scripts/configure-env.mjs --env-name <env> --agent-name <name> --model <model> ...");
console.log("  2. azd deploy");
console.log("  3. node <skill>/scripts/verify.mjs");

// ---------------------------------------------------------------------------

function sanitize(value) {
  if (!value) return undefined;
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function defaultDisplayName(name) {
  return name.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function guardCwdIsNotSkillRepo() {
  // Refuse to bootstrap inside the pi-foundry source checkout itself.
  if (await exists("Dockerfile.runtime") && await exists(".agents/skills/pi-foundry/SKILL.md")) {
    throw new Error("Current directory looks like the pi-foundry source repo. Run bootstrap from the user's Pi agent repo instead.");
  }
}

async function writeTarget(target, substitutions, cpuMemoryPatch) {
  const templatePath = join(TEMPLATES_DIR, target.template);
  let content = await readFile(templatePath, "utf8");

  for (const [from, to] of Object.entries(substitutions)) {
    content = content.split(from).join(to);
  }

  // Patch cpu/memory in azure.yaml and agent.yaml when non-default.
  if ((target.path === "azure.yaml" || target.path === "agent.yaml") && (cpuMemoryPatch.cpu !== "2" || cpuMemoryPatch.memory !== "4Gi")) {
    content = content
      .replace(/cpu:\s*"2"/g, `cpu: "${cpuMemoryPatch.cpu}"`)
      .replace(/memory:\s*4Gi/g, `memory: ${cpuMemoryPatch.memory}`);
  }

  if (await exists(target.path)) {
    if (!args.force) {
      throw new Error(`${target.path} already exists. Re-run with --force after user confirmation. (Will back up to ${target.path}.bak.<ts>)`);
    }
    const backup = `${target.path}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(target.path, backup);
    console.log(`backed up existing ${target.path} -> ${backup}`);
  }

  await mkdir(dirname(resolve(target.path)) || ".", { recursive: true });
  await writeFile(target.path, content);
  console.log(`wrote ${target.path}`);
}
