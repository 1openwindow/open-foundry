# Demo checklist

This checklist demonstrates the end-to-end **Deploy your existing Pi agent to Foundry with azd** story.

Primary story:

```text
existing Pi agent repo -> thin azd adapter -> runtime base image -> azd up -> Foundry Hosted Agent
```

No wrapper repo is required for the default path.

## Repos

| Repo | Purpose |
|---|---|
| `~/repos/media-report-agent` | Example existing user-owned Pi agent; now also demonstrates the azd-native in-repo adapter path. |
| `~/repos/pi-foundry` | Runtime source, adapter template, runtime image build scripts, and docs. |

## Demo 1: show the existing Pi agent repo

```bash
cd ~/repos/media-report-agent
find . -path './.git' -prune -o -path './.azure' -prune -o -maxdepth 4 -type f -print | sort
```

Expected highlights:

```text
.agents/skills/edge-tts/SKILL.md
.agents/skills/hyperframes/SKILL.md
mcp.config.json
prompts/narrated-product-update.zh.md
.azd/pi-foundry/Dockerfile
.azd/pi-foundry/doctor.mjs
.azd/pi-foundry/postdeploy.mjs
azure.yaml
agent.yaml
agent.manifest.yaml
```

Message to tell:

```text
The original Pi agent repo is still the source of truth. We added deployment configuration, not a wrapper repo and not runtime source.
```

## Demo 2: show azd-native adapter installation dry-run

From the runtime/template repo:

```bash
cd ~/repos/pi-foundry
npm run install:azd-adapter -- \
  --target ~/repos/media-report-agent \
  --name media-report-agent \
  --acr crce6hg4ngzj3as.azurecr.io \
  --runtime-image crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0 \
  --dry-run
```

Expected:

- shows only deployment files to create/overwrite
- explicitly says no agent business-code files will be modified

## Demo 3: runtime image remote build

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

## Demo 4: adapter doctor inside the existing repo

```bash
cd ~/repos/media-report-agent
node .azd/pi-foundry/doctor.mjs
```

Expected:

```text
pi-foundry adapter doctor: ... 0 failed
```

Known-good result after validation:

```text
32 passed, 0 warned, 0 failed
```

## Demo 5: deploy with azd up from the existing repo

```bash
cd ~/repos/media-report-agent
azd up --no-prompt
```

Expected:

- custom `up` workflow runs
- package/deploy succeeds
- postdeploy prints the invoke command
- no wrapper repo is involved

Known-good remote agent:

```text
media-report-agent v3
```

## Demo 6: invoke the azd-native deployed agent

```bash
cd ~/repos/media-report-agent
azd ai agent invoke media-report-agent \
  --protocol invocations \
  --version 3 \
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

## Demo 7: artifact demo from azd-native deployed agent

```bash
cd ~/repos/media-report-agent
~/repos/pi-foundry/scripts/demo-remote-artifact.sh media-report-agent 3
```

Expected:

- response contains `Artifacts:` markdown links
- response contains structured `artifacts` array
- `index.html` and `script.md` URLs return HTTP 200
- URLs are under `media-report-agent/<date>/<request-id>/...`

Verify a returned URL:

```bash
curl --noproxy '*' -I '<index-html-url>'
```

## Recommended story to tell

1. Start with the existing local Pi agent (`media-report-agent`).
2. Add a thin azd adapter in place; do not create a wrapper repo.
3. Use a versioned pi-foundry runtime base image.
4. Run `node .azd/pi-foundry/doctor.mjs`.
5. Deploy with `azd up` from the existing repo.
6. Show remote invocation and artifact URLs.
