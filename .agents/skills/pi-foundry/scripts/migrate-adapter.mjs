#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  console.error(`Usage: migrate-adapter.mjs [options]\n\nUpdates pi-foundry deploy-time adapter files in the current user repo while preserving .azd/pi-foundry/pi-foundry.yaml.\n\nOptions:\n  --asset-dir <path>  Adapter asset directory. Defaults to this skill's assets/adapter.\n  --dry-run           Print planned changes without writing.\n  --no-render         Do not run render/check after copying adapter files.\n`);
}

function parseArgs(argv) {
  const values = { render: true, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      values.dryRun = true;
      continue;
    }
    if (arg === "--no-render") {
      values.render = false;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values[arg.slice(2)] = value;
    index += 1;
  }
  return values;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: "inherit", timeout: 120000, env: process.env });
}

async function copyWithBackup(source, target, backupDir, dryRun) {
  if (!(await exists(source))) throw new Error(`Adapter asset missing: ${source}`);
  const old = (await exists(target)) ? await readFile(target, "utf8") : undefined;
  const next = await readFile(source, "utf8");
  if (old === next) {
    console.log(`unchanged ${target}`);
    return;
  }
  if (dryRun) {
    console.log(`${old === undefined ? "would create" : "would update"} ${target}`);
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  if (old !== undefined) {
    const backupPath = join(backupDir, target.replaceAll("/", "__"));
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, old);
  }
  await copyFile(source, target);
  console.log(`${old === undefined ? "created" : "updated"} ${target}`);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const assetDir = resolve(args["asset-dir"] ?? join(scriptDir, "../assets/adapter"));

if (await exists("Dockerfile.runtime") && await exists(".agents/skills/pi-foundry")) {
  throw new Error("Current directory looks like the pi-foundry development checkout. Run migration from the user's existing Pi agent repo.");
}
if (!(await exists(".azd/pi-foundry"))) throw new Error(".azd/pi-foundry not found. Initialize the adapter first.");
if (!(await exists(".azd/pi-foundry/pi-foundry.yaml"))) throw new Error(".azd/pi-foundry/pi-foundry.yaml not found. Configure the adapter before migrating.");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = `.azd/pi-foundry/.migrations/${stamp}`;
const files = ["README.md", "render.mjs", "doctor.mjs", "postdeploy.mjs", "azd-agent.mjs"];

console.log(`Migrating pi-foundry adapter from ${assetDir}`);
for (const file of files) await copyWithBackup(join(assetDir, file), `.azd/pi-foundry/${file}`, backupDir, args.dryRun);

if (!args.dryRun && args.render) {
  run("node", [".azd/pi-foundry/render.mjs"]);
  run("node", [".azd/pi-foundry/render.mjs", "--check"]);
}

console.log(args.dryRun ? "pi-foundry adapter migration dry run complete" : "pi-foundry adapter migration complete");
