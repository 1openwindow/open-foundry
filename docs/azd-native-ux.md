# azd-native UX direction

The next user-facing direction for `pi-foundry` is an **azd-native in-repo adapter**:

```text
Deploy your existing Pi agent to Foundry with azd.
No wrapper repo. No runtime vendoring. No changes to agent business code.
```

## Why

The earlier wrapper flow is technically safe, but it asks developers to reason about multiple repos:

```text
my-agent/
my-agent-foundry/
pi-foundry/
```

That is not the normal developer habit. Developers expect to stay inside their own repo and run the platform's deployment workflow:

```bash
cd my-agent
azd init --template <pi-foundry-azd-template> .
azd up
```

## UX vision

`pi-foundry` should become a Foundry deployment adapter for an existing Pi agent repo:

- the developer stays in their repo
- `azd` owns the lifecycle
- `azd up` is the canonical deploy command
- the adapter overrides the `up` workflow to run the adapter doctor, package, deploy, and postdeploy; it targets an existing Foundry project instead of provisioning new infrastructure
- pi-foundry runtime comes from a versioned base image
- the user's repo only gains deployment configuration
- user skills/prompts/MCP remain the source of truth in the same repo

## Files added by the adapter

The thin adapter adds deployment files only:

```text
azure.yaml
agent.yaml
agent.manifest.yaml
.dockerignore
.azd/pi-foundry/Dockerfile
.azd/pi-foundry/README.md
```

It does **not** add:

```text
src/server.mjs
runtime/official-invocations/
scripts/create-wrapper.mjs
scripts/import-pi-agent.mjs
```

## Current validation status

Validated on 2026-05-29:

- Runtime image built with ACR remote build: `crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0`
- Existing Pi agent repo adapted in place: `~/repos/media-report-agent`
- Hosted Agent deployed with `azd up`: `media-report-agent` version `3`
- Remote invoke succeeded with real model: output `ok`, `mock: false`
- Artifact demo succeeded and returned static website URLs under `media-report-agent/<date>/<request-id>/...`

The key UX result is that the user stayed in the existing Pi agent repo and deployed with `azd up`; no wrapper repo was required.

## Current prototype in this repo

The first prototype lives at:

```text
templates/azd-native/
```

It can be installed into an existing Pi agent repo from this development checkout with:

```bash
cd ~/repos/pi-foundry
npm run install:azd-adapter -- \
  --target ~/repos/my-agent \
  --name my-agent \
  --acr <registry>.azurecr.io \
  --dry-run
```

Then apply after review:

```bash
npm run install:azd-adapter -- \
  --target ~/repos/my-agent \
  --name my-agent \
  --acr <registry>.azurecr.io
```

From the user's repo:

```bash
cd ~/repos/my-agent
azd env new my-agent
azd env set PI_MOCK 0
azd env set REQUEST_TIMEOUT_MS 600000
azd env set 'PI_ARGS=--mode rpc --no-session --provider foundry --model <model>'
azd env set PI_OPENAI_BASE_URL 'https://<account>.cognitiveservices.azure.com/openai/v1'
azd env set PI_OPENAI_MODEL '<model>'
azd env set PI_OPENAI_API_KEY '<secret>'
azd up
```

## Runtime image requirement

The prototype Dockerfile uses a runtime base image:

```dockerfile
ARG PI_FOUNDRY_RUNTIME_IMAGE=ghcr.io/1openwindow/pi-foundry-runtime:0.1.0
FROM ${PI_FOUNDRY_RUNTIME_IMAGE}
```

Before this flow can be fully production-ready, publish and version the runtime image. The current full template remains the runtime reference implementation. See [runtime-image.md](./runtime-image.md) for build, smoke, and publish commands.

## Future product shape

Recommended artifacts:

1. `pi-foundry-runtime` image
   - official Invocations host
   - Node Pi backend
   - session mapping
   - artifact publishing
   - health/readiness

2. `pi-foundry-azd` thin template
   - `azure.yaml`
   - `agent.yaml`
   - `agent.manifest.yaml`
   - thin Dockerfile
   - safe `.dockerignore`

3. `@pi-foundry/cli`
   - doctor
   - postdeploy / artifact RBAC
   - smoke invoke helpers
   - azd workflow entrypoints

The skill should guide users through the azd-native path by default and reserve the old wrapper path as an advanced/self-contained option.
