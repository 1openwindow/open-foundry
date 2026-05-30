# pi-foundry adapter

> Managed by the pi-foundry skill. This directory contains deploy-time adapter files copied from the skill adapter bundle.

This directory contains the isolated pi-foundry BYO adapter used by `azd`.

It intentionally does not contain pi-foundry runtime source code. The runtime comes from the `PI_FOUNDRY_RUNTIME_IMAGE` Docker build argument in the generated `Dockerfile`, defaulting to a versioned pi-foundry runtime image.

The Docker build context is the existing Pi agent repo root, so `.agents/skills/`, prompts, MCP config, and workspace files are packaged without creating a wrapper repo.

## Configuration ownership

Human-facing deployment configuration is created by the pi-foundry skill and lives in:

```text
.azd/pi-foundry/pi-foundry.yaml
```

If this file is missing, run the pi-foundry skill initialization/configuration flow before deployment.

Generated adapter/platform files are materialized by `render.mjs` and include:

```text
azure.yaml
.azd/pi-foundry/Dockerfile
.azd/pi-foundry/azd-agent.mjs
.azd/pi-foundry/pi-foundry.lock.yaml
.azd/pi-foundry/generated/agent.yaml
.azd/pi-foundry/generated/agent.manifest.yaml
```

Do not edit generated files directly. Change `pi-foundry.yaml` through the pi-foundry deployment skill when possible, or edit it manually and then run:

```bash
node .azd/pi-foundry/render.mjs
```

Before deployment, `azd up` runs `render.mjs`, `render.mjs --check`, and the adapter doctor to materialize generated files, catch drift, and validate environment values. The workflow calls `.azd/pi-foundry/azd-agent.mjs` so azd receives `AGENT_DEFINITION_PATH=.azd/pi-foundry/generated/agent.yaml`; root `agent.yaml` is not persistently required.

Secrets and environment-specific values should stay in `azd env`, not YAML.
