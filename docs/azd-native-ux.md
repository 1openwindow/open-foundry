# azd-native UX direction

The next user-facing direction for `pi-foundry` is an **azd-native in-repo adapter**:

```text
Deploy your existing Pi agent to Foundry with azd.
No wrapper repo. No runtime vendoring. No changes to agent business code.
```

## Why

Developers expect to stay inside their own repo and run the platform's deployment workflow:

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
.azd/pi-foundry/doctor.mjs
.azd/pi-foundry/postdeploy.mjs
```

It does **not** add:

```text
src/backend.mjs
runtime/official-invocations/
legacy wrapper-repo scripts
```

## Current validation status

Validated on 2026-05-29:

- Runtime image built with ACR remote build: `crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0`
- Existing clean Pi agent repo adapted in place: `~/repos/clean-pi-agent`
- Hosted Agent deployed with `azd up`: `pi-agent` version `1`
- Remote invoke succeeded with real model: output `ok`, `mock: false`
- Artifact demo succeeded and returned static website URLs under `clean-pi-agent/<date>/<request-id>/...`

The key UX result is that the user stayed in the existing Pi agent repo and deployed with `azd up`; no wrapper repo was required.

## Current prototype in this repo

The first prototype lives at:

```text
templates/azd-native/
```

It can be initialized into an existing Pi agent repo with `azd init --template`:

```bash
cd ~/repos/my-agent
azd init --template ~/repos/pi-foundry/templates/azd-native . --environment my-agent
```

Then configure environment values from the user's repo:

```bash
azd env set AZURE_CONTAINER_REGISTRY_ENDPOINT '<registry>.azurecr.io'
azd env set PI_MOCK 0
azd env set REQUEST_TIMEOUT_MS 600000
azd env set 'PI_ARGS=--mode rpc --no-session --provider foundry --model <model>'
azd env set PI_OPENAI_BASE_URL 'https://<account>.cognitiveservices.azure.com/openai/v1'
azd env set PI_OPENAI_MODEL '<model>'
azd env set PI_OPENAI_API_KEY '<secret>'
node .azd/pi-foundry/doctor.mjs
azd up
```

## Runtime image requirement

The prototype Dockerfile uses a runtime base image:

```dockerfile
ARG PI_FOUNDRY_RUNTIME_IMAGE=crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0
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

The skill should guide users through the azd-native path only.
