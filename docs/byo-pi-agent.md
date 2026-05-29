# Bring Your Own Pi Agent to Foundry

`pi-foundry` deploys an existing Pi agent repo to Microsoft Foundry Hosted Agents with a skill-managed, azd-compatible in-repo adapter.

You bring Pi skills, MCP servers, tools, prompts, model configuration, and environment variables. `pi-foundry` provides the Foundry Invocations bridge, Pi RPC lifecycle, session mapping, streaming, Docker packaging, health/readiness endpoints, and artifact delivery through a versioned runtime image.

Default UX:

```text
cd my-existing-pi-agent
# In Pi: ask the pi-foundry skill to deploy this agent to Foundry.
node .azd/pi-foundry/doctor.mjs
azd up
```

No wrapper repo is required. The existing Pi agent repo remains the source of truth.

## Mental model

```text
Developer-owned Pi repo
  - .agents/skills/
  - MCP servers
  - prompts and instructions
  - model/provider choices
  - tool credentials and env vars
  - artifact behavior
        |
        v
Thin azd adapter in the same repo
  - azure.yaml
  - .dockerignore
  - .azd/pi-foundry/pi-foundry.yaml (created by the pi-foundry skill)
  - .azd/pi-foundry/generated/agent.yaml (generated)
  - .azd/pi-foundry/generated/agent.manifest.yaml (generated)
  - .azd/pi-foundry/Dockerfile (generated)
  - .azd/pi-foundry/doctor.mjs
  - .azd/pi-foundry/postdeploy.mjs
        |
        v
Versioned pi-foundry runtime image
  - /invocations HTTP endpoint
  - pi --mode rpc bridge
  - Foundry agent_session_id -> Pi session dir
  - SSE streaming
  - artifact collection/publishing
  - health/readiness
        |
        v
Microsoft Foundry platform layer
  - Hosted Agent container
  - endpoint, identity, deployment, versions
  - model endpoint access
  - logs and monitoring
```

## What you should customize

A typical Pi agent owner customizes their existing repo:

- `.agents/skills/` for Pi skills.
- MCP configuration, if your Pi setup uses MCP servers.
- Prompts and workspace/demo content.
- `PI_ARGS`, `PI_OPENAI_*`, and model/provider environment values in `azd env`.
- Third-party credentials such as `GITHUB_TOKEN`, `JIRA_TOKEN`, or service-specific tokens in the deployment environment.
- Artifact conventions such as `artifact-manifest.json`.

## What pi-foundry owns

You should not need to edit runtime source for the common path. The runtime lives in a versioned base image and owns:

- Foundry Invocations server and Pi RPC bridge.
- Official Invocations host integration.
- Session mapping.
- Streaming response handling.
- Artifact collection/publishing support.
- Health/readiness endpoints.

The adapter only adds deployment configuration to the existing repo.

## Install the skill-managed adapter

From the existing Pi agent repo, ask the pi-foundry skill to deploy the current agent to Foundry. For local development of this repo, the equivalent script entrypoint is:

```bash
cd <existing-pi-agent-path>
node ~/repos/pi-foundry/.agents/skills/pi-foundry/scripts/install-adapter.mjs --environment <agent-name>
```

The installer explains and materializes the adapter without creating a wrapper repo. If an existing `azure.yaml` is not pi-foundry-managed, the installer refuses to replace it unless the user explicitly confirms replacement with `--replace-azure`; confirmed replacement is backed up first.

Files installed from the skill adapter bundle:

```text
azure.yaml
.dockerignore
.azd/pi-foundry/README.md
.azd/pi-foundry/render.mjs
.azd/pi-foundry/doctor.mjs
.azd/pi-foundry/postdeploy.mjs
```

The pi-foundry skill creates the human-facing deployment config:

```text
.azd/pi-foundry/pi-foundry.yaml
```

`render.mjs` materializes generated deployment files before package/deploy:

```text
.azd/pi-foundry/Dockerfile
.azd/pi-foundry/pi-foundry.lock.yaml
.azd/pi-foundry/generated/agent.yaml
.azd/pi-foundry/generated/agent.manifest.yaml
```

The adapter does not modify `.agents/skills/`, prompts, MCP config, demo workspace, or business code. The pi-foundry skill infers or asks for the Hosted Agent name, creates `.azd/pi-foundry/pi-foundry.yaml`, and renders generated files. Customize `.azd/pi-foundry/pi-foundry.yaml` after init if you need a different hosted agent name, runtime image, or resource tier, then run `node .azd/pi-foundry/render.mjs`. `azure.yaml`, `.azd/pi-foundry/Dockerfile`, and `.azd/pi-foundry/generated/*` are generated from that source config. Secrets and environment-specific values remain in `azd env`, not YAML.

## Runtime image

The generated adapter Dockerfile uses a runtime base image. The current internal validation default is:

```dockerfile
ARG PI_FOUNDRY_RUNTIME_IMAGE=crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0
FROM ${PI_FOUNDRY_RUNTIME_IMAGE}

WORKDIR /app
COPY . /workspace
```

Build locally when Docker is available:

```bash
PI_FOUNDRY_RUNTIME_IMAGE=<registry>.azurecr.io/pi-foundry-runtime:0.1.0 npm run runtime:build
```

Or build remotely with ACR when Docker is unavailable:

```bash
npm run runtime:acr-build -- \
  --registry <registry>.azurecr.io \
  --image pi-foundry-runtime:0.1.0
```

See [runtime-image.md](./runtime-image.md) for details.

## Runtime variables

Use `azd env` for runtime values. Do not commit secrets.

| Variable | Purpose |
|---|---|
| `PI_ARGS` | Pi command arguments. Should include `--mode rpc`; the runtime handles per-session `--session-dir`. |
| `PI_MOCK` | Set to `1` only for mock testing without model credentials. |
| `REQUEST_TIMEOUT_MS` | Request timeout for longer agent tasks. |
| `ENABLE_DIAGNOSTICS` | Set to `0` unless temporarily debugging diagnostics. |
| `PI_OPENAI_API_KEY` | API key used to generate the Pi `foundry` provider. |
| `PI_OPENAI_BASE_URL` | OpenAI-compatible Foundry/account endpoint. |
| `PI_OPENAI_MODEL` | Foundry deployment/model name. |
| `ARTIFACT_PUBLISH_MODE` | Set to `static-web` to publish generated artifacts to Azure Storage Static Website. |

Avoid custom environment variables starting with `FOUNDRY_` or `AGENT_`; those prefixes are reserved by Foundry Hosted Agents.

Typical setup:

```bash
cd <existing-pi-agent-path>
azd env new <env-name>
azd env set AZURE_CONTAINER_REGISTRY_ENDPOINT '<registry>.azurecr.io'
azd env set PI_MOCK 0
azd env set REQUEST_TIMEOUT_MS 600000
azd env set ENABLE_DIAGNOSTICS 0
azd env set 'PI_ARGS=--mode rpc --no-session --provider foundry --model <model>'
azd env set PI_OPENAI_API_KEY '<key>'
azd env set PI_OPENAI_BASE_URL 'https://<account>.cognitiveservices.azure.com/openai/v1'
azd env set PI_OPENAI_MODEL '<model>'
```

Artifact publishing, if needed:

```bash
azd env set ARTIFACT_PUBLISH_MODE static-web
azd env set ARTIFACT_STORAGE_ACCOUNT '<storage-account>'
azd env set ARTIFACT_STATIC_WEB_ENDPOINT 'https://<storage-account>.<zone>.web.core.windows.net'
azd env set 'ARTIFACT_STATIC_WEB_CONTAINER=$web'
azd env set ARTIFACT_BLOB_PREFIX '<agent-name>'
```

## Doctor and deploy

Run the adapter doctor from the existing Pi agent repo:

```bash
node .azd/pi-foundry/doctor.mjs
```

Deploy:

```bash
azd up
```

The adapter's `azd up` workflow runs:

```text
node .azd/pi-foundry/doctor.mjs
azd package --all
azd deploy --all
node .azd/pi-foundry/postdeploy.mjs
```

The postdeploy script prints the invoke command and attempts artifact RBAC automation when `ARTIFACT_PUBLISH_MODE=static-web`.

## Invoke

```bash
azd ai agent invoke <agent-name> \
  --protocol invocations \
  --version <version> \
  --new-session \
  --timeout 900 \
  'Say exactly: ok'
```

Expected:

```json
{
  "output": "ok",
  "mock": false
}
```

## Artifacts

For downloadable outputs, ask Pi skills or prompts to write files under the artifact directory injected by the runtime. When useful, write an `artifact-manifest.json` next to generated files:

```json
{
  "artifacts": [
    {
      "path": "index.html",
      "name": "Report",
      "description": "Main HTML report",
      "contentType": "text/html; charset=utf-8"
    }
  ]
}
```

See [artifacts.md](./artifacts.md) for publishing details.

## Common migration pitfalls

- **Reserved env vars**: do not define custom `AGENT_*` or `FOUNDRY_*` variables.
- **Resource tiers**: use valid Hosted Agent CPU/memory pairs such as `1/2Gi` or `2/4Gi`.
- **Local vs container paths**: runtime code lives under `/app`; user agent assets are copied to `/workspace`; generated artifacts live under `/files`.
- **Artifacts**: local `/artifacts/<path>` is not exposed through the Foundry front door; use static website publishing for remote clickable links.
- **Secrets**: `.azure/` and local `.env` files must not be committed.
