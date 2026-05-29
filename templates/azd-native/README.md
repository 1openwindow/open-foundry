# pi-foundry azd-native adapter template

This is the thin, in-repo adapter for deploying an existing Pi agent to Microsoft Foundry Hosted Agents with `azd`.

UX goal:

```text
cd my-pi-agent
azd init --template <pi-foundry-azd-template> .
azd up
```

The adapter is intentionally small:

- no wrapper repo
- no copied runtime source
- no changes to Pi agent business code
- deployment is driven by `azure.yaml` and `azd`
- runtime comes from a versioned pi-foundry base image

## Files added to a user repo

```text
azure.yaml
agent.yaml
agent.manifest.yaml
.dockerignore
.azd/pi-foundry/Dockerfile
.azd/pi-foundry/README.md
.azd/pi-foundry/doctor.mjs
.azd/pi-foundry/postdeploy.mjs
```

## Runtime image

The Dockerfile uses a runtime base image:

```dockerfile
ARG PI_FOUNDRY_RUNTIME_IMAGE=ghcr.io/1openwindow/pi-foundry-runtime:0.1.0
FROM ${PI_FOUNDRY_RUNTIME_IMAGE}
```

Publish the runtime image before using this adapter for real deployments, or override the build arg to point to an internal image.

The `azd up` workflow runs:

```text
node .azd/pi-foundry/doctor.mjs
azd package --all
azd deploy --all
node .azd/pi-foundry/postdeploy.mjs
```

The postdeploy script prints the invoke command and attempts artifact RBAC automation when `ARTIFACT_PUBLISH_MODE=static-web`.
