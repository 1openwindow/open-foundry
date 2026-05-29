# pi-foundry environment variables

Use `azd env` for deployment environment values. Do not commit secrets.

## Required/common

- `AZURE_CONTAINER_REGISTRY_ENDPOINT` — ACR endpoint used for remote Docker builds.
- `PI_ARGS` — Pi command args. Should include `--mode rpc` and usually `--no-session`.
- `REQUEST_TIMEOUT_MS` — long-running invocation timeout, e.g. `600000`.
- `ENABLE_DIAGNOSTICS` — use `0` by default.
- `PI_MOCK` — `1` for mock wrapper tests; `0` for real model mode.

## Real model mode

- `PI_OPENAI_API_KEY` — secret. Set with `azd env set`; never write to YAML.
- `PI_OPENAI_BASE_URL` — OpenAI-compatible Foundry/account endpoint, usually `https://<account>.cognitiveservices.azure.com/openai/v1`.
- `PI_OPENAI_MODEL` — Foundry model/deployment name.

## Artifact publishing

- `ARTIFACT_PUBLISH_MODE` — `disabled` or `static-web`.
- `ARTIFACT_STORAGE_ACCOUNT`
- `ARTIFACT_STATIC_WEB_ENDPOINT`
- `ARTIFACT_STATIC_WEB_CONTAINER` — usually `$web`.
- `ARTIFACT_BLOB_PREFIX`

## Reserved prefixes

Avoid custom env vars starting with:

- `AGENT_`
- `FOUNDRY_`

Foundry/azd may reserve or emit those names.
