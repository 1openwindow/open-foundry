# pi-foundry handoff

Last updated: 2026-05-29

## Summary

`pi-foundry` is now a runtime plus **azd-native in-repo adapter** for deploying existing Pi agents to Foundry.

The user-facing direction is:

```text
existing Pi agent repo -> thin azd adapter -> runtime base image -> azd up -> Foundry Hosted Agent
```

No wrapper repo is required for the default path.

## Current repos

| Repo | Remote | Status |
|---|---|---|
| `~/repos/pi-foundry` | `https://github.com/1openwindow/pi-foundry` | Main template/runtime, private, clean/pushed. |
| `~/repos/media-report-agent` | `https://github.com/1openwindow/media-report-agent` | Example existing Pi agent with azd-native adapter, private, clean/pushed. |
| `~/repos/media-report-foundry` | `https://github.com/1openwindow/media-report-foundry` | Legacy/internal wrapper validation, private. Not user-facing. |
| `~/repos/pi-foundry-official-invocations` | `https://github.com/1openwindow/pi-foundry-official-invocations` | Historical official Invocations deployment reference, private. |

## Known-good deployed agents

### `media-report-agent`

```text
Version: 3
Protocol: invocations
Purpose: Demonstrates the azd-native in-repo adapter path from the original Pi agent repo.
```

Known-good commands:

```bash
cd ~/repos/media-report-agent
node .azd/pi-foundry/doctor.mjs
azd ai agent invoke media-report-agent \
  --protocol invocations \
  --version 3 \
  --new-session \
  --timeout 900 \
  'Say exactly: ok'

~/repos/pi-foundry/scripts/demo-remote-artifact.sh media-report-agent 3
```

### Historical/internal: `pi-foundry-official-invocations`

```text
Version: 3
Protocol: invocations
Purpose: Demonstrates official azure-ai-agentserver-invocations host as the public protocol layer.
```

Known-good commands:

```bash
cd ~/repos/pi-foundry-official-invocations
azd ai agent invoke pi-foundry-official-invocations \
  --protocol invocations \
  --version 3 \
  --new-session \
  --timeout 900 \
  'Say exactly: ok'

npm run demo:remote:artifact -- pi-foundry-official-invocations 3
```

## Runtime modes

### Official Invocations mode

Recommended for Foundry-facing deployments.

```text
Foundry /invocations
  -> official azure-ai-agentserver-invocations Python host
  -> Node backend on 127.0.0.1:18080
  -> pi --mode rpc
```

Files:

```text
Dockerfile.official
runtime/official-invocations/main.py
runtime/official-invocations/entrypoint.sh
runtime/official-invocations/requirements.txt
runtime/official-invocations/smoke-local.sh
```

Local smoke:

```bash
cd ~/repos/pi-foundry
npm run smoke:official
```

### Node direct mode

Recommended for local development, fast debugging, backend validation, and fallback deployments.

```bash
cd ~/repos/pi-foundry
PI_MOCK=1 npm start
npm run smoke
npm run smoke:sse
```

Files:

```text
Dockerfile
src/server.mjs
src/adapters/pi-rpc.mjs
src/runtime/artifacts.mjs
```

## Main user workflow

From the `pi-foundry` development checkout, install the adapter into an existing Pi agent repo:

```bash
npm run install:azd-adapter -- \
  --target <path-to-existing-pi-agent> \
  --name <agent-name> \
  --acr <registry>.azurecr.io \
  --runtime-image <registry>.azurecr.io/pi-foundry-runtime:0.1.0 \
  --dry-run

npm run install:azd-adapter -- \
  --target <path-to-existing-pi-agent> \
  --name <agent-name> \
  --acr <registry>.azurecr.io \
  --runtime-image <registry>.azurecr.io/pi-foundry-runtime:0.1.0
```

Then from the existing Pi agent repo:

```bash
azd env new <agent-name>
azd env set ...
node .azd/pi-foundry/doctor.mjs
azd up
azd ai agent invoke <agent-name> --protocol invocations --version <version> --new-session --timeout 900 'Say exactly: ok'
```

Legacy wrapper checklist and walkthrough (internal/historical only):

```text
docs/legacy/deploy-existing-pi-agent.md
docs/legacy/existing-pi-agent-journey.md
```

Demo script:

```text
docs/demo-checklist.md
```

## Current validation status

Last checked:

```text
pi-foundry:                         validate 0 failed
media-report-agent:                 adapter doctor 0 failed, git clean
```

Expected non-blocking warnings:

- Docker socket permission may be denied in this agent harness; use ACR remote build for the runtime image when local Docker is unavailable.
- `azd ai agent doctor` may warn that role assignments could not be listed; this is not blocking when artifact RBAC and artifact URL checks succeed.

## Important implementation notes

- The runtime supports both non-streaming JSON and streaming SSE.
- Non-streaming `azd ai agent invoke` through official mode now returns backend JSON, not raw SSE lines.
- Streaming clients still receive `token` and `done` SSE events.
- Artifact publishing uses Azure Storage Static Website and requires `Storage Blob Data Contributor` for agent identities.
- The azd-native adapter's postdeploy automation grants artifact RBAC when artifact static-web publishing is enabled.

## Things intentionally not done yet

- `/responses` protocol support is intentionally out of scope for now.
- Generic non-Pi BYO agent adapters are out of scope for this phase.
- Full official Invocations replacement of the Node backend is out of scope; official mode currently proxies to Node.
- Official mode is recommended, but Node direct mode remains supported.

## Suggested next phase

Only after this handoff is stable:

1. Verify `azd ai agent init -m <agent.manifest.yaml>` template experience.
2. Decide whether to make `Dockerfile.official` the default `Dockerfile` in a future breaking change.
3. Add contract smoke tests for request shapes: `message`, `input`, `input.message`, `text/plain`, SSE.
4. Harden official runtime error/header propagation and process supervision.
