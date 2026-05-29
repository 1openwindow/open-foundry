# pi-foundry troubleshooting quick reference

Run from the user's existing Pi agent repo unless noted otherwise.

## Preflight

```bash
node .azd/pi-foundry/render.mjs --check
node .azd/pi-foundry/doctor.mjs
azd ai agent doctor --no-prompt
```

## Deployment succeeds but invoke fails

Check:

- `PI_MOCK=0` for real model mode.
- `PI_ARGS` includes `--mode rpc --provider foundry --model <model>`.
- `PI_OPENAI_API_KEY` is set in `azd env`.
- `PI_OPENAI_BASE_URL` ends in `/openai/v1` for OpenAI-compatible Foundry/account endpoints.
- The invoked Hosted Agent version is the current deployed version.

## Container startup/readiness fails

Check:

- `.azd/pi-foundry/Dockerfile` uses the intended runtime image.
- `azure.yaml` startup command is `/app/runtime/official-invocations/entrypoint.sh`.
- Internal public port convention is `8088`.
- `GET /readiness` returns 200.

## Artifact URLs missing or 403/404

Check:

- `ARTIFACT_PUBLISH_MODE=static-web`.
- `ARTIFACT_STORAGE_ACCOUNT` and `ARTIFACT_STATIC_WEB_ENDPOINT` are configured.
- `postdeploy.mjs` ran successfully.
- Agent identities have Storage Blob Data Contributor on the target storage account.

## ACR/image pull issues

Run:

```bash
azd ai agent show <agent-name> --output json --no-prompt
azd ai agent monitor <agent-name> --tail 100 --type console
```

Then inspect identities and ACR permissions.
