# pi-foundry runtime image

`pi-foundry-runtime` is the **versioned contract product** of this repo. The
skill-managed deployment expects a published runtime image referenced from the
user repo's thin Dockerfile:

```dockerfile
ARG PI_FOUNDRY_RUNTIME_IMAGE=<acr>.azurecr.io/pi-foundry-runtime:<tag>
FROM ${PI_FOUNDRY_RUNTIME_IMAGE}

WORKDIR /app
COPY . /workspace
```

The skill's `bootstrap.mjs` writes that Dockerfile but does **not** ship a
default image. You publish your own to an ACR your Foundry project can pull
from.

## What is in the image

`Dockerfile.runtime` includes:

- Node Pi invocations host (`src/backend.mjs`) — the single Foundry-facing
  process; serves `GET /readiness` and `POST /invocations` directly on `PORT`
  (default `8088`). There is no separate Python host or internal proxy port.
- `pi` CLI (`@earendil-works/pi-coding-agent`)
- `pi-foundry` CLI (`/usr/local/bin/pi-foundry`) wrapping `src/cli.mjs`
- `/app/src` (contract.mjs, cli.mjs, backend.mjs, adapters, runtime helpers)

It deliberately does **not** include user Pi agent assets (`.agents/skills`,
prompts, MCP config, workspace). Those come from the user repo and are layered
into `/workspace` by the thin adapter Dockerfile bootstrapped into that repo.

## Self-describing contract

Inside the image, two commands surface the runtime contract without booting
the backend:

```bash
pi-foundry contract    # full env / tier / reserved-prefix contract as JSON
pi-foundry doctor      # validate current env; exit 1 on missing required vars (redacts secrets)
pi-foundry version
```

The contract is the same data structure consumed by `src/backend.mjs` for
startup fail-fast validation and by `.agents/skills/pi-foundry/references/contract.json`
for the skill. The skill's JSON is regenerated from `src/contract.mjs` via
`npm run emit:contract`, so there is one source of truth.

## Build locally (requires Docker)

```bash
PI_FOUNDRY_RUNTIME_IMAGE=pi-foundry-runtime:local npm run runtime:build
```

## Smoke locally (requires Docker)

```bash
PI_FOUNDRY_RUNTIME_IMAGE=pi-foundry-runtime:local npm run runtime:smoke
```

The smoke test runs the container with `PI_MOCK=1`, mounts a throwaway
tempdir as `/workspace` (override with `WORKSPACE=<path>` to point at a real
agent workspace), polls `/readiness`, and posts a mock invocation.

## Build remotely with ACR (no local Docker required)

Use `az acr build` directly against this repo and `Dockerfile.runtime`:

```bash
az acr build \
  --registry <acr> \
  --image pi-foundry-runtime:<tag> \
  --file Dockerfile.runtime \
  .
```

Requires `az login` and AcrPush on the target registry.

## Publish

Tag and push to the registry your Foundry project can pull from:

```bash
docker push <acr>.azurecr.io/pi-foundry-runtime:<tag>
```

Or, for a non-ACR registry:

```bash
PI_FOUNDRY_RUNTIME_IMAGE=ghcr.io/<org>/pi-foundry-runtime:<tag> npm run runtime:build
docker push ghcr.io/<org>/pi-foundry-runtime:<tag>
```

If users will rely on ACR remote builds via `azd deploy`, make sure the registry
holding the runtime image is one the Foundry agent identities have `AcrPull`
on. The skill's `bootstrap.mjs --runtime-image <ref>` is where that reference
lands; users can change it at any time by editing `Dockerfile`.

## Versioning

`pi-foundry-runtime:<tag>` is the contract surface. Breaking changes to env
contracts or SSE shape should bump the tag. The
skill's `references/contract.json` should be regenerated and the new image
referenced from `bootstrap.mjs` defaults (currently: user supplies on every
deploy; no in-skill default).
