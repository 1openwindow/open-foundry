# pi-foundry adapter

This directory contains the thin Docker adapter used by `azd`.

It intentionally does not contain pi-foundry runtime source code. The runtime comes from the `PI_FOUNDRY_RUNTIME_IMAGE` Docker build argument, defaulting to a versioned pi-foundry runtime image.

The Docker build context is the existing Pi agent repo root, so `.agents/skills/`, prompts, MCP config, and demo workspace files are packaged without creating a wrapper repo.

The template also includes `agent.config.example.yaml` at the repo root. It is optional and is not read by the runtime directly. Copy it to `agent.config.yaml` when you want the adapter doctor to validate high-level BYO agent settings such as runtime args, skills path, MCP config, model alignment, and artifact mode.
