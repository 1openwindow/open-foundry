# pi-foundry adapter

This directory contains the thin Docker adapter used by `azd`.

It intentionally does not contain pi-foundry runtime source code. The runtime comes from the `PI_FOUNDRY_RUNTIME_IMAGE` Docker build argument, defaulting to a versioned pi-foundry runtime image.

The Docker build context is the existing Pi agent repo root, so `.agents/skills/`, prompts, MCP config, and demo workspace files are packaged without creating a wrapper repo.
