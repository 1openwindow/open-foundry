#!/usr/bin/env node
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const templateRoot = resolve("templates/azd-native");

function usage() {
  return `Usage:
  npm run install:azd-adapter -- --target <existing-pi-agent-repo> --name <agent-name> [--acr <registry>] [--runtime-image <image>] [--dry-run] [--overwrite]

Installs the thin azd-native pi-foundry adapter into an existing Pi agent repo.
It adds deployment configuration only; it does not copy pi-foundry runtime source and does not modify agent business code.`;
}

function parseArgs(argv) {
  const result = {
    target: ".",
    name: undefined,
    acr: undefined,
    runtimeImage: undefined,
    dryRun: false,
    overwrite: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--target") result.target = next();
    else if (arg.startsWith("--target=")) result.target = arg.slice("--target=".length);
    else if (arg === "--name") result.name = next();
    else if (arg.startsWith("--name=")) result.name = arg.slice("--name=".length);
    else if (arg === "--acr") result.acr = next();
    else if (arg.startsWith("--acr=")) result.acr = arg.slice("--acr=".length);
    else if (arg === "--runtime-image") result.runtimeImage = next();
    else if (arg.startsWith("--runtime-image=")) result.runtimeImage = arg.slice("--runtime-image=".length);
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--overwrite") result.overwrite = true;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return result;
}

function expandHome(path) {
  if (path === "~") return process.env.HOME;
  if (path?.startsWith("~/")) return `${process.env.HOME}${path.slice(1)}`;
  return path;
}

function validateAgentName(name) {
  if (!name) throw new Error("--name is required\n\n" + usage());
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
    throw new Error("--name must be a valid azd app/service name: lowercase letters, numbers, and hyphens; start/end with letter or number");
  }
}

function displayName(name) {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeTemplatedFile(sourceRel, targetRel, replacements) {
  const source = resolve(templateRoot, sourceRel);
  const target = resolve(args.targetAbs, targetRel);
  const alreadyExists = await exists(target);
  const action = alreadyExists ? (args.overwrite ? "overwrite" : "skip") : "create";
  console.log(`${args.dryRun ? "would " : ""}${action} ${targetRel}`);
  if (args.dryRun || action === "skip") return;

  let content = await readFile(source, "utf8");
  for (const [key, value] of Object.entries(replacements)) content = content.split(key).join(value);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function copyStaticFile(sourceRel, targetRel) {
  const source = resolve(templateRoot, sourceRel);
  const target = resolve(args.targetAbs, targetRel);
  const alreadyExists = await exists(target);
  const action = alreadyExists ? (args.overwrite ? "overwrite" : "skip") : "create";
  console.log(`${args.dryRun ? "would " : ""}${action} ${targetRel}`);
  if (args.dryRun || action === "skip") return;

  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { force: true });
}

async function main() {
  if (args.help) {
    console.log(usage());
    return;
  }
  validateAgentName(args.name);
  args.targetAbs = resolve(expandHome(args.target));

  if (!(await exists(templateRoot))) throw new Error(`Missing template directory: ${templateRoot}`);
  if (!(await exists(args.targetAbs))) throw new Error(`Target repo does not exist: ${args.targetAbs}`);

  const image = args.acr ? `${args.acr.replace(/\/$/, "")}/${args.name}:latest` : `example.azurecr.io/${args.name}:latest`;
  const replacements = {
    __AGENT_NAME__: args.name,
    __DISPLAY_NAME__: displayName(args.name),
    __CONTAINER_IMAGE__: image,
  };

  console.log(`${args.dryRun ? "Would install" : "Installing"} pi-foundry azd-native adapter`);
  console.log(`Target: ${args.targetAbs}`);
  console.log(`Name:   ${args.name}`);
  if (args.acr) console.log(`ACR:    ${args.acr}`);
  if (args.runtimeImage) console.log(`Runtime image: ${args.runtimeImage}`);
  console.log("\nNo agent business-code files will be modified. Existing files are skipped unless --overwrite is supplied.\n");

  await writeTemplatedFile("azure.yaml", "azure.yaml", replacements);
  await writeTemplatedFile("agent.yaml", "agent.yaml", replacements);
  await writeTemplatedFile("agent.manifest.yaml", "agent.manifest.yaml", replacements);
  await copyStaticFile(".dockerignore", ".dockerignore");
  await copyStaticFile(".azd/pi-foundry/README.md", ".azd/pi-foundry/README.md");
  await copyStaticFile(".azd/pi-foundry/doctor.mjs", ".azd/pi-foundry/doctor.mjs");
  await copyStaticFile(".azd/pi-foundry/postdeploy.mjs", ".azd/pi-foundry/postdeploy.mjs");

  if (args.runtimeImage) {
    const sourceRel = ".azd/pi-foundry/Dockerfile";
    const source = resolve(templateRoot, sourceRel);
    const target = resolve(args.targetAbs, sourceRel);
    const alreadyExists = await exists(target);
    const action = alreadyExists ? (args.overwrite ? "overwrite" : "skip") : "create";
    console.log(`${args.dryRun ? "would " : ""}${action} ${sourceRel}`);
    if (!args.dryRun && action !== "skip") {
      let content = await readFile(source, "utf8");
      content = content.replace("ghcr.io/1openwindow/pi-foundry-runtime:0.1.0", args.runtimeImage);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
  } else {
    await copyStaticFile(".azd/pi-foundry/Dockerfile", ".azd/pi-foundry/Dockerfile");
  }

  console.log("\nNext steps:");
  console.log(`  cd ${args.targetAbs}`);
  console.log("  azd env new <env-name>");
  console.log("  azd env set PI_MOCK 0");
  console.log("  azd env set REQUEST_TIMEOUT_MS 600000");
  console.log("  azd env set 'PI_ARGS=--mode rpc --no-session --provider foundry --model <model>'");
  console.log("  azd env set PI_OPENAI_BASE_URL 'https://<account>.cognitiveservices.azure.com/openai/v1'");
  console.log("  azd env set PI_OPENAI_MODEL '<model>'");
  console.log("  azd env set PI_OPENAI_API_KEY '<secret>'");
  console.log("  node .azd/pi-foundry/doctor.mjs");
  console.log("  azd up");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
