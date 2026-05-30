# Skill-managed azd-compatible UX direction

The user-facing direction for `pi-foundry` is a **skill-managed, azd-compatible in-repo adapter**:

```text
Deploy your existing Pi agent to Foundry through the pi-foundry skill.
No wrapper repo. No runtime vendoring. No changes to agent business code.
```

## Why

Developers working in vibe-coding flows expect to stay inside their own repo and ask for the outcome:

```text
"Deploy this Pi agent to Foundry."
```

They should not need to reason about installation mechanics, generated Dockerfiles, or Foundry agent YAML.

## UX vision

`pi-foundry` should be a skill-managed Foundry deployment adapter for an existing Pi agent repo:

- the developer stays in their repo
- the pi-foundry skill owns install/configure/migrate UX
- `azd` owns environment/package/deploy lifecycle
- `azd up` remains the canonical deploy command after installation
- pi-foundry runtime comes from a versioned base image
- the user's repo only gains deployment configuration
- user skills/prompts/MCP remain the source of truth in the same repo

## File model

The skill installs deploy-time adapter assets:

```text
.dockerignore                         # pi-foundry managed block merged with existing rules
.azd/pi-foundry/README.md
.azd/pi-foundry/render.mjs
.azd/pi-foundry/doctor.mjs
.azd/pi-foundry/postdeploy.mjs
```

The skill creates the high-level deployment config from user/repo intent:

```text
.azd/pi-foundry/pi-foundry.yaml
```

`render.mjs` materializes generated deployment files:

```text
azure.yaml
.azd/pi-foundry/Dockerfile
.azd/pi-foundry/azd-agent.mjs
.azd/pi-foundry/pi-foundry.lock.yaml
.azd/pi-foundry/generated/agent.yaml
.azd/pi-foundry/generated/agent.manifest.yaml
```

Generated agent YAML stays under `.azd/pi-foundry/generated/`. The adapter workflow uses `.azd/pi-foundry/azd-agent.mjs` to pass `AGENT_DEFINITION_PATH` to azd package/deploy, so root `agent.yaml` is not persistently required.

It does **not** modify user-owned agent assets:

```text
.agents/skills/
prompts/
mcp.config.json
src/
package.json
README.md
```

## Current validation status

Validated on 2026-05-30 with the skill-owned natural-language flow:

- Runtime image: `crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0`
- Existing clean Pi agent repo adapted in place: `~/repos/clean-pi-agent`
- Hosted Agent deployed with direct `azd up --no-prompt`: `clean-pi-agent` version `6`
- Remote invoke succeeded with real model: output `ok`, `mock: false`
- Artifact demo succeeded and returned HTTP 200 static website URLs under the current agent prefix
- Persistent root `agent.yaml` and `agent.manifest.yaml`: absent after deployment

Equivalent script-level flow:

```bash
cd ~/repos/clean-pi-agent
node ~/repos/pi-foundry/.agents/skills/pi-foundry/scripts/install-adapter.mjs --environment clean-pi-agent --agent-name clean-pi-agent
node ~/repos/pi-foundry/.agents/skills/pi-foundry/scripts/configure-env.mjs \
  --env-name clean-pi-agent \
  --agent-name clean-pi-agent \
  --from-env-file <existing-local-azd-env-file>
node .azd/pi-foundry/doctor.mjs
azd up --no-prompt
```

## Runtime image requirement

The generated adapter Dockerfile uses a runtime base image:

```dockerfile
ARG PI_FOUNDRY_RUNTIME_IMAGE=crce6hg4ngzj3as.azurecr.io/pi-foundry-runtime:0.1.0
FROM ${PI_FOUNDRY_RUNTIME_IMAGE}

WORKDIR /app
COPY . /workspace
```

Before this flow can be production-ready, publish and version the runtime image. See [runtime-image.md](./runtime-image.md) for build, smoke, and publish commands.

## Future product shape

Recommended artifacts:

1. `pi-foundry-runtime` image
   - official Invocations host
   - Node Pi backend
   - session mapping
   - artifact publishing
   - health/readiness

2. `pi-foundry` skill
   - adapter installer
   - config updater
   - env helper
   - smoke invoke helper
   - migration helper
   - troubleshooting references

3. `adapter bundle` inside the skill
   - render
   - doctor
   - postdeploy
   - dockerignore managed block

The skill should guide users through the skill-managed path only.
