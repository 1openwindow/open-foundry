# pi-foundry handoff

Last updated: 2026-05-30

## Summary

`pi-foundry` is now a runtime plus **skill-managed, azd-compatible in-repo adapter** for deploying existing Pi agents to Foundry.

The user-facing direction is:

```text
existing Pi agent repo -> pi-foundry skill installs adapter -> runtime base image -> azd up -> Foundry Hosted Agent
```

No wrapper repo is required for the default path.

## Current repos

| Repo | Remote | Status |
|---|---|---|
| `~/repos/pi-foundry` | `https://github.com/1openwindow/pi-foundry` | Main runtime/skill/adapter-bundle repo, private, clean/pushed. |
| `~/repos/clean-pi-agent` | local only | Clean user-agent test fixture for skill-managed deployment UX. |

## Known-good deployed agents

### `clean-pi-agent`

```text
Version: 6
Protocol: invocations
Purpose: Validates the current skill-first natural-language UX from the clean `~/repos/clean-pi-agent` repo.
```

Known-good properties:

```text
Direct deploy command: azd up --no-prompt
Remote invoke: output ok, mock false
Artifact publishing: static website URL returned HTTP 200
Persistent root agent.yaml: absent after deployment
Persistent root agent.manifest.yaml: absent after deployment
```

### Historical/internal: `pi-agent`

```text
Version: 1
Protocol: invocations
Purpose: Demonstrates the earlier in-repo adapter validation from the clean `~/repos/clean-pi-agent` repo.
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
Dockerfile.runtime
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

### Internal Node backend

Useful for backend-only debugging; the Foundry-facing entrypoint is the official SDK host.

```bash
cd ~/repos/pi-foundry
PI_MOCK=1 npm run start:backend
npm run smoke
```

Files:

```text
Dockerfile.runtime
src/backend.mjs
src/adapters/pi-rpc.mjs
src/runtime/artifacts.mjs
```

## Main user workflow

From the existing Pi agent repo, install the adapter through the pi-foundry skill. For local development of this repo, the equivalent script entrypoint is:

```bash
cd <path-to-existing-pi-agent>
node ~/repos/pi-foundry/.agents/skills/pi-foundry/scripts/install-adapter.mjs --environment <agent-name>
```

Then from the same repo:

```bash
node ~/repos/pi-foundry/.agents/skills/pi-foundry/scripts/configure-env.mjs \
  --env-name <agent-name> \
  --agent-name <agent-name> \
  --from-env-file <existing-local-azd-env-file>
node .azd/pi-foundry/doctor.mjs
azd up --no-prompt
azd ai agent invoke <agent-name> --protocol invocations --version <version> --new-session --timeout 900 'Say exactly: ok'
```

The legacy wrapper-repo walkthroughs have been removed; the supported path is the skill-managed in-repo adapter.

Demo script:

```text
docs/demo-checklist.md
```

## Current validation status

Last checked:

```text
pi-foundry:      validate 0 failed
clean-pi-agent: natural-language E2E passed, adapter doctor 0 failed
```

Expected non-blocking warnings:

- Docker socket permission may be denied in this agent harness; use ACR remote build for the runtime image when local Docker is unavailable.
- `azd ai agent doctor` may warn that role assignments could not be listed; this is not blocking when artifact RBAC and artifact URL checks succeed.

## Important implementation notes

- The runtime supports both non-streaming JSON and streaming SSE.
- Non-streaming `azd ai agent invoke` through official mode now returns backend JSON, not raw SSE lines.
- Streaming clients still receive `token` and `done` SSE events.
- Artifact publishing uses Azure Storage Static Website and requires `Storage Blob Data Contributor` for agent identities.
- The adapter's postdeploy automation grants artifact RBAC when artifact static-web publishing is enabled.

## Things intentionally not done yet

- `/responses` protocol support is intentionally out of scope for now.
- Generic non-Pi BYO agent adapters are out of scope for this phase.
- Full official Invocations replacement of the Node backend is out of scope; official mode currently proxies to Node.
- Official mode is the supported Foundry-facing path; the Node process is an internal backend.

## Suggested next phase

Only after this handoff is stable:

1. Verify the skill-managed install path end-to-end from a clean agent repo.
2. Continue hardening the official SDK host path and runtime base image.
3. Add contract smoke tests for request shapes: `message`, `input`, `input.message`, `text/plain`, SSE.
4. Harden official runtime error/header propagation and process supervision.
