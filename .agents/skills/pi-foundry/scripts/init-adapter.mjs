#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
console.error("init-adapter.mjs is deprecated; use install-adapter.mjs. Forwarding...");
execFileSync("node", [join(scriptDir, "install-adapter.mjs"), ...process.argv.slice(2)], {
  encoding: "utf8",
  stdio: "inherit",
  timeout: 300000,
  env: process.env,
});
