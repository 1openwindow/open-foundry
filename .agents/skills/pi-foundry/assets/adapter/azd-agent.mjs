#!/usr/bin/env node
// Managed by the pi-foundry skill.
// Runs azd with pi-foundry's generated agent definition path.
//
// azd package honors AGENT_DEFINITION_PATH. Current azd azure.ai.agents deploy
// still reads agent.yaml from the service root during its predeploy hook, so for
// deploy only we materialize temporary root mirrors and restore/delete them when
// azd exits. The source of truth remains .azd/pi-foundry/pi-foundry.yaml and the
// generated agent files remain under .azd/pi-foundry/generated/.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const AGENT_DEFINITION_PATH = ".azd/pi-foundry/generated/agent.yaml";
const AGENT_MANIFEST_PATH = ".azd/pi-foundry/generated/agent.manifest.yaml";
const ROOT_AGENT_PATH = "agent.yaml";
const ROOT_MANIFEST_PATH = "agent.manifest.yaml";

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.error("Usage: azd-agent.mjs <azd-command> [args...]\n\nExample:\n  node .azd/pi-foundry/azd-agent.mjs package --all");
  process.exit(args.length === 0 ? 2 : 0);
}

function snapshot(path) {
  return existsSync(path) ? { existed: true, content: readFileSync(path, "utf8") } : { existed: false, content: undefined };
}

function restore(path, state) {
  if (state.existed) writeFileSync(path, state.content, "utf8");
  else if (existsSync(path)) unlinkSync(path);
}

function materializeRootAgentFiles() {
  const rootAgent = snapshot(ROOT_AGENT_PATH);
  const rootManifest = snapshot(ROOT_MANIFEST_PATH);
  writeFileSync(ROOT_AGENT_PATH, readFileSync(AGENT_DEFINITION_PATH, "utf8"), "utf8");
  writeFileSync(ROOT_MANIFEST_PATH, readFileSync(AGENT_MANIFEST_PATH, "utf8"), "utf8");
  return () => {
    restore(ROOT_AGENT_PATH, rootAgent);
    restore(ROOT_MANIFEST_PATH, rootManifest);
  };
}

let cleanup = () => {};
if (args[0] === "deploy") cleanup = materializeRootAgentFiles();

try {
  const result = spawnSync("azd", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      AGENT_DEFINITION_PATH: process.env.AGENT_DEFINITION_PATH || AGENT_DEFINITION_PATH,
    },
  });

  if (result.error) {
    console.error(result.error instanceof Error ? result.error.message : String(result.error));
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 0;
  }
} finally {
  cleanup();
}
