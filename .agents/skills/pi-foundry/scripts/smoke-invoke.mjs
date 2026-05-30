#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const values = { timeout: "900", message: "Say exactly: ok" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.error("Usage: smoke-invoke.mjs [--agent <name>] [--version <version>] [--timeout <seconds>] [--message <text>]");
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
  return execFileSync(command, args, { encoding: "utf8", stdio: options.stdio ?? ["ignore", "pipe", "pipe"], timeout: 120000 }).trim();
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

function readConfiguredAgentName() {
  try {
    const text = readFileSync(".azd/pi-foundry/pi-foundry.yaml", "utf8");
    return text.match(/^\s*name:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  } catch {
    return undefined;
  }
}

function findAgentOutputs(values, expectedName) {
  const entries = Object.entries(values).filter(([key, value]) => key.startsWith("AGENT_") && key.endsWith("_NAME") && (!expectedName || value === expectedName));
  const nameEntry = entries[0] ?? Object.entries(values).find(([key]) => key.startsWith("AGENT_") && key.endsWith("_NAME"));
  if (!nameEntry) return {};
  const prefix = nameEntry[0].slice(0, -"_NAME".length);
  return {
    name: nameEntry[1],
    version: values[`${prefix}_VERSION`],
  };
}

const args = parseArgs(process.argv.slice(2));
const env = parseEnvValues(run("azd", ["env", "get-values"]));
const outputs = findAgentOutputs(env, readConfiguredAgentName());
const agent = args.agent ?? outputs.name;
const version = args.version ?? outputs.version;

if (!agent) throw new Error("Agent name not provided and no AGENT_*_NAME output found in azd env");

const invokeArgs = ["ai", "agent", "invoke", agent, "--protocol", "invocations", "--new-session", "--timeout", args.timeout];
if (version) invokeArgs.push("--version", version);
invokeArgs.push(args.message);

console.error(`Invoking ${agent}${version ? ` v${version}` : ""}...`);
console.log(run("azd", invokeArgs));
