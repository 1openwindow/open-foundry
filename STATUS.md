# pi-foundry Status

> Internal handoff note. This file records one known-good development/deployment
> environment and is not required for template users. Do not treat endpoint,
> subscription, ACR, storage, model, or version values here as defaults for your
> own BYO Pi Agent deployment.

Last updated: 2026-05-29

## Goal

Run Pi as a Microsoft Foundry Hosted Agent and provide a reusable **Bring Your Own Pi Agent to Foundry** template.

The current recommended architecture is:

```text
Official Invocations mode for Foundry deployment
Node direct mode for local development, backend validation, and fallback
```

See [docs/handoff.md](./docs/handoff.md) for the current handoff and [docs/demo-checklist.md](./docs/demo-checklist.md) for demo commands.

## Current status

Complete:

- Local HTTP server works
- Local Docker image works
- Foundry Hosted Agent deployment works
- Invocations protocol shape works
- Remote real pi invocation works
- Remote session continuity works
- Static website artifact publishing works
- Azd-native in-repo adapter prototype works end-to-end with `media-report-agent` v3
- Runtime base image built through ACR remote build: `crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0`

Current known-good remote agents:

- `media-report-agent` version `3`: validates the azd-native in-repo adapter story; deployed from the original `~/repos/media-report-agent` repo with `azd up` and no wrapper repo.
- `media-report-foundry` version `1`: validates the existing Pi agent import/wrapper story.
- `pi-foundry-official-invocations` version `3`: validates the official `azure-ai-agentserver-invocations` host as the public protocol layer with the Node Pi backend.

Historical known-good agent:

- `pi-foundry` version `4`/later validated direct Node Invocations mode during the original proof.

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
src/server.mjs              HTTP wrapper and pi RPC bridge
Dockerfile                  Hosted Agent container image
azure.yaml                  azd service config
agent.yaml                  Hosted Agent definition
agent.manifest.yaml         azd/Foundry manifest
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
PI_ARGS="--mode rpc --no-session --provider foundry --model gpt-5.4-mini"
PI_OPENAI_BASE_URL="https://zihch-test-wus3-resource.cognitiveservices.azure.com/openai/v1"
PI_OPENAI_MODEL="gpt-5.4-mini"
PI_OPENAI_API_KEY=<stored in local azd env, not in repo>
```

Important endpoint finding:

- `https://zihch-test-wus3-resource.services.ai.azure.com/openai/v1` works locally but failed from Hosted Agent sandbox with `fetch failed`.
- `https://zihch-test-wus3-resource.cognitiveservices.azure.com/openai/v1` works from Hosted Agent sandbox and is the current deployed endpoint.

## azd environment

Environment name:

```bash
pi-foundry-local
```

Important azd values:

```bash
AZURE_SUBSCRIPTION_ID="fcffb5eb-7227-412b-b730-094a0dc8d815"
AZURE_TENANT_ID="d678d95f-6390-442d-a5db-742082adc9cf"
AZURE_LOCATION="westus3"
FOUNDRY_PROJECT_ENDPOINT="https://zihch-test-wus3-resource.services.ai.azure.com/api/projects/zihch-test-wus3"
AZURE_AI_PROJECT_ID="/subscriptions/fcffb5eb-7227-412b-b730-094a0dc8d815/resourceGroups/rg-zihch-test/providers/Microsoft.CognitiveServices/accounts/zihch-test-wus3-resource/projects/zihch-test-wus3"
AZURE_CONTAINER_REGISTRY_ENDPOINT="zihchpifoundry.azurecr.io"
```

The secret `PI_OPENAI_API_KEY` is stored in `.azure/pi-foundry-local/.env`. The `.azure/` directory is ignored and should not be committed.

## Azure resources

Existing Foundry endpoint supplied by user:

```text
https://zihch-test-wus3-resource.services.ai.azure.com/api/projects/zihch-test-wus3
```

Container registry created during this work:

```text
zihchpifoundry.azurecr.io
```

ACR permissions were required for Foundry image pulls. Assigned ACR pull/read roles to:

- Foundry project system identity
- Foundry project agent identity
- hosted agent instance identity
- hosted agent blueprint identity

## Known-good commands

Local run:

```bash
cd ~/repos/pi-foundry
npm start
```

Local smoke:

```bash
npm run smoke:curl
npm run smoke:sse
npm run smoke:session
```

Docker build:

```bash
npm run docker:build
```

Docker smoke:

```bash
npm run docker:smoke:mock
HOST_PORT=8114 npm run docker:smoke:real
```

azd local run:

```bash
azd ai agent run --no-inspector --port 8120 --start-command 'node src/server.mjs'
```

Remote deploy:

```bash
azd deploy --no-prompt
```

Remote invocation, known-good real version:

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

Last checked after version 4 deployment:

```text
11 passed, 0 failed, 3 skipped, 1 warned
```

Warning:

```text
Agent identity role assignments: could not list role assignments
```

This is not a blocker; remote real invocation works.

## Important implementation notes

- Foundry reserves `FOUNDRY_*` and `AGENT_*` environment variable prefixes. Use `PI_*` names for custom env vars.
- Foundry requires `GET /readiness` to return HTTP 200.
- Foundry Hosted Agent internal port convention is `8088`; Dockerfile exposes `8088`.
- Current implementation is Node.js and directly implements the Invocations shape. It does not use the official Python/C# `azure-ai-agentserver-invocations` SDK.
- `azd ai agent run` successfully runs the Node server locally, so Node is acceptable for local agent workflow.

## Known issues / next work

1. `/diagnostics` is now disabled by default. Set `ENABLE_DIAGNOSTICS=1` to enable it temporarily.
2. `PI_OPENAI_API_KEY` is stored in local azd env. User said Key Vault is not needed yet.
3. `/artifacts/<path>` can serve generated files from `FILES_DIR` locally, but Foundry front door does not expose that route. Remote artifacts are published to Azure Storage Static Website instead.
4. Upload/workspace ingestion is still not implemented.
5. No concurrency limits yet.
6. No explicit output truncation in the HTTP wrapper, though pi tools already truncate their own tool output.
7. Multiple old remote versions exist. Use version 4 unless newer versions are validated.
