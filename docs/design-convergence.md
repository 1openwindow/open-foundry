# pi-foundry design convergence

Last updated: 2026-05-30

This document captures the current product/design decisions after the skill-first UX and E2E validation work.

## Product stance

`pi-foundry` is a **skill-first, azd-compatible in-repo adapter** for deploying an existing Pi agent to Microsoft Foundry Hosted Agents.

The user should stay in their own repo and ask for the outcome:

```text
帮我把当前 agent 部署到 Foundry，并验证一下。
```

The skill is the UX/control layer. `azd` remains the deployment engine. There is no wrapper repo and no product-specific CLI for the user to learn.

## User experience contract

The skill should:

1. Inspect the current repo before mutating it.
2. Explain the planned file changes in human language.
3. Add only deployment configuration and adapter assets.
4. Avoid changing user-owned agent assets.
5. Configure env values through `azd env`, never through committed YAML or code.
6. Run preflight checks before deployment.
7. Deploy with direct `azd up --no-prompt` from the user repo.
8. Verify the remote agent with a real invocation.
9. Verify artifact delivery when static-web publishing is configured.
10. Summarize the result, artifact links, and any non-blocking warnings.

## File ownership

User-owned files must not be modified unless the user explicitly asks:

```text
.agents/skills/
prompts/
mcp.config.json
src/
package.json
README.md
workspace/demo content
```

Persistent root footprint should stay small:

```text
azure.yaml
.dockerignore
```

pi-foundry-owned files live under:

```text
.azd/pi-foundry/
```

The human-facing source of truth is:

```text
.azd/pi-foundry/pi-foundry.yaml
```

Generated low-level platform files live under:

```text
.azd/pi-foundry/Dockerfile
.azd/pi-foundry/pi-foundry.lock.yaml
.azd/pi-foundry/generated/agent.yaml
.azd/pi-foundry/generated/agent.manifest.yaml
```

## Agent YAML placement

Root `agent.yaml` and `agent.manifest.yaml` should **not** be persisted in the user's repo.

Current azd behavior is nuanced:

- `azd package` honors `AGENT_DEFINITION_PATH=.azd/pi-foundry/generated/agent.yaml`.
- `azd deploy` in the current `azure.ai.agents` extension still reads root `agent.yaml` during its predeploy hook.

The adapter handles this inside:

```text
.azd/pi-foundry/azd-agent.mjs
```

The generated `azure.yaml` workflow calls:

```text
node .azd/pi-foundry/azd-agent.mjs package --all
node .azd/pi-foundry/azd-agent.mjs deploy --all
```

`azd-agent.mjs` passes `AGENT_DEFINITION_PATH` and, only for deploy, temporarily materializes root `agent.yaml`/`agent.manifest.yaml`, then restores or deletes them. After deployment, the user repo should not have persistent root agent YAML.

## Env configuration

Secrets and environment-specific values live in `azd env`.

When reusing values from another local azd `.env`, use the deterministic helper instead of blindly copying all keys:

```bash
node <skill>/scripts/configure-env.mjs \
  --env-name <agent-name> \
  --agent-name <agent-name> \
  --from-env-file <path-to-existing-azd-env-file>
```

Important rules:

- Do not print secrets.
- Do not copy `AGENT_*` deployment outputs from another environment.
- Do not copy another agent's `ARTIFACT_BLOB_PREFIX`.
- In the skill-managed flow, `ARTIFACT_BLOB_PREFIX` should normally equal the current agent name.
- Set the static website container as literal `$web`.

## Artifact delivery

For static-web artifact publishing, the runtime uploads to:

```text
<ARTIFACT_STATIC_WEB_ENDPOINT>/<ARTIFACT_BLOB_PREFIX>/<yyyy-mm-dd>/<request-id>/<file>
```

The skill-managed default is:

```text
ARTIFACT_BLOB_PREFIX=<agent-name>
```

This keeps artifact URLs aligned with the current deployed agent and avoids leaking prefixes from reused environments.

## Validation status

Validated through a real natural-language Pi skill flow from `~/repos/clean-pi-agent`:

```text
clean existing Pi agent repo
  -> pi-foundry skill installs adapter
  -> configure azd env without printing secrets
  -> render --check
  -> doctor
  -> azd up --no-prompt
  -> invoke Say exactly: ok
  -> artifact invoke + curl HTTP 200
```

Known-good validation:

```text
Agent: clean-pi-agent
Version: 6
Invoke: output ok, mock false
Artifact: HTTP 200
Persistent root agent.yaml: absent
Persistent root agent.manifest.yaml: absent
```

## Remaining UX work

The core path works. The main remaining work is UX polish rather than architecture:

- Reduce noisy azd update messages where possible.
- Make `azd ai agent doctor` warnings more actionable in the skill summary.
- Continue improving guided resource/env discovery for first-time users.
- Keep `azd-agent.mjs` as an implementation detail; users should only need to know `azd up`.
