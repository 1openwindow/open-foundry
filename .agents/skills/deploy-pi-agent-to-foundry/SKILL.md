---
name: deploy-pi-agent-to-foundry
description: Helps initialize, validate, deploy, invoke, and troubleshoot an existing Pi agent on Microsoft Foundry Hosted Agents using the pi-foundry azd-native in-repo adapter. Use when the user wants to add Foundry deployment to a local Pi agent repo, configure azd/PI_* settings, run adapter doctor, deploy with azd up, verify remote invocations, or debug deployment, session, streaming, and artifact issues.
---

# Deploy Pi Agent to Foundry

Use this skill as the UX/onboarding layer for the `pi-foundry` azd-native adapter. The user should be able to say things like:

- "把我这个 Pi agent 部署到 Foundry。"
- "帮我给当前 repo 加 Foundry 部署。"
- "帮我检查为什么 azd up 失败。"
- "跑一下远程 artifact demo。"

Your job is to provide the natural-language UX while using `azd` as the deployment engine. The user should stay in their current repo and say the goal; you should inspect, ask for missing values, run the right `azd` commands, explain results, and recover from errors.

Keep the user on one path:

```text
existing Pi agent repo -> azd init --template -> runtime base image -> azd up -> Foundry Hosted Agent
```

Do **not** ask the user to `cd` into `pi-foundry`. Do **not** introduce a separate CLI. Do **not** create a wrapper repo. Do **not** copy user assets into a separate deployment repo. Do **not** vendor pi-foundry runtime source into the user's repo.

## Mental model

Explain the product as three layers:

```text
User-owned Pi agent repo
  - .agents/skills/
  - prompts/
  - MCP config
  - demo-workspace/
  - tool/model credentials via azd env
        |
        v
Thin azd adapter in the same repo
  - azure.yaml
  - agent.yaml
  - agent.manifest.yaml
  - .dockerignore
  - .azd/pi-foundry/Dockerfile
  - .azd/pi-foundry/doctor.mjs
  - .azd/pi-foundry/postdeploy.mjs
        |
        v
Versioned pi-foundry runtime image
  - Foundry Invocations bridge
  - Pi RPC lifecycle
  - sessions
  - streaming
  - artifact publishing
        |
        v
Microsoft Foundry Hosted Agents
```

Default recommendation:

- The user stays in their existing Pi agent repo.
- The skill is the UX layer; `azd` is the only deployment toolchain the user needs to know.
- Initialize with `azd init --template ... . --environment <agent-name>` when `.azd/pi-foundry/` is missing.
- Add deployment configuration only.
- Use `node .azd/pi-foundry/doctor.mjs` for preflight validation.
- Use `azd up` as the canonical deploy command.
- Keep user business code, skills, prompts, and MCP config unchanged unless explicitly asked.
- Use a versioned pi-foundry runtime base image.

## First steps every time

1. Identify the current directory type:
   - Existing Pi agent repo: has `.agents/skills/`, `prompts/`, `mcp.config.json`, or `demo-workspace/`.
   - Already adapted repo: has `azure.yaml` and `.azd/pi-foundry/Dockerfile`.
   - pi-foundry development checkout: has `templates/azd-native/`.
2. Inspect status with safe commands:
   - `pwd`
   - `git status --short` when inside a git repo
   - `find . -maxdepth 3 ...` for relevant files if needed
3. If the adapter is missing, initialize with azd from the user's current repo. `azd init` warns before copying template files into a non-empty directory.
4. Before deploy, run from the user repo:
   - `node .azd/pi-foundry/doctor.mjs`
5. Do not merely print a long command list if the user asked you to do the work. Execute safe inspections and ask for confirmation before mutating operations.

## Core workflow: existing Pi agent -> Foundry deployment

Use this when the user has a local Pi agent and wants it on Foundry.

### Inputs to collect

Ask only for missing values:

- Existing Pi agent path, default to current directory if it looks like a Pi agent.
- Agent/deployment name, e.g. `media-report-agent`.
- ACR endpoint, e.g. `<registry>.azurecr.io`.
- Runtime image, usually `<registry>.azurecr.io/pi-foundry-runtime:0.1.0`; set it as `PI_FOUNDRY_RUNTIME_IMAGE` in `azd env`.
- Foundry/model values later, only when configuring deploy:
  - `PI_OPENAI_BASE_URL`
  - `PI_OPENAI_MODEL`
  - `PI_OPENAI_API_KEY`
  - optional artifact storage values.

Never print secrets. Do not write secrets into repo files.

### Initialize adapter with azd

From the existing Pi agent repo, initialize with azd:

```bash
azd init --template <pi-foundry-azd-template> . --environment <agent-name>
```

For local development before the template is published as a standalone repo, use the local template path while still running from the user's repo:

```bash
azd init --template ~/repos/pi-foundry/templates/azd-native . --environment <agent-name>
```

`azd init` warns when the current directory is not empty and asks for confirmation before copying template files into the repo. Treat that prompt as the user's approval point.

Explain clearly that this adds deployment configuration files only:

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

It should not modify `.agents/skills/`, prompts, MCP config, demo workspace, or user business code. Existing deployment files are skipped unless `--overwrite` is explicitly supplied.

## Runtime image

The adapter expects a published pi-foundry runtime base image. If a runtime image is not available yet, build one from the pi-foundry repo.

Local Docker build:

```bash
PI_FOUNDRY_RUNTIME_IMAGE=<registry>.azurecr.io/pi-foundry-runtime:0.1.0 npm run runtime:build
```

ACR remote build when local Docker is unavailable:

```bash
npm run runtime:acr-build -- \
  --registry <registry>.azurecr.io \
  --image pi-foundry-runtime:0.1.0
```

Known-good internal runtime image:

```text
crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0
```

## Configure Foundry/model environment

Use `azd env` in the user's existing Pi agent repo. Do not commit secrets.

Typical values:

```bash
azd env new <env-name>
azd env set AZURE_CONTAINER_REGISTRY_ENDPOINT '<registry>.azurecr.io'
azd env set PI_FOUNDRY_RUNTIME_IMAGE '<registry>.azurecr.io/pi-foundry-runtime:0.1.0'
azd env set PI_MOCK 0
azd env set REQUEST_TIMEOUT_MS 600000
azd env set ENABLE_DIAGNOSTICS 0
azd env set 'PI_ARGS=--mode rpc --no-session --provider foundry --model <model>'
azd env set PI_OPENAI_BASE_URL 'https://<account>.cognitiveservices.azure.com/openai/v1'
azd env set PI_OPENAI_MODEL '<model>'
azd env set PI_OPENAI_API_KEY '<secret>'
```

Artifact publishing, if needed:

```bash
azd env set ARTIFACT_PUBLISH_MODE static-web
azd env set ARTIFACT_STORAGE_ACCOUNT '<storage-account>'
azd env set ARTIFACT_STATIC_WEB_ENDPOINT 'https://<storage-account>.<zone>.web.core.windows.net'
azd env set 'ARTIFACT_STATIC_WEB_CONTAINER=$web'
azd env set ARTIFACT_BLOB_PREFIX '<agent-name>'
```

Warn the user:

- Avoid custom `AGENT_*` and `FOUNDRY_*` variables; Foundry reserves those prefixes.
- Prefer `*.cognitiveservices.azure.com/openai/v1` for the OpenAI-compatible endpoint unless their environment requires another endpoint.
- `.azure/` and `.env` must remain uncommitted.

## Doctor and deploy

From the user's existing Pi agent repo:

```bash
node .azd/pi-foundry/doctor.mjs
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

## Verify remote behavior

Basic invocation:

```bash
azd ai agent invoke <agent-name> \
  --protocol invocations \
  --version <version> \
  --new-session \
  --timeout 900 \
  'Say exactly: ok'
```

Expected response includes JSON with roughly:

```json
{
  "output": "ok",
  "mock": false
}
```

Artifact demo, from a pi-foundry checkout if using the current repo script:

```bash
scripts/demo-remote-artifact.sh <agent-name> <version>
```

Expected behavior:

- response includes markdown artifact links or a structured `artifacts` array
- static website artifact URLs return HTTP 200

## Troubleshooting playbook

Start from the user's existing Pi agent repo:

```bash
node .azd/pi-foundry/doctor.mjs
azd ai agent doctor --no-prompt
azd ai agent show <agent-name> --output json --no-prompt
azd ai agent monitor <agent-name> --tail 100 --type console
```

Common issues and actions:

### Deployment succeeds but invoke fails

Check:

- `PI_MOCK=0`
- `PI_ARGS` includes `--mode rpc --provider foundry --model <model>`
- `PI_OPENAI_API_KEY` is set in `azd env`, not committed files
- `PI_OPENAI_BASE_URL` is the OpenAI-compatible endpoint, often `https://<account>.cognitiveservices.azure.com/openai/v1`
- Hosted Agent version passed to `azd ai agent invoke` is the current deployed version

### Readiness or container startup fails

Check:

- thin adapter Dockerfile uses the intended pi-foundry runtime image
- `azure.yaml` startup command is `/app/runtime/official-invocations/entrypoint.sh`
- public container port convention is `8088`
- `GET /readiness` must return HTTP 200

### Artifact links missing or 403/404

Check:

- `ARTIFACT_PUBLISH_MODE=static-web`
- `ARTIFACT_STORAGE_ACCOUNT` and `ARTIFACT_STATIC_WEB_ENDPOINT` are set
- postdeploy ran successfully
- agent identities have `Storage Blob Data Contributor`

Remember: local `/artifacts/<path>` is not exposed through Foundry front door; remote clickable artifacts are published to Azure Storage Static Website.

### ACR/image pull issues

Check ACR permissions for Foundry identities. Run `node .azd/pi-foundry/doctor.mjs` and `azd ai agent doctor --no-prompt` first. If needed, inspect deployment/agent identities using `azd ai agent show <agent-name> --output json --no-prompt` and assign appropriate ACR pull/read roles.

### User asks whether to create a wrapper repo

Default answer: no. The user-facing product path is azd-native in-repo deployment. A wrapper repo creates source-of-truth confusion and is not part of the recommended UX.

## Documentation to consult when needed

Read these project docs when the user asks for details or when troubleshooting needs more context:

- `README.md` — top-level quickstart and runtime modes
- `docs/azd-native-ux.md` — azd-native in-repo adapter UX direction
- `docs/runtime-image.md` — runtime base image build/smoke/publish flow
- `docs/artifacts.md` — artifact publishing details
- `docs/demo-checklist.md` — current azd-native demo commands
- `DEPLOY.md` — remote Foundry invocation and deployment troubleshooting
- `docs/handoff.md` — current known-good internal deployment state

## Communication style

- Keep the user on the azd-native happy path.
- State assumptions before running mutating commands.
- Ask for missing names/endpoints/paths only when necessary.
- Translate tool output into concrete next actions.
- Treat adapter doctor output as the primary source of actionable environment feedback.
