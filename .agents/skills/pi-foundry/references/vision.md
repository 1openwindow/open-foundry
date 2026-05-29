# pi-foundry BYO vision

pi-foundry is a skill-managed Foundry deployment adapter for existing Pi agents.

Users are not primarily installing a template. They are asking a Pi skill to add Foundry deployment capability to an agent repo they already own.

Canonical product sentence:

> Template installs the adapter, skill personalizes it, render materializes it, azd deploys it.

## User promise

- Stay in the existing Pi agent repo.
- No wrapper repo.
- No runtime source vendoring.
- No modification to user skills, prompts, MCP config, or business code unless explicitly requested.
- Secrets stay in `azd env`, never in repo files.

## Layering

```text
User intent
  -> pi-foundry skill
  -> skill-installed adapter bundle
  -> skill-created .azd/pi-foundry/pi-foundry.yaml
  -> adapter render.mjs
  -> generated azure/Dockerfile/agent specs
  -> azd up
  -> Foundry Hosted Agent
```

## Responsibilities

- Skill: UX, repo inspection, configuration, env management, troubleshooting, migration.
- Template: minimal azd/bootstrap skeleton and deploy-time adapter scripts.
- `pi-foundry.yaml`: high-level source of truth for one user's deployment.
- `render.mjs`: deterministic materialization.
- `azd`: package/deploy lifecycle.
- Runtime image: Foundry Invocations bridge, Pi RPC, sessions, streaming, artifacts.
