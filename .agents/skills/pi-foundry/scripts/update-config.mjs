#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";

const CONFIG_PATH = ".azd/pi-foundry/pi-foundry.yaml";

function usage() {
  console.error(`Usage: update-config.mjs [options]\n\nUpdates .azd/pi-foundry/pi-foundry.yaml and renders generated files.\n\nOptions:\n  --agent-name <name>\n  --display-name <name>\n  --description <text>\n  --runtime-image <image>\n  --cpu <value>\n  --memory <value>\n  --docker-image <name>\n  --docker-tag <tag>\n  --model <model>                 Also updates pi.args --model value.\n  --artifact-mode <disabled|static-web>\n  --diagnostics <true|false>\n  --no-render\n`);
}

function parseArgs(argv) {
  const result = { render: true, values: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--no-render") {
      result.render = false;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    index += 1;
    result.values[key] = value;
  }
  return result;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultConfig() {
  return `version: 1

agent:
  name: CHANGE_ME
  displayName: Change Me
  description: Foundry Hosted Agent deployment adapter for an existing Pi agent repo.

runtime:
  image: crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0
  startupCommand: /app/runtime/official-invocations/entrypoint.sh

container:
  cpu: "2"
  memory: 4Gi

docker:
  image: CHANGE_ME
  tag: latest
  remoteBuild: true

pi:
  provider: foundry
  model: <foundry-model-or-deployment>
  args:
    - --mode
    - rpc
    - --no-session
    - --provider
    - foundry
    - --model
    - <foundry-model-or-deployment>

artifacts:
  mode: disabled
  manifest: artifact-manifest.json

diagnostics:
  enabled: false
`;
}

function quoteIfNeeded(value) {
  if (/^(true|false|[0-9]+(\.[0-9]+)?|[A-Za-z0-9_.:/@$<>-]+)$/.test(value) && !value.includes(":")) return value;
  return JSON.stringify(value);
}

function setScalar(text, section, key, value) {
  const lines = text.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => line.trim() === `${section}:`);
  if (sectionIndex === -1) throw new Error(`Missing section: ${section}`);
  const sectionIndent = lines[sectionIndex].match(/^\s*/)?.[0].length ?? 0;
  let insertAt = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= sectionIndent) {
      insertAt = index;
      break;
    }
    if (line.match(new RegExp(`^\\s{${sectionIndent + 2}}${key}:\\s*`))) {
      lines[index] = `${" ".repeat(sectionIndent + 2)}${key}: ${quoteIfNeeded(value)}`;
      return lines.join("\n");
    }
  }
  lines.splice(insertAt, 0, `${" ".repeat(sectionIndent + 2)}${key}: ${quoteIfNeeded(value)}`);
  return lines.join("\n");
}

function updatePiModelArg(text, model) {
  const lines = text.split(/\r?\n/);
  const piIndex = lines.findIndex((line) => line.trim() === "pi:");
  if (piIndex === -1) return text;
  const argsIndex = lines.findIndex((line, index) => index > piIndex && line.match(/^\s{2}args:\s*$/));
  if (argsIndex === -1) return text;
  let modelFlagIndex = -1;
  for (let index = argsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= 2) break;
    if (line.trim() === "- --model") {
      modelFlagIndex = index;
      break;
    }
  }
  if (modelFlagIndex !== -1 && lines[modelFlagIndex + 1]?.match(/^\s*-\s+/)) {
    lines[modelFlagIndex + 1] = `    - ${model}`;
  }
  return lines.join("\n");
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: "inherit", timeout: 120000 });
}

const { values, render } = parseArgs(process.argv.slice(2));
if (!(await exists(".azd/pi-foundry"))) throw new Error(".azd/pi-foundry not found. Initialize the pi-foundry adapter first.");
await mkdir(".azd/pi-foundry", { recursive: true });
let text = (await exists(CONFIG_PATH)) ? await readFile(CONFIG_PATH, "utf8") : defaultConfig();

const mapping = {
  "agent-name": ["agent", "name"],
  "display-name": ["agent", "displayName"],
  description: ["agent", "description"],
  "runtime-image": ["runtime", "image"],
  cpu: ["container", "cpu"],
  memory: ["container", "memory"],
  "docker-image": ["docker", "image"],
  "docker-tag": ["docker", "tag"],
  model: ["pi", "model"],
  "artifact-mode": ["artifacts", "mode"],
  diagnostics: ["diagnostics", "enabled"],
};

for (const [argName, value] of Object.entries(values)) {
  const target = mapping[argName];
  if (!target) throw new Error(`Unknown option --${argName}`);
  text = setScalar(text, target[0], target[1], value);
  if (argName === "agent-name" && !values["docker-image"]) text = setScalar(text, "docker", "image", value);
  if (argName === "model") text = updatePiModelArg(text, value);
}

await writeFile(CONFIG_PATH, text.endsWith("\n") ? text : `${text}\n`);
console.log(`updated ${CONFIG_PATH}`);

if (render) run("node", [".azd/pi-foundry/render.mjs"]);
