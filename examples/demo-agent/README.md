# Demo agent

This directory contains the bundled demo/test Pi agent assets used by local demos and smoke tests.

It is intentionally separate from the pi-foundry product runtime and azd-native BYO adapter.

Contents:

- `.agents/skills/` - demo skills used by media/artifact demos
- `demo-workspace/` - demo prompts and source files
- `Dockerfile` - self-contained demo image that combines pi-foundry runtime code with these demo assets

For the product runtime base image, use the root `Dockerfile.runtime` instead.
