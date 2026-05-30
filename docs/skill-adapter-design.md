# Skill/adapter design

pi-foundry's BYO path is skill-first:

```text
skill installs the adapter
skill personalizes it
render materializes it
azd deploys it
```

There is no separate canonical install template in the primary product path. The skill owns the canonical adapter bundle and installs an azd-compatible deployment adapter into the user's existing Pi agent repo.

## Product roles

### pi-foundry skill

The skill is the product UX and control plane. It:

- inspects the user's existing Pi agent repo
- explains file ownership before mutations
- installs adapter assets from `.agents/skills/pi-foundry/assets/adapter/`
- infers or asks for the Foundry agent name
- creates `.azd/pi-foundry/pi-foundry.yaml`
- configures `azd env` without writing secrets to repo files
- runs render/doctor/deploy/verify commands
- migrates adapter scripts on later upgrades

### Adapter bundle

The canonical adapter bundle lives in the skill:

```text
.agents/skills/pi-foundry/assets/adapter/README.md
.agents/skills/pi-foundry/assets/adapter/render.mjs
.agents/skills/pi-foundry/assets/adapter/doctor.mjs
.agents/skills/pi-foundry/assets/adapter/postdeploy.mjs
.agents/skills/pi-foundry/assets/adapter/dockerignore.block
.agents/skills/pi-foundry/assets/adapter/adapter-manifest.json
```

The skill installs deploy-time files into the user repo:

```text
.dockerignore                         # merged pi-foundry managed block
.azd/pi-foundry/README.md
.azd/pi-foundry/render.mjs
.azd/pi-foundry/doctor.mjs
.azd/pi-foundry/postdeploy.mjs
```

### `.azd/pi-foundry/pi-foundry.yaml`

This file is created by the skill from user/repo intent. It is the high-level deployment source of truth for one user's agent.

### Generated files

`render.mjs` materializes:

```text
azure.yaml
.azd/pi-foundry/Dockerfile
.azd/pi-foundry/azd-agent.mjs
.azd/pi-foundry/pi-foundry.lock.yaml
.azd/pi-foundry/generated/agent.yaml
.azd/pi-foundry/generated/agent.manifest.yaml
```

Generated files are not the user editing surface.

## Why no separate install template?

The user experience is vibe-coding and skill-driven. Users should not think in terms of installing and editing deployment scaffolding. They should ask the pi-foundry skill to add Foundry deployment to their current repo.

The skill still follows azd conventions:

- it creates `azure.yaml` when absent
- it refuses to overwrite an existing non-pi-foundry `azure.yaml` unless the user explicitly confirms replacement; confirmed replacement is backed up first
- it uses `azd env`
- it relies on `azd package`, `azd deploy`, and the `azure.ai.agents` extension

But the install mechanism is skill-owned, not scaffold-owned.

## Lifecycle

```text
inspect -> plan -> install adapter -> create config -> render -> configure env -> doctor -> azd up -> smoke invoke -> migrate as needed
```
