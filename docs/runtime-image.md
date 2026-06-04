# open-foundry runtime images

The runtime images are the **versioned contract product** of this repo. The
skill-managed deployment expects a published runtime image referenced from the
user repo's thin Dockerfile:

```dockerfile
ARG OPEN_FOUNDRY_RUNTIME_IMAGE=<acr>.azurecr.io/pi-foundry-runtime:<tag>
FROM ${OPEN_FOUNDRY_RUNTIME_IMAGE}

WORKDIR /app
COPY . /workspace
```

The image name is the harness selector:

| Image | Harness | Contents | Model auth |
|---|---|---|---|
| `pi-foundry-runtime:<tag>` | `pi` | pi-coding-agent + pi adapter | API key or managed identity |
| `ghcp-foundry-runtime:<tag>` | `copilot` | GitHub Copilot SDK + Copilot adapter | API key only |

The skill's `bootstrap.mjs` writes that Dockerfile but does **not** ship a
private default image. Use the public GHCR image for trials, or publish your own
to a registry your Foundry project can pull from.

## What is in the image

`Dockerfile.runtime` is multi-stage: a shared `base` plus one thin stage per
harness, selected with `docker build --target pi|copilot`. Each image bakes
`ENV HARNESS=<value>`, so there is no separate `HARNESS` setting to put in `azd`
env, `agent.yaml`, or `agent.manifest.yaml`.

Both images include:

- Node invocations host (`src/backend.mjs`) — the single Foundry-facing
  process; serves `GET /readiness` and `POST /invocations` directly on `PORT`
  (default `8088`). There is no separate Python host or internal proxy port.
- `open-foundry` CLI (`/usr/local/bin/open-foundry`) wrapping `src/cli.mjs`
- `/app/src` (contract.mjs, cli.mjs, backend.mjs, adapters, runtime helpers)

Harness-specific contents are intentionally separate. `package.json` carries
only shared runtime deps; each harness stage installs its own agent:

- `pi-foundry-runtime` installs `@earendil-works/pi-coding-agent` only.
- `ghcp-foundry-runtime` installs `@github/copilot-sdk` / Copilot CLI runtime
  only.

The runtime image deliberately does **not** include user agent assets
(`.agents/skills`, prompts, MCP config, workspace). Those come from the user repo
and are layered into `/workspace` by the thin adapter Dockerfile bootstrapped
into that repo.

## Self-describing contract

Inside the image, two commands surface the runtime contract without booting
the backend:

```bash
open-foundry contract    # full env / tier / reserved-prefix contract as JSON
open-foundry doctor      # validate current env; exit 1 on missing required vars (redacts secrets)
open-foundry version
```

The contract is the same data structure consumed by `src/backend.mjs` for
startup fail-fast validation and by `.agents/skills/open-foundry/references/contract.json`
for the skill. The skill's JSON is regenerated from `src/contract.mjs` via
`npm run emit:contract`, so there is one source of truth.

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

## Smoke locally (requires Docker)

```bash
OPEN_FOUNDRY_RUNTIME_IMAGE=pi-foundry-runtime:local npm run runtime:smoke
OPEN_FOUNDRY_RUNTIME_IMAGE=ghcp-foundry-runtime:local npm run runtime:smoke
```

The smoke test runs the container with `OF_MOCK=1`, mounts a throwaway
tempdir as `/workspace` (override with `WORKSPACE=<path>` to point at a real
agent workspace), polls `/readiness`, and posts a mock invocation.

## Build remotely with ACR (no local Docker required)

Use `az acr build` directly against this repo and `Dockerfile.runtime`.

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

Requires `az login` and AcrPush on the target registry.

## Publish

Tag and push each runtime image to the registry your Foundry project can pull
from:

```bash
docker push <acr>.azurecr.io/pi-foundry-runtime:<tag>
docker push <acr>.azurecr.io/ghcp-foundry-runtime:<tag>
```

Or, for a non-ACR registry:

```bash
OPEN_FOUNDRY_RUNTIME_IMAGE=ghcr.io/<org>/pi-foundry-runtime:<tag> npm run runtime:build
docker push ghcr.io/<org>/pi-foundry-runtime:<tag>

docker build --pull=false --target copilot -f Dockerfile.runtime -t ghcr.io/<org>/ghcp-foundry-runtime:<tag> .
docker push ghcr.io/<org>/ghcp-foundry-runtime:<tag>
```

If users will rely on ACR remote builds via `azd deploy`, make sure the registry
holding the runtime image is one the Foundry agent identities have `AcrPull`
on. The skill's `bootstrap.mjs --runtime-image <ref>` is where that reference
lands; users can change it at any time by editing `Dockerfile`.

## Publish via GitHub Actions (GHCR)

`.github/workflows/runtime-image.yml` builds `Dockerfile.runtime` twice and
pushes both image names:

- `ghcr.io/<owner>/pi-foundry-runtime`
- `ghcr.io/<owner>/ghcp-foundry-runtime`

Triggers:

- Push a tag `v<X.Y.Z>` → publishes `:<X.Y.Z>`, `:<X.Y>`, and `:latest` on both images.
- `workflow_dispatch` → publishes `:sha-<short>` and `:manual-<run-number>` on both images (never `:latest`).

`fail-fast` is off, so a break in one harness never cancels the other's
build or publish.

```bash
git tag v0.1.0
git push origin v0.1.0
```

**Gotcha — the workflow file must already exist on the default branch before the
tag push.** GitHub only runs a workflow for a tag if that workflow is present in
the commit the tag points at *and* reachable from the default branch. If you add
`runtime-image.yml` on a feature branch and push a tag from there, **no run is
triggered**. Fix: merge the workflow to `main` first, then (re)create and push
the tag:

```bash
git checkout main && git merge --ff-only <branch> && git push origin main
git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0   # if the tag already existed
git tag v0.1.0 && git push origin v0.1.0
```

**Make both packages public** so Foundry (or anyone) can pull without auth:
GitHub → your profile/org → Packages → `pi-foundry-runtime` and
`ghcp-foundry-runtime` → Package settings → Change visibility → Public. Verify
anonymously:

```bash
docker logout ghcr.io && docker pull ghcr.io/<owner>/pi-foundry-runtime:<tag>
docker logout ghcr.io && docker pull ghcr.io/<owner>/ghcp-foundry-runtime:<tag>
```


## Versioning

`pi-foundry-runtime:<tag>` and `ghcp-foundry-runtime:<tag>` are the contract
surfaces. Breaking changes to env contracts or SSE shape should bump the tag.
The skill's `references/contract.json` should be regenerated. Users choose the
runtime image with `bootstrap.mjs --runtime-image <ref>`; there is no in-skill
private default.
