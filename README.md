# pi-foundry

A runtime and azd-native adapter for deploying an existing Pi agent to Microsoft Foundry Hosted Agents.

You bring Pi skills, MCP servers, tools, prompts, model/provider configuration, and environment variables. `pi-foundry` provides the Foundry Invocations bridge, Pi RPC lifecycle, session mapping, streaming, Docker packaging, health/readiness endpoints, and artifact delivery.

The primary user experience is now skill-driven:

```text
cd my-existing-pi-agent
# In Pi: ask the pi-foundry skill to deploy this agent to Foundry.
# The skill installs the adapter, creates .azd/pi-foundry/pi-foundry.yaml,
# configures azd env values, then runs azd up.
azd up
```

No wrapper repo is required for the default path. The user's existing Pi agent repo remains the source of truth; only deployment configuration is added. The pi-foundry runtime is supplied by a versioned base image instead of vendoring runtime source into the user's repo.

This path has been validated end-to-end with `clean-pi-agent` deployed as `pi-agent` v1 using `crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0`. See [docs/skill-adapter-design.md](./docs/skill-adapter-design.md) for the skill/adapter relationship, [docs/azd-native-ux.md](./docs/azd-native-ux.md) for the UX direction, and [docs/runtime-image.md](./docs/runtime-image.md) for runtime image build/publish details.

## Repository layout

The product path is intentionally separated from demo/test agent assets:

```text
src/                                      Node Pi backend and runtime helpers
runtime/official-invocations/             Foundry Invocations protocol host wrapper
Dockerfile.runtime                        reusable pi-foundry runtime base image
.agents/skills/pi-foundry/                natural-language onboarding/deploy skill and canonical adapter bundle
examples/demo-agent/                      bundled demo/test agent assets
examples/full-repo-deploy/                legacy full-repo deployment reference
```

The root repo no longer carries a default test agent. Demo skills and demo workspace files live under `examples/demo-agent/`; user-owned skills and prompts come from the user's own Pi agent repo in the BYO flow.

## Runtime modes

`pi-foundry` now uses the official Invocations host as the supported Foundry entrypoint:

### Official Invocations mode

Recommended for Foundry deployment and production hardening. The public container port is served by the official Python `azure-ai-agentserver-invocations` host, which proxies to the Node Pi backend on `127.0.0.1:18080`:

```text
Foundry /invocations
  -> official Invocations host
  -> Node Pi backend
  -> pi --mode rpc
```

Use `Dockerfile.runtime` for the reusable runtime base image, or the runtime files under `runtime/official-invocations/` for local process-level testing. Validate it locally with:

```bash
npm run smoke
```

The Node process remains as an internal Pi backend only; it is not the recommended Foundry-facing host. Start it explicitly for backend-only debugging with:

```bash
PI_MOCK=1 npm run start:backend
```

Current internal backend shape:

- `GET /health`
- `GET /readiness`
- `GET /invocations/docs/openapi.json`
- `GET /artifacts/<path>`
- `POST /invocations`
- Supports Foundry-style `agent_session_id` query parameter
- Supports JSON responses and SSE (`Accept: text/event-stream` or `?stream=true`)
- Internally calls `pi --mode rpc` with a session-specific `--session-dir`
- Uses fixed runtime directories for Docker/Foundry-style execution
- Supports `PI_MOCK=1` for local runtime testing without model credentials

## Bring your own Pi agent

Customize the agent layer:

- Add or replace Pi skills under `.agents/skills/`.
- Configure MCP servers, if your Pi setup uses them.
- Configure model/provider settings with `PI_ARGS` and `PI_OPENAI_*` environment variables.
- Add third-party credentials such as `GITHUB_TOKEN` or `JIRA_TOKEN` through your deployment environment.
- Write generated downloadable outputs under the artifact directory and optionally provide `artifact-manifest.json`.

The common azd-native path should not require changing user business code, skills, prompts, or MCP config. It adds a small root footprint (`azure.yaml`, `.dockerignore`) plus isolated adapter files under `.azd/pi-foundry/`. If an existing `azure.yaml` is not pi-foundry-managed, the skill requires explicit confirmation before replacing it and backs it up first. The skill creates the human-facing pi-foundry deployment source of truth at `.azd/pi-foundry/pi-foundry.yaml`; lower-level platform YAML is generated.

### Agentic onboarding skill

This repo includes a project skill at `.agents/skills/pi-foundry/SKILL.md`. In Pi, users can ask naturally, for example:

```text
把我这个 Pi agent 部署到 Foundry。
帮我给当前 repo 加 Foundry 部署。
帮我检查为什么 artifact demo 失败。
```

The skill acts as the UX/control layer for vibe-coding workflows while `azd` remains the deployment engine. Users stay in their existing Pi agent repo and can ask naturally, for example, “deploy this agent to Foundry.” The skill inspects the repo, installs the adapter bundle, creates `.azd/pi-foundry/pi-foundry.yaml`, helps configure `azd env`, runs the adapter doctor, deploys with `azd up`, and translates failures into concrete next steps. It does not introduce a separate product CLI or wrapper repo.

### Skill-managed adapter quickstart

The default UX is to add deployment configuration to the user's existing Pi agent repo through the pi-foundry skill, then use `azd up` as the canonical deploy command.

From the user's existing Pi agent repo, ask Pi to deploy the current agent to Foundry. For local development of this repo, the equivalent script entrypoint is:

```bash
cd ~/repos/my-agent
node ~/repos/pi-foundry/.agents/skills/pi-foundry/scripts/install-adapter.mjs --environment my-agent
```

Then configure `azd env` values, run the adapter doctor, and deploy. The pi-foundry skill infers or asks for the Hosted Agent name, writes `.azd/pi-foundry/pi-foundry.yaml`, and runs `node .azd/pi-foundry/render.mjs`. Generated files include `azure.yaml`, `.azd/pi-foundry/Dockerfile`, and `.azd/pi-foundry/generated/*`; azd supplies the actual published container image during deployment.

```bash
azd env set AZURE_CONTAINER_REGISTRY_ENDPOINT '<registry>.azurecr.io'
# set Foundry + PI_* values
node .azd/pi-foundry/doctor.mjs
azd up
```

This path expects a published pi-foundry runtime base image; build it locally with `npm run runtime:build` or remotely with `npm run runtime:acr-build`, then smoke locally with `npm run runtime:smoke` when Docker is available (see [docs/runtime-image.md](./docs/runtime-image.md)). This path has been validated end-to-end with `clean-pi-agent` deployed as `pi-agent` v1 using `crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0`.

> Note: [STATUS.md](./STATUS.md) is an internal handoff file for known-good deployment environments. Users should follow the generic README/docs and replace placeholders with their own Foundry, model, ACR, and storage values.

## Runtime directories

| Variable | Default | Purpose |
|---|---|---|
| `WORKSPACE_DIR` | current working directory; Docker sets `/workspace` | pi working directory |
| `FILES_DIR` | `$WORKSPACE_DIR/.files`; Docker sets `/files` | generated artifact root served by `/artifacts/<path>` |
| `STATE_DIR` | `$HOME/.pi-foundry` | runtime state root |
| `SESSIONS_DIR` | `$STATE_DIR/sessions` | per-`sessionId` pi session storage root |
| `PI_CODING_AGENT_DIR` | `$HOME/.pi/agent`; Docker sets `$STATE_DIR/pi-agent` | pi config/cache/session root |
| `ENABLE_DIAGNOSTICS` | `0` | Enables `/diagnostics` request handling when set to `1` or `true` |
| `PI_OPENAI_API_KEY` | unset | When set, writes a `foundry` provider to pi `models.json` |
| `PI_OPENAI_BASE_URL` | `https://<account>.cognitiveservices.azure.com/openai/v1` | Foundry OpenAI-compatible endpoint |
| `PI_OPENAI_MODEL` | `<foundry-model-or-deployment>` | Foundry deployment/model name |

Requests may include `cwd`, but it must resolve inside `WORKSPACE_DIR`. Requests may include `sessionId`; if omitted, the server generates one and returns it. Each `sessionId` maps to `$SESSIONS_DIR/<sessionId>/pi-sessions`.

## Local smoke test without pi/model credentials

The default smoke test starts both processes: the internal Node Pi backend in mock mode and the official Python Invocations host on the public port.

```bash
cd ~/repos/pi-foundry
npm run smoke
```

Expected invocation output contains `mock response: Say exactly: ok`.

For backend-only debugging, run the internal Node backend explicitly:

```bash
PI_MOCK=1 npm run start:backend
```

## Foundry Invocations-compatible local calls

JSON response:

```bash
curl --noproxy '*' -sS "http://127.0.0.1:8080/invocations?agent_session_id=chat-001" \
  -H 'content-type: application/json' \
  -d '{"message":"List files in the current directory."}'
```

SSE response:

```bash
curl --noproxy '*' -sS -N "http://127.0.0.1:8080/invocations?agent_session_id=chat-001&stream=true" \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"message":"Say exactly: ok"}'
```

OpenAPI:

```bash
curl --noproxy '*' -sS http://127.0.0.1:8080/invocations/docs/openapi.json | jq
```

Artifact serving from `FILES_DIR`:

```bash
mkdir -p .files/demo
printf '<h1>ok</h1>' > .files/demo/index.html
curl --noproxy '*' -sS http://127.0.0.1:8080/artifacts/demo/index.html
```

Artifact paths are constrained to `FILES_DIR`; path traversal outside that directory is rejected.

## Docker

Build the reusable runtime base image:

```bash
npm run runtime:build
```

Build the bundled demo-agent image, if you need the example skills/workspace baked in:

```bash
npm run docker:build
```

The demo build script uses `examples/demo-agent/Dockerfile` with `--network=host`, proxy build args, and `--pull=false`. This works around WSL/Docker daemon proxy issues after the base image exists locally.

Runtime base image smoke test:

```bash
npm run runtime:smoke
```

Manual demo-agent mock run:

```bash
docker run --rm -p 8080:8088 \
  -e PI_MOCK=1 \
  pi-foundry-demo:local
```

Manual demo-agent real run with Foundry OpenAI-compatible provider:

```bash
docker run --rm -p 8080:8088 \
  -e PI_OPENAI_API_KEY \
  -e PI_OPENAI_BASE_URL="https://<account>.cognitiveservices.azure.com/openai/v1" \
  -e PI_OPENAI_MODEL="<foundry-model-or-deployment>" \
  -e PI_ARGS="--mode rpc --no-session --provider foundry --model <foundry-model-or-deployment>" \
  pi-foundry-demo:local
```

For local workspace mounting with the demo image:

```bash
docker run --rm -p 8080:8088 \
  -v "$PWD:/workspace" \
  -e PI_MOCK=1 \
  pi-foundry-demo:local
```

## Request format

```json
{
  "message": "List files in the current directory.",
  "sessionId": "optional-session-id",
  "cwd": "."
}
```

Response:

```json
{
  "requestId": "...",
  "output": "...",
  "sessionId": "optional-session-id",
  "mock": false
}
```

## Paseo integration

To access the deployed Foundry Hosted Agent from a local Paseo daemon or phone client, see [docs/paseo.md](./docs/paseo.md).

## Artifact publishing

Generated HTML, MP3, MP4, image, and ZIP artifacts can be published to an Azure Storage Static Website and returned as clickable links. See [docs/artifacts.md](./docs/artifacts.md).

## Remote Foundry invocation

Remote deployment, invocation, monitoring, and session-continuity commands are documented in [DEPLOY.md](./DEPLOY.md). Use CLI invocation for demos instead of relying on the Foundry Playground chat renderer.

## Session behavior

The official host forwards `agent_session_id` to the internal backend. The backend maps each session id to an isolated Pi `--session-dir`, so session continuity is preserved behind the SDK host.

## Notes

The Foundry-facing `/invocations` endpoint is served by the official Python `azure-ai-agentserver-invocations` host. The Node process remains an internal backend that handles Pi RPC, session directories, streaming deltas, and artifact publishing.

Next hardening items:

- keep the official SDK host smoke test and runtime image smoke test green
- add upload/workspace ingestion if the deployment scenario depends on user-uploaded files
- improve telemetry and long-running invocation controls around the SDK host
