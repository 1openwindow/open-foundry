# pi-foundry

A runtime and azd-native adapter for deploying an existing Pi agent to Microsoft Foundry Hosted Agents.

You bring Pi skills, MCP servers, tools, prompts, model/provider configuration, and environment variables. `pi-foundry` provides the Foundry Invocations bridge, Pi RPC lifecycle, session mapping, streaming, Docker packaging, health/readiness endpoints, and artifact delivery.

The primary user experience is now:

```text
cd my-existing-pi-agent
# add a thin azd adapter, not a wrapper repo
azd up
```

No wrapper repo is required for the default path. The user's existing Pi agent repo remains the source of truth; only deployment configuration is added. The pi-foundry runtime is supplied by a versioned base image instead of vendoring runtime source into the user's repo.

This path has been validated end-to-end with `media-report-agent` v3 using `crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0`. See [docs/azd-native-ux.md](./docs/azd-native-ux.md) for the UX direction and [docs/runtime-image.md](./docs/runtime-image.md) for runtime image build/publish details.

## Runtime modes

`pi-foundry` now keeps two supported runtime modes:

### Official Invocations mode

Recommended for Foundry deployment experiments and future production hardening. The public container port is served by the official Python `azure-ai-agentserver-invocations` host, which proxies to the Node Pi backend on `127.0.0.1:18080`:

```text
Foundry /invocations
  -> official Invocations host
  -> Node Pi backend
  -> pi --mode rpc
```

Use `Dockerfile.official` or the runtime files under `runtime/official-invocations/` for this mode. Validate it locally with:

```bash
npm run smoke:official
```

### Node direct mode

Recommended for local development, fast debugging, backend validation, and fallback deployments. The Node server directly exposes `/invocations` and is also the backend used by official mode:

```bash
PI_MOCK=1 npm start
npm run smoke
```

Current Node backend shape:

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

The common azd-native path should not require changing user business code, skills, prompts, or MCP config. It adds deployment files such as `azure.yaml`, `agent.yaml`, `agent.manifest.yaml`, `.dockerignore`, and `.azd/pi-foundry/*`.

### Agentic onboarding skill

This template includes a project skill at `.agents/skills/deploy-pi-agent-to-foundry/SKILL.md`. In Pi, users can ask naturally, for example:

```text
把我这个 Pi agent 部署到 Foundry。
帮我给当前 repo 加 Foundry 部署。
帮我检查为什么 artifact demo 失败。
```

The skill acts as the UX layer for vibe-coding workflows: it identifies whether the current directory is an existing Pi agent repo or a pi-foundry development checkout; prefers dry-runs before mutating actions; defaults to the azd-native adapter path; and translates failures into concrete next steps. It does not replace the runtime/template layer.

### Azd-native adapter quickstart

The default UX is to add deployment configuration to the user's existing Pi agent repo and keep `azd up` as the canonical command. The thin adapter lives under `templates/azd-native/` and can be installed from this development checkout with:

```bash
cd ~/repos/pi-foundry
npm run install:azd-adapter -- \
  --target ~/repos/my-agent \
  --name my-agent \
  --acr <registry>.azurecr.io \
  --dry-run
```

After review, run without `--dry-run`, configure `azd env` values in the target repo, run the adapter doctor, and use `azd up`:

```bash
cd ~/repos/my-agent
node .azd/pi-foundry/doctor.mjs
azd up
```

This path expects a published pi-foundry runtime base image; build it locally with `npm run runtime:build` or remotely with `npm run runtime:acr-build`, then smoke locally with `npm run runtime:smoke` when Docker is available (see [docs/runtime-image.md](./docs/runtime-image.md)). This path has been validated end-to-end with `media-report-agent` v3 using `crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0`.

> Note: [STATUS.md](./STATUS.md) is an internal handoff file for known-good deployment environments. Template users should follow the generic README/docs and replace placeholders with their own Foundry, model, ACR, and storage values.

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

```bash
cd ~/repos/pi-foundry
PI_MOCK=1 npm start
```

In another shell:

```bash
npm run smoke
```

Expected invocation output contains `mock response: Say exactly: ok`.

## Local smoke test against installed pi

From this machine, with model credentials already configured for pi:

```bash
cd ~/repos/pi-foundry
npm start
```

The server uses the installed `pi` binary by default. Only set `PI_BIN` when you intentionally want to point at another executable.

Then:

```bash
npm run smoke
npm run smoke:sse
```

If testing with `curl`, bypass local HTTP proxy variables for loopback calls:

```bash
curl --noproxy '*' -sS http://127.0.0.1:8080/health
curl --noproxy '*' -sS http://127.0.0.1:8080/invocations \
  -H 'content-type: application/json' \
  -d '{"message":"List files in the current directory."}'
```

Or run:

```bash
npm run smoke:curl
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

Build:

```bash
npm run docker:build
```

The local build script uses `--network=host`, proxy build args, and `--pull=false`. This works around WSL/Docker daemon proxy issues after the base image exists locally.

Mock container smoke test:

```bash
npm run docker:smoke:mock
```

Real pi container smoke test using a temporary copy of the host pi auth/config:

```bash
npm run docker:smoke:real
```

Manual mock run:

```bash
docker run --rm -p 8080:8088 \
  -e PI_MOCK=1 \
  pi-foundry:local
```

Manual real run with Foundry OpenAI-compatible provider:

```bash
docker run --rm -p 8080:8088 \
  -e PI_OPENAI_API_KEY \
  -e PI_OPENAI_BASE_URL="https://<account>.cognitiveservices.azure.com/openai/v1" \
  -e PI_OPENAI_MODEL="<foundry-model-or-deployment>" \
  -e PI_ARGS="--mode rpc --no-session --provider foundry --model <foundry-model-or-deployment>" \
  pi-foundry:local
```

For local workspace mounting:

```bash
docker run --rm -p 8080:8088 \
  -v "$PWD:/workspace" \
  -e PI_MOCK=1 \
  pi-foundry:local
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

## Session smoke test

With a running real server:

```bash
BASE_URL=http://127.0.0.1:8080 npm run smoke:session
```

This verifies that the same `sessionId` can recall prior context and a different `sessionId` is isolated.

## Notes

This is not yet using the official Python/C# Foundry Invocations protocol library. It implements the relevant Invocations shape directly in Node:

- `/invocations` endpoint
- `agent_session_id` query parameter
- arbitrary JSON or plain-text request body
- JSON response for simple clients
- SSE response with `token` and `done` events for streaming clients
- OpenAPI at `/invocations/docs/openapi.json`

Next steps before Azure deployment:

- validate this Node container with `azd ai agent run` if the tool accepts a non-Python container
- otherwise wrap this Node service with the official Python `azure-ai-agentserver-invocations` host, or port the gateway to Python
- add upload/workspace ingestion if the deployment scenario depends on user-uploaded files
