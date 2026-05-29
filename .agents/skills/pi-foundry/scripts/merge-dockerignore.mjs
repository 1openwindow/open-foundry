#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PATH = ".dockerignore";
const BEGIN = "# BEGIN pi-foundry managed block";
const END = "# END pi-foundry managed block";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const block = (await readFile(join(scriptDir, "../assets/adapter/dockerignore.block"), "utf8")).trimEnd();

const checkOnly = process.argv.includes("--check");

async function readExisting() {
  try {
    return await readFile(PATH, "utf8");
  } catch {
    return "";
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function merge(existing) {
  const normalized = existing.replace(/\r\n/g, "\n");
  const pattern = new RegExp(`${escapeRegex(BEGIN)}[\\s\\S]*?${escapeRegex(END)}`, "m");
  if (pattern.test(normalized)) return normalized.replace(pattern, block).replace(/\s*$/, "\n");
  const prefix = normalized.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${block}\n`;
}

const existing = await readExisting();
const next = merge(existing);

if (checkOnly) {
  if (existing.replace(/\r\n/g, "\n") !== next) {
    console.error(`${PATH} is missing or has an outdated pi-foundry managed block`);
    process.exitCode = 1;
  } else {
    console.log(`${PATH} pi-foundry managed block is up to date`);
  }
} else {
  await writeFile(PATH, next);
  console.log(`updated ${PATH} pi-foundry managed block`);
}
