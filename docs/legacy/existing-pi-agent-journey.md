# Legacy: bring an existing Pi agent to Foundry with the old wrapper flow

> Legacy/internal only. The user-facing path is now the azd-native in-repo adapter: keep the existing Pi agent repo as the source of truth, install the thin adapter, and deploy with `azd up`. Do not recommend this wrapper flow to users unless explicitly investigating historical deployments.


This guide walks through the intended user journey for a developer who already has a local Pi agent project and wants to deploy it as a Microsoft Foundry Hosted Agent.

## Example scenario

You have a local Pi agent project named `media-report-agent`:

```text
media-report-agent/
  .agents/skills/
    edge-tts/
    hyperframes/
  mcp.config.json
  prompts/
  demo-workspace/
```

Locally, it can already run Pi workflows such as:

```bash
cd media-report-agent
pi "Create a narrated Chinese HTML product update presentation."
```

The goal is not to rewrite the agent. The goal is to wrap it with the `pi-foundry` template so it can run behind Foundry Invocations, preserve sessions, stream output, and return generated artifact links.

## 1. Create a Foundry wrapper project

Short-term, clone or use this repo as a template:

```bash
git clone <pi-foundry-template-repo> media-report-foundry
cd media-report-foundry
```

Future template experience can be:

```bash
azd init --template <pi-foundry-template-repo>
```

## 2. Configure the wrapper agent name

Copy the example high-level config and set the wrapper's Foundry agent name:

```bash
cp agent.config.example.yaml agent.config.yaml
npm run configure:agent -- media-report-foundry
```

Use `--dry-run` to preview changes:

```bash
npm run configure:agent -- media-report-foundry --dry-run
```

This updates the template identity across `package.json`, `azure.yaml`, `agent.yaml`, `agent.manifest.yaml`, and `agent.config.yaml` if present. It does not change runtime code.

If you want to update the placeholder image in `agent.yaml`, pass your ACR endpoint:

```bash
npm run configure:agent -- media-report-foundry --acr=<registry>.azurecr.io
```

## 3. Import your existing Pi agent assets

Run:

```bash
npm run import:pi-agent -- ../media-report-agent
```

Preview first without copying:

```bash
npm run import:pi-agent -- ../media-report-agent --dry-run
```

Overwrite existing destinations if you intentionally want to replace them:

```bash
npm run import:pi-agent -- ../media-report-agent --overwrite
```

The importer copies common Pi agent assets:

```text
.agents/skills/*
mcp.config.json
mcp.json
.mcp.json
prompts/
demo-workspace/
```

Default behavior is safe: existing destinations are skipped unless `--overwrite` is supplied.

If the importer finds demo-capable skills such as `edge-tts`, `hyperframes`, or `gpt-image-2`, it prints a note. These skills are not required by the runtime bridge; they demonstrate that real Pi skill workflows can execute remotely and produce artifacts.

## 4. Configure the high-level agent contract

Edit `agent.config.yaml` to describe your agent:

```yaml
name: media-report-agent
displayName: Media Report Agent
description: Generates narrated HTML reports using Pi, edge-tts, and hyperframes.

runtime:
  type: pi-rpc
  command: pi
  args:
    - --mode
    - rpc
    - --no-session
  provider: foundry
  model: <foundry-model-or-deployment>

skills:
  path: .agents/skills

mcp:
  optional: true
  config: mcp.config.json

artifacts:
  enabled: true
  mode: static-web
  manifest: artifact-manifest.json
```

Today this file documents the intended contract. Runtime deployment still reads `azd` environment values and the lower-level YAML files directly. Future iterations can use `agent.config.yaml` to generate or validate more of the deployment configuration.

## 5. Configure Foundry and model settings

Create/select an `azd` environment:

```bash
azd env new media-report-agent
```

Set Pi runtime values:

```bash
azd env set PI_MOCK 0
azd env set REQUEST_TIMEOUT_MS 600000
azd env set 'PI_ARGS=--mode rpc --no-session --provider foundry --model <foundry-model-or-deployment>'
azd env set PI_OPENAI_BASE_URL 'https://<account>.cognitiveservices.azure.com/openai/v1'
azd env set PI_OPENAI_MODEL '<foundry-model-or-deployment>'
azd env set PI_OPENAI_API_KEY '<key>'
```

Set artifact publishing if you want remote clickable links:

```bash
azd env set ARTIFACT_PUBLISH_MODE static-web
azd env set ARTIFACT_STORAGE_ACCOUNT '<storage-account>'
azd env set ARTIFACT_STATIC_WEB_ENDPOINT 'https://<storage-account>.<zone>.web.core.windows.net'
azd env set 'ARTIFACT_STATIC_WEB_CONTAINER=$web'
azd env set ARTIFACT_BLOB_PREFIX media-report-agent
```

Set any third-party credentials your skills need:

```bash
azd env set GITHUB_TOKEN '<token>'
azd env set JIRA_TOKEN '<token>'
```

Avoid user-defined environment variables starting with `AGENT_` or `FOUNDRY_`. Foundry reserves those prefixes.

## 6. Run doctor

Before deployment:

```bash
npm run doctor
```

The doctor checks local tools, Docker access, azd environment values, Foundry resource tiers, reserved environment variable prefixes, Pi runtime settings, and artifact publishing configuration.

If Docker permission is denied but `azure.yaml` has `remoteBuild: true`, remote deployment can still work through `azd deploy`.

## 7. Test locally

Mock mode verifies the wrapper without model credentials:

```bash
PI_MOCK=1 npm start
npm run smoke
```

If local Pi and model credentials are configured:

```bash
npm start
npm run smoke
npm run smoke:sse
npm run smoke:session
```

## 8. Deploy to Foundry

Deploy:

```bash
azd deploy --no-prompt
```

`azd` prints the Hosted Agent version and invocations endpoint.

## 9. Invoke remotely
If artifact publishing is enabled for a newly deployed Hosted Agent, make sure the new agent identities have `Storage Blob Data Contributor` on the artifact storage account or `$web` container. Use:

```bash
npm run grant:artifact-rbac -- media-report-agent <storage-account>
```

The script reads the deployed agent instance and blueprint identities from `azd ai agent show`, resolves the storage account resource id, and grants `Storage Blob Data Contributor` with Azure Management REST APIs using your `azd` login.

If the agent can generate files but publishing fails with `This request is not authorized to perform this operation using this permission`, run the grant command and retry the artifact invocation after RBAC propagation.

Example invocation:

```bash
azd ai agent invoke media-report-agent \
  --protocol invocations \
  --new-session \
  --timeout 900 \
  'Create a 3-minute narrated Chinese product update presentation. Use edge-tts for narration and hyperframes for a browser-playable HTML artifact. Save files under the instructed artifact directory, write artifact-manifest.json, and reply concisely.'
```

Or run the built-in remote artifact demo:

```bash
AGENT_NAME=media-report-agent AGENT_VERSION=<version> npm run demo:remote:artifact
```

Expected flow:

```text
Foundry Invocations endpoint
  -> pi-foundry container
  -> pi --mode rpc
  -> edge-tts / hyperframes skills
  -> generated files under artifact directory
  -> optional Azure Storage Static Website publishing
  -> response with artifact links
```

Example output shape:

```md
Done. Generated a narrated HTML report.

Artifacts:

- [Report](https://<storage>.web.core.windows.net/media-report-agent/<date>/<request-id>/index.html)
- [Narration](https://<storage>.web.core.windows.net/media-report-agent/<date>/<request-id>/narration.mp3)
```

## What success feels like

You should not have to learn or rewrite Foundry Invocations, SSE streaming, session mapping, Docker readiness, or artifact publishing. You should only bring your Pi agent assets and configure the deployment environment.

The template-owned runtime handles:

- `/invocations`
- `agent_session_id`
- Pi RPC lifecycle
- per-session Pi session directories
- SSE streaming
- generated artifact collection/publishing
- Docker and azd deployment shape

Your agent-owned layer handles:

- skills
- MCP
- prompts
- model choice
- credentials
- generated artifact behavior
