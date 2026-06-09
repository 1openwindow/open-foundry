# open-foundry runtime images

> **Most users never build this.** The deploy skill points your repo at a
> ready-to-use runtime image — pick one from the table below and you're done. The
> rest of this page is for publishing or customizing your **own** runtime image.

## Pick an image

The image name is the harness selector — there is no separate `HARNESS` setting
to put in `azd` env, `agent.yaml`, or `agent.manifest.yaml`.

| Image | Harness | Contents | Model auth |
|---|---|---|---|
| `pi-foundry-runtime:<tag>` | `pi` | pi-coding-agent + pi adapter | API key or managed identity |
| `ghcp-foundry-runtime:<tag>` | `copilot` | GitHub Copilot SDK + Copilot adapter | API key only |
| `codex-foundry-runtime:<tag>` | `codex` | OpenAI Codex SDK + Codex adapter | API key only |

The skill's `bootstrap.mjs` writes a thin Dockerfile in your repo that pulls the
image you choose:

```dockerfile
ARG OPEN_FOUNDRY_RUNTIME_IMAGE=<acr>.azurecr.io/pi-foundry-runtime:<tag>
FROM ${OPEN_FOUNDRY_RUNTIME_IMAGE}

WORKDIR /app
COPY . /workspace
```

Use the public GHCR image as-is, or build your own (below) to a registry
your Foundry project can pull from. Your agent assets (`.agents/skills`, prompts,
MCP config, workspace) are **not** in the image — they come from your repo and
land in `/workspace`.

## Inspect an image

The runtime serves `GET /readiness` and `POST /invocations` on `PORT` (default
`8088`). Every image also self-describes its env contract without booting the
backend:

```bash
open-foundry contract    # env / tier / reserved-prefix contract as JSON
open-foundry doctor      # validate current env; exit 1 on missing required vars (secrets redacted)
open-foundry version
```

---

The sections below are only for **building and publishing your own image**.

## Build locally (requires Docker)

Build the Pi image:

```bash
OPEN_FOUNDRY_RUNTIME_IMAGE=pi-foundry-runtime:local npm run runtime:build
```

Build the GitHub Copilot image:

```bash
OPEN_FOUNDRY_RUNTIME_TARGET=copilot \
OPEN_FOUNDRY_RUNTIME_IMAGE=ghcp-foundry-runtime:local \
npm run runtime:build
```

Build the OpenAI Codex image:

```bash
OPEN_FOUNDRY_RUNTIME_TARGET=codex \
OPEN_FOUNDRY_RUNTIME_IMAGE=codex-foundry-runtime:local \
npm run runtime:build
```

## Smoke locally (requires Docker)

```bash
OPEN_FOUNDRY_RUNTIME_IMAGE=pi-foundry-runtime:local npm run runtime:smoke
OPEN_FOUNDRY_RUNTIME_IMAGE=ghcp-foundry-runtime:local npm run runtime:smoke
OPEN_FOUNDRY_RUNTIME_IMAGE=codex-foundry-runtime:local npm run runtime:smoke
```

Runs the container with `OF_MOCK=1`, mounts a throwaway tempdir as `/workspace`
(override with `WORKSPACE=<path>`), polls `/readiness`, and posts a mock
invocation.

## Build remotely with ACR (no local Docker required)

Requires `az login` and AcrPush on the target registry.

Build the Pi image:

```bash
az acr build \
  --registry <acr> \
  --image pi-foundry-runtime:<tag> \
  --target pi \
  --file Dockerfile.runtime \
  .
```

Build the GitHub Copilot image:

```bash
az acr build \
  --registry <acr> \
  --image ghcp-foundry-runtime:<tag> \
  --target copilot \
  --file Dockerfile.runtime \
  .
```

Build the OpenAI Codex image:

```bash
az acr build \
  --registry <acr> \
  --image codex-foundry-runtime:<tag> \
  --target codex \
  --file Dockerfile.runtime \
  .
```

## Publish

Tag and push each image to the registry your Foundry project can pull from:

```bash
docker push <acr>.azurecr.io/pi-foundry-runtime:<tag>
docker push <acr>.azurecr.io/ghcp-foundry-runtime:<tag>
docker push <acr>.azurecr.io/codex-foundry-runtime:<tag>
```

Or, for a non-ACR registry:

```bash
OPEN_FOUNDRY_RUNTIME_IMAGE=ghcr.io/<org>/pi-foundry-runtime:<tag> npm run runtime:build
docker push ghcr.io/<org>/pi-foundry-runtime:<tag>

OPEN_FOUNDRY_RUNTIME_TARGET=copilot OPEN_FOUNDRY_RUNTIME_IMAGE=ghcr.io/<org>/ghcp-foundry-runtime:<tag> npm run runtime:build
docker push ghcr.io/<org>/ghcp-foundry-runtime:<tag>

OPEN_FOUNDRY_RUNTIME_TARGET=codex OPEN_FOUNDRY_RUNTIME_IMAGE=ghcr.io/<org>/codex-foundry-runtime:<tag> npm run runtime:build
docker push ghcr.io/<org>/codex-foundry-runtime:<tag>
```

For `azd deploy` ACR remote builds, the registry holding the image must be one
your Foundry agent identities have `AcrPull` on. Change the image reference any
time by editing `Dockerfile`.

## Publish via GitHub Actions (GHCR)

`.github/workflows/runtime-image.yml` publishes every image name on a version
tag:

- `ghcr.io/<owner>/pi-foundry-runtime`
- `ghcr.io/<owner>/ghcp-foundry-runtime`
- `ghcr.io/<owner>/codex-foundry-runtime`

```bash
git tag v0.1.0
git push origin v0.1.0
```

- A version tag `v<X.Y.Z>` publishes `:<X.Y.Z>`, `:<X.Y>`, and `:latest`.
- `workflow_dispatch` publishes `:sha-<short>` and `:manual-<run-number>` (never `:latest`).
- Publishing is all-or-nothing: if any harness fails to build, nothing is
  published — so the images never drift apart in version.

The first time each package is published, confirm it is public so Foundry can
pull without auth (GitHub → Packages → the package → change visibility), then
verify anonymously:

```bash
docker logout ghcr.io && docker pull ghcr.io/<owner>/pi-foundry-runtime:<tag>
docker logout ghcr.io && docker pull ghcr.io/<owner>/ghcp-foundry-runtime:<tag>
docker logout ghcr.io && docker pull ghcr.io/<owner>/codex-foundry-runtime:<tag>
```

> The workflow must already be on the default branch before you push the tag, or
> no run triggers. If you just merged it, push `main` first, then create and push
> the tag.

## Versioning

`pi-foundry-runtime:<tag>`, `ghcp-foundry-runtime:<tag>`, and
`codex-foundry-runtime:<tag>` are the contract
surface: bump the tag on breaking changes to the env contract or SSE shape.
Choose the image with `bootstrap.mjs --runtime-image <ref>`.
