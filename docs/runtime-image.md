# pi-foundry runtime image

The azd-native adapter expects a versioned runtime base image. The user's repo should not vendor pi-foundry runtime source; it should use a thin Dockerfile:

```dockerfile
ARG PI_FOUNDRY_RUNTIME_IMAGE=ghcr.io/1openwindow/pi-foundry-runtime:0.1.0
FROM ${PI_FOUNDRY_RUNTIME_IMAGE}

WORKDIR /app
COPY . /workspace
```

## Build locally

```bash
PI_FOUNDRY_RUNTIME_IMAGE=pi-foundry-runtime:local npm run runtime:build
```

## Smoke test locally

```bash
PI_FOUNDRY_RUNTIME_IMAGE=pi-foundry-runtime:local npm run runtime:smoke
```

The smoke test runs the runtime container with `PI_MOCK=1`, mounts `demo-workspace` as `/workspace`, checks `/readiness`, and posts a mock invocation.

## Build remotely with ACR

When a local Docker daemon is not available, queue an Azure Container Registry remote build using `azd auth`:

```bash
npm run runtime:acr-build -- \
  --registry <registry>.azurecr.io \
  --image pi-foundry-runtime:0.1.0
```

The script uploads the current repo as an ACR build context, uses `Dockerfile.runtime`, and queues an ACR Docker build. It requires `AZURE_SUBSCRIPTION_ID` and `AZURE_CONTAINER_REGISTRY_ENDPOINT` in the active `azd` environment, or explicit `--registry`.

Validated build:

```text
Registry: crce6hg4ngzj3as.azurecr.io
Image:    pi-foundry-runtime:0.1.0
Run:      chh
Digest:   sha256:d2480ca47d4c4e37af69db1f9eca930108fcbabb062a9ade39cc704f6e1e9416
Status:   Succeeded
```

## Publish

Tag the image for the target registry and push it with Docker or your registry tooling:

```bash
PI_FOUNDRY_RUNTIME_IMAGE=ghcr.io/1openwindow/pi-foundry-runtime:0.1.0 npm run runtime:build
docker push ghcr.io/1openwindow/pi-foundry-runtime:0.1.0
```

For ACR:

```bash
PI_FOUNDRY_RUNTIME_IMAGE=<registry>.azurecr.io/pi-foundry-runtime:0.1.0 npm run runtime:build
docker push <registry>.azurecr.io/pi-foundry-runtime:0.1.0
```

If users rely on ACR remote builds, make sure their adapter Dockerfile points to a registry image accessible from the remote builder.

## Contents

`Dockerfile.runtime` includes:

- official `azure-ai-agentserver-invocations` Python host
- Node Pi backend
- pi CLI
- runtime dependencies
- `/app/src` and `/app/runtime`

It intentionally does not include user-owned Pi agent assets such as `.agents/skills`, prompts, MCP config, or demo workspace. Those come from the user's repo and are copied to `/workspace` by the thin adapter Dockerfile.
