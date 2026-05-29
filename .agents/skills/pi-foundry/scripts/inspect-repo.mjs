#!/usr/bin/env node
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function command(commandName, args = []) {
  try {
    return execFileSync(commandName, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).trim();
  } catch {
    return undefined;
  }
}

async function listSkillNames() {
  if (!(await exists(".agents/skills"))) return [];
  try {
    const entries = await readdir(".agents/skills", { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

const cwd = process.cwd();
const skillNames = await listSkillNames();
const signals = {
  piFoundryCheckout: await exists("Dockerfile.runtime") && await exists(".agents/skills/pi-foundry"),
  adapted: await exists("azure.yaml") && await exists(".azd/pi-foundry/pi-foundry.yaml"),
  hasPiFoundryConfig: await exists(".azd/pi-foundry/pi-foundry.yaml"),
  hasRootAzureYaml: await exists("azure.yaml"),
  hasDockerignore: await exists(".dockerignore"),
  hasSkills: skillNames.length > 0,
  hasPrompts: await exists("prompts"),
  hasMcpConfig: await exists("mcp.config.json"),
  hasDemoWorkspace: await exists("demo-workspace"),
};

const looksLikeUserPiAgent = signals.hasSkills || signals.hasPrompts || signals.hasMcpConfig || signals.hasDemoWorkspace || signals.adapted;
const gitStatus = command("git", ["status", "--short"]);

const report = {
  cwd,
  type: signals.piFoundryCheckout ? "pi-foundry-development-checkout" : signals.adapted ? "adapted-pi-agent-repo" : looksLikeUserPiAgent ? "candidate-pi-agent-repo" : "unknown",
  signals,
  skillNames,
  git: {
    available: gitStatus !== undefined,
    dirty: Boolean(gitStatus),
    statusShort: gitStatus ?? "",
  },
  piFoundryOwnership: {
    rootFiles: ["azure.yaml", ".dockerignore"],
    adapterDir: ".azd/pi-foundry/",
    userOwnedExamples: [".agents/skills/", "prompts/", "mcp.config.json", "src/", "package.json", "README.md"],
  },
};

console.log(JSON.stringify(report, null, 2));
