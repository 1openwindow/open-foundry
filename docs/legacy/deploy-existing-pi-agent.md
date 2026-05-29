# Legacy: deploy an existing Pi agent with the old wrapper flow

> Legacy/internal only. The user-facing path is now the azd-native in-repo adapter: install `.azd/pi-foundry/*` into the existing Pi agent repo and deploy with `azd up`. Do not recommend this wrapper flow to users unless explicitly investigating historical deployments.


This is the short checklist for bringing an existing local Pi agent project to Microsoft Foundry Hosted Agents with `pi-foundry`.

For the narrative walkthrough, see [existing-pi-agent-journey.md](./existing-pi-agent-journey.md).

## Prerequisites

- `azd` installed and authenticated.
- `azd` extension `azure.ai.agents` installed.
- A Microsoft Foundry project endpoint and Azure AI project id.
- A Foundry/OpenAI-compatible model endpoint and API key, or another Pi model/provider setup.
- Optional: Azure Storage Static Website for clickable artifact links.

Check local tools:

```bash
npm run validate
```

## Runtime mode

For local development, `npm start` runs the Node direct server. For official Invocations mode, use:

```bash
npm run smoke:official
```

For Foundry deployments that should use the official protocol host, build with `Dockerfile.official` or configure your deployment project to use the official entrypoint. Keep Node direct mode available for local debugging and fallback deployments.

## Fast path: create a wrapper from this template

From the `pi-foundry` template repo, create a new wrapper and import an existing Pi agent in one step:

```bash
npm run create:wrapper -- \
  --name <agent-name> \
  --target ~/repos/<agent-name> \
  --from <path-to-existing-pi-agent> \
  --mode official \
  --acr <registry>.azurecr.io
```

Then copy known-good environment values from an existing working repo:

```bash
cd ~/repos/<agent-name>
npm run copy:azd-env -- \
  --from ~/repos/pi-foundry \
  --env <agent-name> \
  --artifact-prefix <agent-name>
```

Deploy and grant artifact RBAC:

```bash
npm run deploy:foundry
```

The manual steps below are kept for transparency and external users who do not have a working source env to copy from.

## 1. Create/configure the wrapper project manually

From a fresh copy of this template:

```bash
cp agent.config.example.yaml agent.config.yaml
npm run configure:agent -- <agent-name>
```

If you want to update the placeholder direct image reference in `agent.yaml`:

```bash
npm run configure:agent -- <agent-name> --acr=<registry>.azurecr.io
```

## 2. Import the existing Pi agent assets

Preview first:

```bash
npm run import:pi-agent -- <path-to-existing-pi-agent> --dry-run
```

Import:

```bash
npm run import:pi-agent -- <path-to-existing-pi-agent>
```

This copies common user-owned assets such as:

```text
.agents/skills/*
mcp.config.json
mcp.json
.mcp.json
prompts/
demo-workspace/
```

## 3. Configure azd environment

Create/select an environment:

```bash
azd env new <agent-name>
```

Set Foundry project values:

```bash
azd env set FOUNDRY_PROJECT_ENDPOINT '<foundry-project-endpoint>'
azd env set AZURE_AI_PROJECT_ID '<azure-ai-project-id>'
azd env set AZURE_CONTAINER_REGISTRY_ENDPOINT '<registry>.azurecr.io'
```

Set Pi/model values:

```bash
azd env set PI_MOCK 0
azd env set REQUEST_TIMEOUT_MS 600000
azd env set ENABLE_DIAGNOSTICS 0
azd env set 'PI_ARGS=--mode rpc --no-session --provider foundry --model <foundry-model-or-deployment>'
azd env set PI_OPENAI_BASE_URL 'https://<account>.cognitiveservices.azure.com/openai/v1'
azd env set PI_OPENAI_MODEL '<foundry-model-or-deployment>'
azd env set PI_OPENAI_API_KEY '<key>'
```

Optional artifact publishing:

```bash
azd env set ARTIFACT_PUBLISH_MODE static-web
azd env set ARTIFACT_STORAGE_ACCOUNT '<storage-account>'
azd env set ARTIFACT_STATIC_WEB_ENDPOINT 'https://<storage-account>.<zone>.web.core.windows.net'
azd env set 'ARTIFACT_STATIC_WEB_CONTAINER=$web'
azd env set ARTIFACT_BLOB_PREFIX '<agent-name>'
```

Set any extra credentials your skills need, for example:

```bash
azd env set GITHUB_TOKEN '<token>'
azd env set JIRA_TOKEN '<token>'
```

## 4. Run doctor

```bash
npm run doctor
```

Resolve failures before deployment. Warnings about Docker socket permission are not blocking when `azure.yaml` uses `remoteBuild: true`.

## 5. Deploy

```bash
azd deploy --no-prompt
```

Record the deployed version from the output, or query it:

```bash
azd env get-values | grep AGENT_
```

## 6. Grant artifact publishing RBAC

If `ARTIFACT_PUBLISH_MODE=static-web`, grant the deployed Hosted Agent identities write access to the artifact storage account:

```bash
npm run grant:artifact-rbac -- <agent-name> <storage-account>
```

RBAC propagation can take a minute. If artifact publishing fails with `This request is not authorized to perform this operation using this permission`, rerun the grant command and retry after propagation.

## 7. Smoke test remote invocation

```bash
azd ai agent invoke <agent-name> \
  --protocol invocations \
  --version <version> \
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

## 8. Smoke test remote artifacts

```bash
npm run demo:remote:artifact -- <agent-name> <version>
```

Expected output includes markdown artifact links and an `artifacts` array with URLs.

## 9. Troubleshooting quick hits

- `AGENT_*` and `FOUNDRY_*` are reserved prefixes. Use `PI_*`, `APP_*`, or skill-specific names for custom inputs.
- Use valid Hosted Agent resource tiers such as `1/2Gi` or `2/4Gi`.
- Keep runtime code (`/app`), workspace (`/workspace`), generated files (`/files`), and session state separate.
- `agent.config.yaml` documents the high-level contract, while deployment still uses `azd` env values and YAML files directly.
- `STATUS.md` is an internal handoff for one known-good environment, not a template default.
