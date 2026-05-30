# pi-foundry Status

> Internal handoff note. This file records one known-good development/deployment
> environment and is not required for users. Do not treat endpoint,
> subscription, ACR, storage, model, or version values here as defaults for your
> own BYO Pi Agent deployment.

Last updated: 2026-05-30

## Goal

Run Pi as a Microsoft Foundry Hosted Agent and provide a reusable **Bring Your Own Pi Agent to Foundry** skill-managed adapter.

The current recommended architecture is:

```text
Official SDK Invocations host for Foundry deployment
Internal Node backend for Pi RPC, sessions, streaming, and artifact publishing
```

See [docs/handoff.md](./docs/handoff.md) for the current handoff and [docs/demo-checklist.md](./docs/demo-checklist.md) for demo commands.

## Current status

Complete:

- Official SDK host + internal Node backend local smoke works
- Local Docker image uses the official SDK host
- Foundry Hosted Agent deployment works
- Invocations protocol shape works
- Remote real pi invocation works
- Remote session continuity works
- Static website artifact publishing works
- Earlier skill/azd-compatible in-repo adapter prototype worked end-to-end with `clean-pi-agent` deployed as `pi-agent` v1
- Runtime base image built through ACR remote build: `crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0`
- Current skill-managed adapter install path works end-to-end from a clean `~/repos/clean-pi-agent` repo with direct `azd up --no-prompt`, no wrapper repo, and no `PI_FOUNDRY_ALLOW_*` workaround. The latest adapter keeps agent YAML under `.azd/pi-foundry/generated/` and uses `.azd/pi-foundry/azd-agent.mjs` to pass `AGENT_DEFINITION_PATH` during azd package/deploy.

Current known-good remote agent:

- `clean-pi-agent` version `4`: validates the current skill-managed adapter story with generated agent YAML kept under `.azd/pi-foundry/generated/`. The adapter workflow uses `.azd/pi-foundry/azd-agent.mjs` to pass `AGENT_DEFINITION_PATH` and temporarily materialize root agent files only during `azd deploy`. Remote invoke returned `ok` with `mock: false`; static website artifact publishing returned HTTP 200 for `index.html`.
- `clean-pi-agent` version `3`: validates the earlier skill-managed adapter story before the root-agent-file cleanup. Remote invoke returned `ok` with `mock: false`; static website artifact publishing returned HTTP 200 for `index.html`.
- `pi-agent` version `1`: validates the earlier in-repo adapter story; deployed from the clean `~/repos/clean-pi-agent` repo with `azd up` and no wrapper repo.

Historical/internal validation agents:

- `media-report-foundry` version `1`: validated the old existing Pi agent import/wrapper story. This is no longer user-facing.
- `pi-foundry-official-invocations` version `3`: validated the official `azure-ai-agentserver-invocations` host as the public protocol layer with the Node Pi backend.
- `pi-foundry` version `4`/later validated the historical direct Node Invocations proof; that deployment path has been removed from the repo.

Artifact static website for the internal deployment:

```text
https://pifoundryeus2web.z20.web.core.windows.net/
```

## Project layout

Root:

```text
/home/zihch/repos/pi-foundry
```

Important files:

```text
src/backend.mjs              HTTP wrapper and pi RPC bridge
Dockerfile.runtime           reusable runtime base image
.agents/skills/pi-foundry/   BYO Pi agent skill and canonical adapter bundle
examples/demo-agent/         demo/test agent skills and workspace
examples/full-repo-deploy/   legacy full-repo deployment reference
scripts/                    local, Docker, and smoke helpers
README.md                   usage docs
STATUS.md                   this handoff/status file
```

## HTTP API

Implemented endpoints:

- `GET /health`
- `GET /readiness`
- `GET /invocations/docs/openapi.json`
- `GET /artifacts/<path>`
- `POST /invocations`

Invocation features:

- JSON response
- SSE response when `Accept: text/event-stream` or `?stream=true`
- `agent_session_id` query parameter
- JSON body:
  - `{ "message": "..." }`
  - `{ "input": "..." }`
- plain text body
- generated `requestId`
- generated `sessionId` when omitted
- `cwd` constrained inside `WORKSPACE_DIR`

## Session mapping

Foundry `agent_session_id` maps to pi session storage:

```text
$SESSIONS_DIR/<sessionId>/pi-sessions
```

The wrapper removes `--no-session` from `PI_ARGS` and adds:

```bash
--continue --session-dir <session-specific-dir>
```

Verified remotely:

1. Ask version 4 to remember `mango`
2. Ask again in same session
3. It returns `mango`

## Runtime directories

| Variable | Purpose |
|---|---|
| `WORKSPACE_DIR` | pi working directory; Docker defaults to `/workspace` |
| `FILES_DIR` | generated artifact root served by `/artifacts/<path>`; Docker defaults to `/files` |
| `STATE_DIR` | wrapper state root; Docker defaults to `/home/node/.pi-foundry` |
| `SESSIONS_DIR` | per-session pi storage root |
| `PI_CODING_AGENT_DIR` | pi config/cache/models root |

## Current model/provider setup

The wrapper generates a pi custom provider named `foundry` when `PI_OPENAI_API_KEY` is present.

Current real remote settings:

```bash
PI_MOCK=0
PI_ARGS="--mode rpc --no-session --provider foundry --model gpt-5.4"
PI_OPENAI_BASE_URL="https://zihch-eus2.cognitiveservices.azure.com/openai/v1"
PI_OPENAI_MODEL="gpt-5.4"
PI_OPENAI_API_KEY=<stored in local azd env, not in repo>
```

Important endpoint finding:

- Hosted Agent sandbox should use the account-level `*.cognitiveservices.azure.com/openai/v1` endpoint for the OpenAI-compatible model provider.
- Project-scoped `*.services.ai.azure.com/openai/v1` endpoints may fail from the Hosted Agent sandbox with `fetch failed` in some environments.

## azd environment

Environment name in this repo:

```bash
pi-foundry-local
```

Important current known-good azd values:

```bash
AZURE_SUBSCRIPTION_ID="1756abc0-3554-4341-8d6a-46674962ea19"
AZURE_TENANT_ID="72f988bf-86f1-41af-91ab-2d7cd011db47"
AZURE_LOCATION="eastus2"
FOUNDRY_PROJECT_ENDPOINT="https://zihch-eus2.services.ai.azure.com/api/projects/zihch-eus2"
AZURE_AI_PROJECT_ID="/subscriptions/1756abc0-3554-4341-8d6a-46674962ea19/resourceGroups/zihch-test-eus2/providers/Microsoft.CognitiveServices/accounts/zihch-eus2/projects/zihch-eus2"
AZURE_CONTAINER_REGISTRY_ENDPOINT="crce6hg4ngzj3as.azurecr.io"
PI_ARGS="--mode rpc --no-session --provider foundry --model gpt-5.4"
PI_OPENAI_BASE_URL="https://zihch-eus2.cognitiveservices.azure.com/openai/v1"
PI_OPENAI_MODEL="gpt-5.4"
ARTIFACT_PUBLISH_MODE="static-web"
ARTIFACT_STORAGE_ACCOUNT="pifoundryeus2web"
ARTIFACT_STATIC_WEB_ENDPOINT="https://pifoundryeus2web.z20.web.core.windows.net"
ARTIFACT_STATIC_WEB_CONTAINER="$web"
ARTIFACT_BLOB_PREFIX="clean-pi-agent"
```

The secret `PI_OPENAI_API_KEY` is stored in local `.azure/<env>/.env` files. The `.azure/` directory is ignored and should not be committed.

## Azure resources

Existing Foundry endpoint supplied by user:

```text
https://zihch-eus2.services.ai.azure.com/api/projects/zihch-eus2
```

Container registry used by the current runtime image:

```text
crce6hg4ngzj3as.azurecr.io
```

ACR permissions were required for Foundry image pulls. Assigned ACR pull/read roles to:

- Foundry project system identity
- Foundry project agent identity
- hosted agent instance identity
- hosted agent blueprint identity

## Known-good commands

Local backend-only run:

```bash
cd ~/repos/pi-foundry
PI_MOCK=1 npm run start:backend
```

Local smoke:

```bash
npm run smoke
```

Docker build:

```bash
npm run docker:build
```

Docker smoke:

```bash
npm run runtime:smoke
npm run smoke
```

Official SDK local smoke:

```bash
npm run smoke
```

Remote deploy from an adapted user repo:

```bash
azd up --no-prompt
```

Remote invocation, current known-good skill-managed version:

```bash
azd ai agent invoke clean-pi-agent \
  --protocol invocations \
  --version 3 \
  --new-session \
  --timeout 900 \
  'Say exactly: ok'
```

Expected output includes:

```json
{
  "output": "ok",
  "mock": false
}
```

Remote logs:

```bash
azd ai agent monitor pi-foundry --tail 100 --type console
```

Show status:

```bash
azd ai agent show --output json --no-prompt
azd ai agent doctor --no-prompt
```

## Current doctor state

Last checked during the `clean-pi-agent` version 4 E2E:

```text
pi-foundry adapter doctor: 39 passed, 1 warned, 0 failed
```

The warning was from `azd ai agent doctor`; adapter checks passed and remote invoke/artifact validation succeeded.

## Important implementation notes

- Foundry reserves `FOUNDRY_*` and `AGENT_*` environment variable prefixes. Use `PI_*` names for custom env vars.
- Foundry requires `GET /readiness` to return HTTP 200.
- Foundry Hosted Agent internal port convention is `8088`; `Dockerfile.runtime` and the demo Dockerfile expose `8088`.
- Current Foundry-facing implementation uses the official Python `azure-ai-agentserver-invocations` SDK.
- The Node process is retained as the internal Pi backend for RPC lifecycle, sessions, streaming, and artifacts.

## Known issues / next work

1. `/diagnostics` is now disabled by default. Set `ENABLE_DIAGNOSTICS=1` to enable it temporarily.
2. `PI_OPENAI_API_KEY` is stored in local azd env. User said Key Vault is not needed yet.
3. `/artifacts/<path>` can serve generated files from `FILES_DIR` locally, but Foundry front door does not expose that route. Remote artifacts are published to Azure Storage Static Website instead.
4. Upload/workspace ingestion is still not implemented.
5. No concurrency limits yet.
6. No explicit output truncation in the internal backend, though pi tools already truncate their own tool output.
7. Multiple old remote versions exist; prefer the current skill-managed deployment output version.
