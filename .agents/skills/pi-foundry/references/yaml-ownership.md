# pi-foundry YAML ownership

The BYO Pi agent product is skill-first. Users should not have to maintain low-level Azure/Foundry YAML by hand.

## User-owned files

Do not modify these unless the user explicitly asks:

- `.agents/skills/`
- `prompts/`
- `mcp.config.json`
- `src/`
- `package.json`
- `README.md`
- agent business code or workspace content

## pi-foundry-managed files

Default root footprint:

- `azure.yaml` — generated azd entrypoint when absent or already pi-foundry-managed; existing non-pi-foundry files require explicit user confirmation before replacement
- `.dockerignore` — safe Docker build exclusions; preserve user rules when merging

Adapter directory:

- `.azd/pi-foundry/pi-foundry.yaml` — high-level deployment source of truth
- `.azd/pi-foundry/pi-foundry.lock.yaml` — generated lock/checksums
- `.azd/pi-foundry/Dockerfile` — generated thin runtime adapter
- `.azd/pi-foundry/render.mjs` — deterministic renderer
- `.azd/pi-foundry/doctor.mjs` — deterministic checker
- `.azd/pi-foundry/postdeploy.mjs` — deployment follow-up automation
- `.azd/pi-foundry/azd-agent.mjs` — azd wrapper that supplies `AGENT_DEFINITION_PATH` for package/deploy
- `.azd/pi-foundry/generated/*` — generated low-level platform YAML

## Rules

1. Prefer skill scripts over ad-hoc YAML edits.
2. If changing deployment shape, update `.azd/pi-foundry/pi-foundry.yaml` and run `node .azd/pi-foundry/render.mjs`.
3. Do not edit generated files directly.
4. Never write secrets to repo files. Use `azd env`.
5. Explain mutations before making them and show concise status afterward.
6. If an existing `azure.yaml` is not pi-foundry-managed, do not replace it unless the user confirms; back it up first.
