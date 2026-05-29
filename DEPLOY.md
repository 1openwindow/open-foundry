# Deploy pi-foundry

This project deploys `pi` as a Microsoft Foundry Hosted Agent using the Invocations protocol.

## Current known-good deployment

- Agent: `pi-foundry`
- Version: `4`
- Protocol: `invocations`
- Endpoint:
  `https://zihch-eus2.services.ai.azure.com/api/projects/zihch-eus2/agents/pi-foundry/endpoint/protocols/invocations?api-version=2025-11-15-preview`
- Playground:
  `https://ai.azure.com/nextgen/r/F1arwDVUQ0GNakZnSWLqGQ,zihch-test-eus2,,zihch-eus2,zihch-eus2/build/agents/pi-foundry/build?version=4`
- Artifact static website:
  `https://pifoundryeus2web.z20.web.core.windows.net/`

## Prerequisites

Required local tools:

```bash
azd --version
docker --version
node --version
npm --version
```

Required azd extension:

```bash
azd extension list
```

Expected extension:

```text
azure.ai.agents
```

Install if missing:

```bash
azd extension install azure.ai.agents
```

Login:

```bash
azd auth login
```

## Environment

Project root:

```bash
cd /home/zihch/repos/pi-foundry
```

Current azd environment:

```bash
azd env select pi-foundry-local
```

Important environment values:

```bash
azd env get-values | sort | rg 'AZURE_|FOUNDRY_PROJECT_ENDPOINT|PI_|ENABLE_DIAGNOSTICS|AGENT_PI_FOUNDRY_VERSION'
```

Generated files under `FILES_DIR` are served locally by:

```text
/artifacts/<relative-path-under-FILES_DIR>
```

The Foundry Hosted Agent front door does not expose that local route. For remote usage, generated artifacts are published to Azure Storage Static Website and returned as clickable links. See [docs/artifacts.md](./docs/artifacts.md).

Expected real-model values:

```bash
PI_MOCK=0
PI_ARGS="--mode rpc --no-session --provider foundry --model gpt-5.4-mini"
PI_OPENAI_BASE_URL="https://zihch-test-wus3-resource.cognitiveservices.azure.com/openai/v1"
PI_OPENAI_MODEL="gpt-5.4-mini"
ENABLE_DIAGNOSTICS=0
```

`PI_OPENAI_API_KEY` is stored in the local azd environment file under `.azure/pi-foundry-local/.env`. Do not commit `.azure/`.

## Configure model credentials

Set or update the current API key:

```bash
azd env set PI_OPENAI_API_KEY '<api-key>'
```

Set the real pi model config:

```bash
azd env set PI_MOCK 0
azd env set 'PI_ARGS=--mode rpc --no-session --provider foundry --model gpt-5.4-mini'
azd env set PI_OPENAI_BASE_URL 'https://zihch-test-wus3-resource.cognitiveservices.azure.com/openai/v1'
azd env set PI_OPENAI_MODEL 'gpt-5.4-mini'
azd env set ENABLE_DIAGNOSTICS 0
```

Do not use custom `FOUNDRY_*` or `AGENT_*` variables. Foundry reserves those prefixes for platform use.

## Local checks

Syntax check:

```bash
node --check src/backend.mjs
```

Local official-host smoke:

```bash
npm run smoke
```

Docker build:

```bash
npm run docker:build
```

Docker smoke, mock mode:

```bash
npm run runtime:smoke
```

For real model mode, provide `PI_OPENAI_*` and `PI_ARGS` values to the official host/container and invoke through the public SDK host port.

## Deploy

Deploy a new Hosted Agent version:

```bash
azd deploy --no-prompt
```

The command prints the new version, playground URL, and invocations endpoint.

After deployment, check the version:

```bash
azd env get-values | rg 'AGENT_PI_FOUNDRY_VERSION|AGENT_PI_FOUNDRY_INVOCATIONS_ENDPOINT'
```

## Verify remote invocation

Use the latest deployed version, currently known-good `4`:

```bash
azd ai agent invoke pi-foundry \
  --protocol invocations \
  --version 4 \
  --new-session \
  --timeout 600 \
  'Say exactly: ok'
```

Expected output includes:

```json
{
  "output": "ok",
  "mock": false
}
```

## Verify remote artifacts locally before deploy

With a local server running:

```bash
mkdir -p .files/coding-agent-comparison
printf '<h1>artifact ok</h1>' > .files/coding-agent-comparison/index.html
curl --noproxy '*' -sS http://127.0.0.1:8080/artifacts/coding-agent-comparison/index.html
```

Expected output:

```html
<h1>artifact ok</h1>
```

## Verify remote session continuity

Start a new session:

```bash
azd ai agent invoke pi-foundry \
  --protocol invocations \
  --version 4 \
  --new-session \
  --timeout 600 \
  'Remember this exact word for this session: mango. Reply exactly: remembered'
```

Then invoke again without `--new-session`:

```bash
azd ai agent invoke pi-foundry \
  --protocol invocations \
  --version 4 \
  --timeout 600 \
  'What exact word did I ask you to remember? Reply with only the word.'
```

Expected output:

```text
mango
```

## Monitor logs

Stream recent logs:

```bash
azd ai agent monitor pi-foundry --tail 100 --type console
```

Check agent state:

```bash
azd ai agent show --no-prompt
```

Run doctor:

```bash
azd ai agent doctor --no-prompt
```

Current non-blocking warning:

```text
Agent identity role assignments: could not list role assignments
```

Remote invocation works despite this warning.

## Diagnostics

Internal endpoint diagnostics are disabled by default:

```bash
ENABLE_DIAGNOSTICS=0
```

Temporarily enable only when debugging Hosted Agent network/model access:

```bash
azd env set ENABLE_DIAGNOSTICS 1
azd deploy --no-prompt
```

Disable again afterward:

```bash
azd env set ENABLE_DIAGNOSTICS 0
azd deploy --no-prompt
```

## Security notes

- `.azure/` contains local azd state and secrets; do not commit it.
- `azd ai agent show --output json` can print environment variable values, including `PI_OPENAI_API_KEY`; do not paste full output publicly.
- The API key was provided during development. Rotate it before production or broader sharing.
- Key Vault is intentionally not used yet.

## Common failures

### `No API key found for the selected model`

The remote container does not have `PI_OPENAI_API_KEY`, or `PI_ARGS` points at a provider/model that is not configured.

Check:

```bash
azd env get-values | rg 'PI_OPENAI_API_KEY|PI_ARGS|PI_MOCK'
```

### `Environment variable 'FOUNDRY_*' is reserved`

Do not use custom env vars beginning with `FOUNDRY_` or `AGENT_`. Use `PI_OPENAI_*` instead.

### Remote `fetch failed` to `services.ai.azure.com/openai/v1`

The Hosted Agent sandbox failed to reach the project-scoped OpenAI-compatible endpoint:

```text
https://zihch-test-wus3-resource.services.ai.azure.com/openai/v1
```

Use the account endpoint instead:

```text
https://zihch-test-wus3-resource.cognitiveservices.azure.com/openai/v1
```

### ACR image pull failures

Ensure Foundry identities have ACR pull/read roles on:

```text
zihchpifoundry.azurecr.io
```

Roles used during setup:

- `AcrPull`
- `Container Registry Repository Reader`
