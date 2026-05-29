# Demo checklist

This checklist demonstrates the end-to-end **skill-managed azd-compatible deployment** story.

Primary story:

```text
clean existing Pi agent repo -> Pi skill installs adapter/configures env/runs azd up -> Foundry Hosted Agent
```

No wrapper repo is required.

## Repos

| Repo | Purpose |
|---|---|
| `~/repos/clean-pi-agent` | Clean user-owned Pi agent used as the test fixture. |
| `~/repos/pi-foundry` | Runtime source, pi-foundry skill, adapter bundle, runtime image build scripts, and docs. |

## Demo 1: show the clean Pi agent repo

```bash
cd ~/repos/clean-pi-agent
find . -path './.git' -prune -o -path './.azure' -prune -o -maxdepth 4 -type f -print | sort
```

Expected highlights before installation:

```text
.agents/skills/hello-foundry/SKILL.md
README.md
demo-workspace/sources/brief.md
prompts/hello-foundry.md
```

Message to tell:

```text
This is a clean user repo. It does not contain pi-foundry runtime source or deployment adapter files until the pi-foundry skill installs the adapter.
```

## Demo 2: use the deployment skill as the UX layer

From the clean user repo, temporarily load the pi-foundry deployment skill:

```bash
cd ~/repos/clean-pi-agent
pi --skill ~/repos/pi-foundry/.agents/skills/pi-foundry
```

Then ask:

```text
帮我把当前 agent 部署到 Foundry
```

Expected behavior:

- skill keeps the user in the current repo
- skill uses `azd` as the deployment engine
- skill does not ask the user to cd into `pi-foundry`
- skill does not create a wrapper repo
- skill explains what files it will modify before mutating

## Demo 3: install the adapter with the skill script

Equivalent local-dev command from the existing Pi agent repo:

```bash
cd ~/repos/clean-pi-agent
node ~/repos/pi-foundry/.agents/skills/pi-foundry/scripts/install-adapter.mjs \
  --environment clean-pi-agent
```

Expected:

- adapter assets are installed in place
- `.dockerignore` receives a pi-foundry managed safety block
- `.azd/pi-foundry/pi-foundry.yaml` is created from repo/user intent
- generated deployment files are materialized
- no agent business-code files are modified

Installed/copied adapter files:

```text
.dockerignore
.azd/pi-foundry/README.md
.azd/pi-foundry/render.mjs
.azd/pi-foundry/doctor.mjs
.azd/pi-foundry/postdeploy.mjs
```

Skill-created config:

```text
.azd/pi-foundry/pi-foundry.yaml
```

Generated files:

```text
azure.yaml
.azd/pi-foundry/Dockerfile
.azd/pi-foundry/pi-foundry.lock.yaml
.azd/pi-foundry/generated/agent.yaml
.azd/pi-foundry/generated/agent.manifest.yaml
```

## Demo 4: configure env and run adapter doctor

```bash
cd ~/repos/clean-pi-agent
azd env set AZURE_CONTAINER_REGISTRY_ENDPOINT '<registry>.azurecr.io'
# set Foundry + PI_* values
node .azd/pi-foundry/doctor.mjs
```

Expected after environment configuration:

```text
pi-foundry adapter doctor: ... 0 failed
```

Current known-good result may include one pre-deploy warning from `azd ai agent doctor` before the first deployment because the remote agent does not exist yet.

## Demo 5: deploy with azd up

```bash
cd ~/repos/clean-pi-agent
azd up --no-prompt
```

Expected:

- custom `up` workflow runs
- render/check runs first
- adapter doctor runs before package/deploy
- package/deploy succeeds
- postdeploy prints the invoke command and grants artifact RBAC when configured
- no wrapper repo is involved

Known-good remote agent from earlier validation:

```text
pi-agent v1
```

## Demo 6: invoke the deployed agent

```bash
cd ~/repos/clean-pi-agent
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
  "mock": false,
  "artifacts": []
}
```

## Demo 7: artifact validation

```bash
cd ~/repos/clean-pi-agent
azd ai agent invoke <agent-name> \
  --protocol invocations \
  --version <version> \
  --new-session \
  --timeout 900 \
  "Create a tiny downloadable static HTML artifact named index.html titled 'Clean Pi Agent on Foundry'. Save it under the artifact directory you were instructed to use. Write artifact-manifest.json listing index.html. Reply concisely with artifact links."
```

Expected:

- response contains structured `artifacts` array
- `index.html` URL returns HTTP 200
- URLs are under `clean-pi-agent/<date>/<request-id>/...`

Verify a returned URL:

```bash
curl --noproxy '*' -I '<index-html-url>'
```

## Demo 8: runtime image remote build

When Docker is unavailable locally, build the runtime image in ACR:

```bash
cd ~/repos/pi-foundry
npm run runtime:acr-build -- \
  --registry crce6hg4ngzj3as.azurecr.io \
  --image pi-foundry-runtime:0.1.0
```

Known-good validation:

```text
Image:  crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0
Run:    chh
Status: Succeeded
Digest: sha256:d2480ca47d4c4e37af69db1f9eca930108fcbabb062a9ade39cc704f6e1e9416
```

## Recommended story to tell

1. Start with the clean local Pi agent (`clean-pi-agent`).
2. Use the pi-foundry skill as the natural-language UX layer.
3. Let the skill install the adapter, create `pi-foundry.yaml`, configure `azd env`, and run `azd up`.
4. Use a versioned pi-foundry runtime base image.
5. Show remote invocation and artifact URLs.
