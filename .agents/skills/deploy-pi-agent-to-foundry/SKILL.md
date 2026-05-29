---
name: deploy-pi-agent-to-foundry
description: Helps wrap, import, validate, deploy, invoke, and troubleshoot an existing Pi agent on Microsoft Foundry Hosted Agents using the pi-foundry template. Use when the user wants to bring a local Pi agent, skills, prompts, MCP config, or artifact workflow to Foundry; create a wrapper project; configure azd/PI_* settings; run doctor/deploy; verify remote invocations; or debug deployment, session, streaming, and artifact issues.
---

# Deploy Pi Agent to Foundry

Use this skill as the UX/onboarding layer for the `pi-foundry` template. The user should be able to say things like:

- "把我这个 Pi agent 部署到 Foundry。"
- "帮我创建 wrapper。"
- "帮我检查为什么 deploy 失败。"
- "跑一下远程 artifact demo。"

Your job is to translate that intent into the existing deterministic `pi-foundry` scripts and deployment workflow. Do **not** reimplement template logic in ad-hoc shell commands when a project script exists.

## Mental model

Explain the product as three layers:

```text
User-owned Pi agent layer
  - .agents/skills/
  - prompts/
  - MCP config
  - demo-workspace/
  - tool/model credentials
        |
        v
pi-foundry template/runtime layer
  - Foundry Invocations bridge
  - Pi RPC lifecycle
  - sessions
  - streaming
  - Docker/azd packaging
  - artifact publishing
        |
        v
Microsoft Foundry Hosted Agents
```

Default recommendation:

- Prefer the **azd-native in-repo adapter** for new users: stay in the user's existing Pi agent repo, add deployment configuration only, and use `azd up`.
- Do **not** vendor pi-foundry runtime source into the user's repo; the adapter should use a versioned runtime base image.
- Do **not** modify user business code, skills, prompts, or MCP config unless explicitly asked.
- Keep the older wrapper flow as an advanced/self-contained fallback until the runtime image and thin template are fully published.
- Use **official mode** for Foundry deployments and **node-direct mode** only for local backend debugging.

## First steps every time

1. Identify the current directory type:
   - `pi-foundry` template root: has `src/server.mjs`, `scripts/create-wrapper.mjs`, and this skill.
   - wrapper project: has `agent.yaml`, `azure.yaml`, `src/server.mjs`, usually `agent.config.yaml`.
   - existing Pi agent source: has `.agents/skills/`, `prompts/`, `mcp.config.json`, `demo-workspace/`, but may not have `src/server.mjs`.
2. Inspect status with safe commands:
   - `pwd`
   - `git status --short` when inside a git repo
   - `find . -maxdepth 3 ...` for relevant files if needed
3. Prefer dry-runs before writing:
   - `npm run install:azd-adapter -- ... --dry-run` for the azd-native adapter prototype.
   - `npm run create:wrapper -- ... --dry-run` only for the older wrapper fallback.
   - `npm run import:pi-agent -- ... --dry-run` only when explicitly copying assets into a wrapper.
4. Before deploy, run the available checks for the chosen path:
   - azd-native path: `azd up` is the canonical lifecycle; use the adapter `up` workflow and `azd env`.
   - wrapper path: `npm run validate` and `npm run doctor`.

## Core workflow: existing Pi agent -> azd-native Foundry deployment

Use this as the default UX when the user has a local Pi agent and wants it on Foundry.

### Inputs to collect

Ask only for missing values:

- Existing Pi agent path, default to current directory if it looks like a Pi agent.
- Agent/deployment name, e.g. `media-report-agent`.
- ACR endpoint if known, e.g. `<registry>.azurecr.io`.
- Runtime image if using a private/unpublished pi-foundry runtime image.
- Foundry/model values later, only when configuring deploy:
  - `PI_OPENAI_BASE_URL`
  - `PI_OPENAI_MODEL`
  - `PI_OPENAI_API_KEY`
  - optional artifact storage values.

Never print secrets. Do not write secrets into repo files.

### Recommended azd-native command

From the `pi-foundry` development checkout, install the thin adapter into the existing Pi agent repo with a dry-run first:

```bash
npm run install:azd-adapter -- \
  --target <existing-pi-agent-path> \
  --name <agent-name> \
  --acr <registry>.azurecr.io \
  --runtime-image <registry>.azurecr.io/pi-foundry-runtime:0.1.0 \
  --dry-run
```

After user approval, run without `--dry-run`:

```bash
npm run install:azd-adapter -- \
  --target <existing-pi-agent-path> \
  --name <agent-name> \
  --acr <registry>.azurecr.io \
  --runtime-image <registry>.azurecr.io/pi-foundry-runtime:0.1.0
```

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

It should not modify `.agents/skills/`, prompts, MCP config, or user business code. Existing deployment files are skipped unless `--overwrite` is explicitly supplied.

Then continue from the user's repo:

```bash
cd <existing-pi-agent-path>
azd env new <env-name>
# set PI_* values
node .azd/pi-foundry/doctor.mjs
azd up
```

Note: this prototype requires a published pi-foundry runtime base image, or `--runtime-image <image>` pointing to an internal image. From the pi-foundry repo, build/smoke a runtime image with `npm run runtime:build` and `npm run runtime:smoke` when Docker is available, or use `npm run runtime:acr-build` for ACR remote builds without a local Docker daemon.

## Locate the template root for wrapper fallback

The older `create:wrapper` flow must run from a `pi-foundry` template root. Use it only when the user asks for a separate self-contained wrapper repo or when the azd-native runtime image path is not available.

1. Check likely paths such as `~/repos/pi-foundry`.
2. Confirm the candidate has `scripts/create-wrapper.mjs` and `src/server.mjs`.
3. Run the create command with `cwd` set to that template root.
4. Use the existing agent repo path as `--from`.

If no template checkout exists, tell the user they need to clone or create one before the wrapper can be generated.

### Wrapper fallback command

```bash
npm run create:wrapper -- \
  --name <agent-name> \
  --target <target-wrapper-path> \
  --from <existing-pi-agent-path> \
  --mode official \
  --acr <registry>.azurecr.io \
  --dry-run
```

## Import assets into an existing wrapper

Use when the wrapper already exists and the user wants to bring in skills/prompts/MCP/demo assets.

Preview:

```bash
npm run import:pi-agent -- <existing-pi-agent-path> --dry-run
```

Apply:

```bash
npm run import:pi-agent -- <existing-pi-agent-path>
npm run validate
npm run doctor
```

Explain that the importer copies common Pi-owned assets such as:

```text
.agents/skills/*
mcp.config.json
mcp.json
.mcp.json
prompts/
demo-workspace/
```

Existing destinations are skipped unless `--overwrite` is explicitly supplied.

## Configure Foundry/model environment

Use `azd env` for runtime values. Do not commit secrets.

Typical values:

```bash
azd env set PI_MOCK 0
azd env set REQUEST_TIMEOUT_MS 600000
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

If a known working environment exists and the user asks to reuse it, prefer:

```bash
npm run copy:azd-env -- --from <working-wrapper-or-template-repo> --env <agent-name> --artifact-prefix <agent-name>
```

## Deploy

For the azd-native path, deploy from the existing Pi agent repo:

```bash
azd up
```

This is the canonical UX. It lets azd own packaging/provisioning/deployment for the repo.

For the older wrapper fallback, deploy from the wrapper project:

```bash
npm run deploy:foundry
```

That script runs `doctor`, calls `azd deploy --no-prompt`, grants artifact RBAC when configured, and prints next commands when it can infer the agent/version.

If the user needs manual wrapper control:

```bash
npm run doctor
azd deploy --no-prompt
npm run grant:artifact-rbac -- <agent-name> <storage-account>
```

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

Artifact demo:

```bash
npm run demo:remote:artifact -- <agent-name> <version>
```

Expected behavior:

- response includes markdown artifact links or a structured `artifacts` array
- static website artifact URLs return HTTP 200

Session continuity smoke, when useful:

```bash
BASE_URL=http://127.0.0.1:8080 npm run smoke:session
```

For remote sessions, use repeated `azd ai agent invoke` calls with the same session if the CLI supports it, or use the documented session smoke approach in project docs.

## Local validation modes

Mock wrapper smoke without model credentials:

```bash
PI_MOCK=1 npm start
npm run smoke
```

Real local Pi smoke:

```bash
npm start
npm run smoke
npm run smoke:sse
npm run smoke:session
```

Official runtime local smoke:

```bash
npm run smoke:official
```

## Troubleshooting playbook

Start with:

```bash
npm run validate
npm run doctor
azd ai agent show --output json --no-prompt
azd ai agent monitor <agent-name> --tail 100 --type console
```

Common issues and actions:

### Deployment succeeds but invoke fails

Check:

- `PI_MOCK=0`
- `PI_ARGS` includes `--mode rpc --provider foundry --model <model>`
- `PI_OPENAI_API_KEY` is set in `azd env`, not committed files
- `PI_OPENAI_BASE_URL` is the OpenAI-compatible endpoint, often `https://<account>.cognitiveservices.azure.com/openai/v1`
- Hosted Agent version passed to `azd ai agent invoke` is the current validated version

### Readiness or container startup fails

Check:

- official mode uses `runtime/official-invocations/entrypoint.sh`
- `Dockerfile` matches the selected mode; official wrappers usually copy from `Dockerfile.official`
- public container port convention is `8088`
- `GET /readiness` must return HTTP 200

### Artifacts links missing or 403/404

Check:

- `ARTIFACT_PUBLISH_MODE=static-web`
- `ARTIFACT_STORAGE_ACCOUNT` and `ARTIFACT_STATIC_WEB_ENDPOINT` are set
- agent identities have `Storage Blob Data Contributor`
- run:

```bash
npm run grant:artifact-rbac -- <agent-name> <storage-account>
```

Remember: local `/artifacts/<path>` is not exposed through Foundry front door; remote clickable artifacts are published to Azure Storage Static Website.

### ACR/image pull issues

Check ACR permissions for Foundry identities. Run `npm run doctor` first. If needed, inspect deployment/agent identities using `azd ai agent show --output json --no-prompt` and assign appropriate ACR pull/read roles outside this skill.

### User asks whether to edit runtime files

Default answer: no for the common path. They should customize:

- `.agents/skills/`
- prompts and demo workspace
- MCP config
- `azd env` values
- artifact manifest/behavior

They should usually not edit:

- `src/server.mjs`
- `Dockerfile` / `Dockerfile.official`
- `agent.yaml`
- `agent.manifest.yaml`
- `azure.yaml`

unless they are intentionally changing the runtime/template.

## Documentation to consult when needed

Read these project docs when the user asks for details or when troubleshooting needs more context:

- `README.md` — top-level quickstart and runtime modes
- `docs/byo-pi-agent.md` — template contract and mental model
- `docs/existing-pi-agent-journey.md` — full existing-agent migration journey
- `docs/deploy-existing-pi-agent.md` — short deployment checklist
- `docs/artifacts.md` — artifact publishing details
- `docs/azd-native-ux.md` — azd-native in-repo adapter UX direction
- `docs/runtime-image.md` — runtime base image build/smoke/publish flow
- `DEPLOY.md` — remote Foundry invocation and deployment troubleshooting
- `docs/handoff.md` — current known-good internal deployment state

## Communication style

- Keep the user on one happy path unless they ask for alternatives.
- State assumptions before running mutating commands.
- Ask for missing names/endpoints/paths only when necessary.
- Translate tool output into concrete next actions.
- Treat `doctor` output as the primary source of actionable environment feedback.
