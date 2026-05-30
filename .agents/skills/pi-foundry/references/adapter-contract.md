# pi-foundry adapter bundle contract

The skill owns the canonical adapter bundle. The user repo receives a materialized deploy-time copy.

## Canonical skill assets

```text
.agents/skills/pi-foundry/assets/adapter/README.md
.agents/skills/pi-foundry/assets/adapter/render.mjs
.agents/skills/pi-foundry/assets/adapter/doctor.mjs
.agents/skills/pi-foundry/assets/adapter/postdeploy.mjs
.agents/skills/pi-foundry/assets/adapter/azd-agent.mjs
.agents/skills/pi-foundry/assets/adapter/dockerignore.block
.agents/skills/pi-foundry/assets/adapter/adapter-manifest.json
```

## Installed user repo files

The skill installs/copies:

```text
.dockerignore                         # merged managed block
.azd/pi-foundry/README.md
.azd/pi-foundry/render.mjs
.azd/pi-foundry/doctor.mjs
.azd/pi-foundry/postdeploy.mjs
.azd/pi-foundry/azd-agent.mjs
```

The skill creates from user/repo intent:

```text
.azd/pi-foundry/pi-foundry.yaml
```

`render.mjs` materializes:

```text
azure.yaml                              # only when absent or already pi-foundry-managed, unless overwrite is explicitly allowed
.azd/pi-foundry/Dockerfile
.azd/pi-foundry/pi-foundry.lock.yaml
.azd/pi-foundry/generated/agent.yaml
.azd/pi-foundry/generated/agent.manifest.yaml
```

`.azd/pi-foundry/pi-foundry.yaml` remains the human-facing source of truth. Generated agent YAML stays under `.azd/pi-foundry/generated/`. The generated `azure.yaml` workflow uses `.azd/pi-foundry/azd-agent.mjs` to pass `AGENT_DEFINITION_PATH` to azd package/deploy, avoiding persistent root `agent.yaml` mirrors.

## Adapter bundle must not include user-specific files

The canonical adapter bundle must not contain:

```text
pi-foundry.yaml
Dockerfile
pi-foundry.lock.yaml
generated/
agent.yaml
agent.manifest.yaml
```

## Why

- `pi-foundry.yaml` is specific to one user's agent and must be created by the skill.
- `Dockerfile`, lock, and generated agent specs are render outputs.
- Root `agent.yaml` and `agent.manifest.yaml` make the repo feel invaded and create source-of-truth confusion; keep generated agent specs under `.azd/pi-foundry/generated/` and pass `AGENT_DEFINITION_PATH` during azd package/deploy.

## Direct azd behavior

After skill installation and configuration, `azd up` is self-contained from the user repo:

```text
render.mjs
render.mjs --check
doctor.mjs
azd-agent.mjs package --all
azd-agent.mjs deploy --all
postdeploy.mjs
```
