# Deploy open-foundry to a Foundry Hosted Agent

This document is a generic, copy-pasteable remote-deploy reference. It assumes you already used the open-foundry skill (or `node <skill>/scripts/bootstrap.mjs`) to add the 5 standard files (`Dockerfile`, `azure.yaml`, `agent.yaml`, `agent.manifest.yaml`, `.dockerignore`) to your agent repo.

Substitute `<placeholders>` with your own values. **No defaults point at any maintainer endpoint** — open-foundry fails fast when required values are missing.

For day-to-day deploys, the recommended interface is the open-foundry skill; ask your agent to deploy the current repo. The commands below are the underlying primitives.

## Prerequisites

```bash
azd --version
docker --version          # optional; only needed for local runtime image builds
node --version
npm --version

azd extension list        # expect: azure.ai.agents
azd extension install azure.ai.agents     # if missing

azd auth login
```

`azd` is the only Azure CLI you need. The skill's scripts resolve project/tenant ids and grant the keyless model role through ARM REST using `azd auth token`, so **`az` (Azure CLI) is not required**.

You also need:

- a Foundry project (subscription, location, project endpoint),
- an Azure Container Registry your Foundry project can pull from (see [Container registry](#container-registry) to set one up),
- a runtime image you can pull as the build base (see [docs/runtime-image.md](./docs/runtime-image.md)): `pi-foundry-runtime` for Pi or `ghcp-foundry-runtime` for GitHub Copilot,
- a Foundry OpenAI-compatible endpoint, model name, and an API key (`OF_MODEL_AUTH=apikey`, default). The Pi runtime also supports a managed-identity data-plane role assignment on the model resource (`OF_MODEL_AUTH=managed-identity`, keyless); the GitHub Copilot runtime does not.

The runtime image name is the harness selector. Do not set a separate `HARNESS` azd env value for normal deployments.

## Container registry

`azd deploy` builds your agent image server-side (ACR Tasks) and the Foundry project pulls it from an Azure Container Registry in **your** subscription.
Creating the registry and assigning its RBAC are generic Azure operations — open-foundry doesn't own that path. Set one up yourself (or have your coding
agent do it), then pass its endpoint via `configure-env.mjs --acr` (or `azd env set AZURE_CONTAINER_REGISTRY_ENDPOINT <acr>.azurecr.io`).

Two Foundry hosted-agent constraints are easy to miss:

- **Public endpoint.** Hosted agents can't pull from a private-network-only ACR.
- **Project identity can pull.** The Foundry **project's managed identity** needs the `Container Registry Repository Reader` role (classic: `AcrPull`) on the registry. `azd` configures this on some paths; with a bring-your-own ACR, confirm it. The identity only exists after the first deploy, so if you can't grant it yet, deploy once, grant it, then redeploy. No project `ContainerRegistry` connection is needed — pull is pure RBAC.

See [Configure container registry permissions](https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/deploy-hosted-agent#configure-container-registry-permissions).

## Configure the azd environment

The skill's `configure-env.mjs` wraps these commands and never prints secret values. The raw commands are:

```bash
cd <your-agent-repo>
azd env new <env-name>            # or: azd env select <env-name>

azd env set AZURE_SUBSCRIPTION_ID '<subscription-id>'
azd env set AZURE_TENANT_ID       '<tenant-id>'
azd env set AZURE_LOCATION        '<region>'             # e.g. eastus2
azd env set FOUNDRY_PROJECT_ENDPOINT          '<https://...>'
azd env set AZURE_CONTAINER_REGISTRY_ENDPOINT '<acr>.azurecr.io'

# Live model config. Inside the runtime, OF_OPENAI_* is required unless OF_MOCK=1.
azd env set OF_MOCK 0
azd env set 'PI_ARGS=--mode rpc --no-session --provider foundry --model <model>'
azd env set OF_OPENAI_BASE_URL '<https://<account>.cognitiveservices.azure.com/openai/v1>'
azd env set OF_OPENAI_MODEL    '<model>'
# Pass the secret as KEY=value to avoid azd reparsing leading -- characters:
azd env set "OF_OPENAI_API_KEY=$OF_OPENAI_API_KEY"

# Pi runtime only: keyless alternative (no OF_OPENAI_API_KEY), minting AAD tokens
# via the Hosted Agent's managed identity. Copilot BYOK is API-key only; do not
# use OF_MODEL_AUTH=managed-identity with ghcp-foundry-runtime. Keyless Pi requires
# the agent identity to have a Cognitive Services / Azure OpenAI data-plane role
# on the model resource. After the first `azd deploy` (the identity only exists
# once deployed), grant it with:
#   node <skill>/scripts/grant-model-access.mjs   # Cognitive Services OpenAI User, idempotent
# then redeploy. Manual equivalent:
# azd env set OF_MODEL_AUTH managed-identity
# azd env set FOUNDRY_TOKEN_SCOPE 'https://cognitiveservices.azure.com/.default'  # default; override only if needed
```

Do **not** introduce custom env vars beginning with `AGENT_` or `FOUNDRY_` (except the documented `FOUNDRY_PROJECT_ENDPOINT`). Foundry reserves those
prefixes and will reject or overwrite them. Use `OF_*` or your own prefixes instead.

## Local validation before deploy

```bash
# Tests (no Docker, no credentials needed):
npm test

# Mock-mode backend (no model credentials needed):
OF_MOCK=1 npm run start:backend
```

If you have Docker locally, you can additionally run the runtime image smoke:

```bash
OPEN_FOUNDRY_RUNTIME_IMAGE=<acr>.azurecr.io/pi-foundry-runtime:<tag> npm run runtime:smoke
OPEN_FOUNDRY_RUNTIME_IMAGE=<acr>.azurecr.io/ghcp-foundry-runtime:<tag> npm run runtime:smoke
```

Inside the runtime container (or attached to a running one), validate the contract by hand:

```bash
open-foundry contract          # full contract JSON, single source of truth
open-foundry doctor            # exit 1 + JSON report when required env is missing
open-foundry version
```

## Deploy

This is a thin `azd` layout with **no `infra/`** to provision, so the deploy command is `azd deploy` — not `azd up` (which fails here looking for
`infra/main.bicep`).

```bash
azd deploy                   # build/push to ACR + (re)deploy the Hosted Agent
azd deploy --no-prompt       # non-interactive
```

`azd deploy` requires two env values that `configure-env.mjs` derives for you:

- `AZURE_AI_PROJECT_ID` — the project's full ARM resource id
  (`/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>/projects/<project>`).
  Without it the first deploy fails with `AZURE_AI_PROJECT_ID is not set`.
- `AZURE_TENANT_ID` — needed by a postdeploy hook. Without it the agent deploys but postdeploy fails with `AZURE_TENANT_ID is not set`.

If derivation failed, set them explicitly:

```bash
azd env set AZURE_AI_PROJECT_ID /subscriptions/.../projects/<project>
azd env set AZURE_TENANT_ID <tenant-id>
```

azd prints the new version, playground URL, and invocations endpoint. After deploy, you can read them back from azd env:

```bash
azd env get-values | grep AGENT_
```

The Hosted Agent's name, version, and invocations endpoint are exposed under
`AGENT_<NAME>_NAME`, `AGENT_<NAME>_VERSION`, and
`AGENT_<NAME>_INVOCATIONS_ENDPOINT`.

## Verify

```bash
# Health smoke (uses azd env outputs + agent.yaml automatically):
node <skill>/scripts/verify.mjs
```

`verify.mjs` calls the Hosted Agent **invocations REST endpoint** directly. It does not use `azd ai agent invoke`, because Hosted Agent session creation
currently returns `403 preview_feature_required` unless the request carries the `Foundry-Features: HostedAgents=V1Preview` header, which the CLI does not send. The script mints a data-plane token (`azd auth token --scope https://ai.azure.com/.default`), creates a session, and POSTs the invocation with that header.

Expected JSON includes `"output": "ok"` and `"mock": false`.

### Session continuity

```bash
azd ai agent invoke <agent-name> --protocol invocations --version <v> --new-session --timeout 600   'Remember this exact word for this session: mango. Reply exactly: remembered'

azd ai agent invoke <agent-name> --protocol invocations --version <v> --timeout 600   'What exact word did I ask you to remember? Reply with only the word.'
# expected: mango
```

## Monitor

```bash
azd ai agent monitor <agent-name> --tail 100 --type console
azd ai agent show    <agent-name> --output json --no-prompt
azd ai agent doctor                              --no-prompt
```

## Common failures

### Startup aborted: missing required env

```text
{"level":"error","message":"OF_OPENAI_API_KEY is required (set it via azd env, or set OF_MOCK=1 for offline mode).", ...}
{"level":"error","message":"startup_aborted", ...}
```

The runtime refuses to start without the live triple. Either set `OF_OPENAI_API_KEY` / `OF_OPENAI_BASE_URL` / `OF_OPENAI_MODEL`, or set
`OF_MOCK=1` for an offline smoke run. Re-run `azd deploy --no-prompt` after fixing.

### `No API key found for the selected model`

`PI_ARGS` points at a provider/model that pi cannot resolve. Make sure `OF_OPENAI_MODEL` matches the model in `PI_ARGS` and the key is set.

### `Environment variable 'FOUNDRY_*' is reserved` / `'AGENT_*' is reserved`

You set a custom variable using a reserved prefix. Use `OF_*` or another prefix instead.

### Remote `fetch failed` to the OpenAI-compatible endpoint

Confirm `OF_OPENAI_BASE_URL` is reachable from the Foundry sandbox. The `*.cognitiveservices.azure.com/openai/v1` form generally works; project-scoped `*.services.ai.azure.com/openai/v1` may not, depending on your Foundry configuration.

### ACR image pull failures

`image_pull_failed` / `UnauthorizedAcrPull` means the Foundry project's managed identity lacks pull on the registry. Read the project identity principal id with `azd ai agent show <agent-name> --output json`, then grant it `AcrPull` on the registry resource (see [Container registry](#container-registry)).

## Security notes

- `.azure/` contains local azd state and may contain secrets. The skill's generated `.dockerignore` excludes it; keep your `.gitignore` doing the same.
- `azd ai agent show --output json` can print env values including   `OF_OPENAI_API_KEY`; do not paste full output publicly.
- open-foundry does not currently integrate Key Vault; rotate any keys you set   via `azd env set` if they are shared during development.

## See also

- [SKILL.md](./.agents/skills/open-foundry/SKILL.md) — skill contract and workflow
- [docs/runtime-image.md](./docs/runtime-image.md) — building/publishing the runtime image
