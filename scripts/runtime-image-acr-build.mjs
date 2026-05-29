#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const API_VERSION = "2019-06-01-preview";
const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  npm run runtime:acr-build -- [--registry <registry>.azurecr.io] [--image pi-foundry-runtime:0.1.0] [--dockerfile Dockerfile.runtime]

Queues an Azure Container Registry remote build for the pi-foundry runtime image using azd auth.
This does not require a local Docker daemon.`;
}

function parseArgs(argv) {
  const result = {
    registry: undefined,
    image: process.env.PI_FOUNDRY_RUNTIME_REPOSITORY_TAG || "pi-foundry-runtime:0.1.0",
    dockerfile: process.env.PI_FOUNDRY_RUNTIME_DOCKERFILE || "Dockerfile.runtime",
    noWait: false,
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
    else if (arg === "--registry") result.registry = next();
    else if (arg.startsWith("--registry=")) result.registry = arg.slice("--registry=".length);
    else if (arg === "--image") result.image = next();
    else if (arg.startsWith("--image=")) result.image = arg.slice("--image=".length);
    else if (arg === "--dockerfile") result.dockerfile = next();
    else if (arg.startsWith("--dockerfile=")) result.dockerfile = arg.slice("--dockerfile=".length);
    else if (arg === "--no-wait") result.noWait = true;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return result;
}

function command(commandName, commandArgs, options = {}) {
  if (options.log !== false) console.error(`$ ${[commandName, ...commandArgs].join(" ")}`);
  return execFileSync(commandName, commandArgs, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8",
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function azdEnvValue(name) {
  try {
    return command("azd", ["env", "get-value", name], { log: false }).trim().replace(/^['\"]|['\"]$/g, "");
  } catch {
    return undefined;
  }
}

function token() {
  const text = command("azd", ["auth", "token", "--scope", "https://management.azure.com/.default", "--output", "json"], { log: false });
  return JSON.parse(text).token;
}

async function arm(method, pathOrUrl, body, accessToken) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `https://management.azure.com${pathOrUrl}`;
  const headers = { Authorization: `Bearer ${accessToken}` };
  let bodyText;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyText = JSON.stringify(body);
  }
  const response = await fetch(url, { method, headers, body: bodyText });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!response.ok) {
    throw new Error(`${method} ${url} failed: HTTP ${response.status}\n${JSON.stringify(json, null, 2)}`);
  }
  return { json, headers: response.headers };
}

async function findRegistry(accessToken, subscriptionId, loginServer) {
  const registryName = loginServer.replace(/\.azurecr\.io$/i, "");
  const { json } = await arm("GET", `/subscriptions/${subscriptionId}/providers/Microsoft.ContainerRegistry/registries?api-version=2023-01-01-preview`, undefined, accessToken);
  const match = json.value?.find((item) => item.name.toLowerCase() === registryName.toLowerCase() || item.properties?.loginServer?.toLowerCase() === loginServer.toLowerCase());
  if (!match) throw new Error(`Could not find ACR ${loginServer} in subscription ${subscriptionId}`);
  return match;
}

async function uploadContext(uploadUrl, tarPath) {
  command("curl", ["-fsS", "-X", "PUT", "-H", "x-ms-blob-type: BlockBlob", "--data-binary", `@${tarPath}`, uploadUrl], { capture: false });
}

async function main() {
  if (args.help) {
    console.log(usage());
    return;
  }

  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID || azdEnvValue("AZURE_SUBSCRIPTION_ID");
  const registry = args.registry || process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT || azdEnvValue("AZURE_CONTAINER_REGISTRY_ENDPOINT");
  if (!subscriptionId) throw new Error("AZURE_SUBSCRIPTION_ID not found in env or azd env");
  if (!registry) throw new Error("Registry not provided. Use --registry <registry>.azurecr.io or set AZURE_CONTAINER_REGISTRY_ENDPOINT");

  const accessToken = token();
  const acr = await findRegistry(accessToken, subscriptionId, registry);
  const registryId = acr.id;

  console.error("ACR remote runtime build");
  console.error(`Registry:   ${acr.properties.loginServer}`);
  console.error(`Image:      ${args.image}`);
  console.error(`Dockerfile: ${args.dockerfile}`);
  console.error(`ACR id:     ${registryId}`);

  const temp = await mkdtemp(join(tmpdir(), "pi-foundry-acr-build-"));
  const tarPath = join(temp, "context.tar.gz");
  try {
    command("tar", [
      "--exclude=.git",
      "--exclude=.azure",
      "--exclude=.files",
      "--exclude=node_modules",
      "--exclude=dist",
      "--exclude=build",
      "-czf",
      tarPath,
      ".",
    ], { cwd: resolve("."), capture: false });

    const upload = await arm("POST", `${registryId}/listBuildSourceUploadUrl?api-version=${API_VERSION}`, {}, accessToken);
    const uploadUrl = upload.json.uploadUrl;
    const relativePath = upload.json.relativePath;
    if (!uploadUrl || !relativePath) throw new Error(`Unexpected upload URL response: ${JSON.stringify(upload.json, null, 2)}`);

    console.error("Uploading build context to ACR staging storage...");
    await uploadContext(uploadUrl, tarPath);

    const request = {
      type: "DockerBuildRequest",
      isArchiveEnabled: true,
      imageNames: [args.image],
      sourceLocation: relativePath,
      dockerFilePath: args.dockerfile,
      platform: { os: "Linux", architecture: "amd64" },
    };

    const run = await arm("POST", `${registryId}/scheduleRun?api-version=${API_VERSION}`, request, accessToken);
    console.log(JSON.stringify(run.json, null, 2));
    const runId = run.json.name || run.json.id?.split("/").pop();
    if (runId) {
      console.error(`Queued ACR build run: ${runId}`);
      console.error(`Inspect logs with Azure Portal or az acr task logs if available.`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
