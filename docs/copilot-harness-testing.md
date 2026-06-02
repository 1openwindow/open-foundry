# Copilot harness — testing TODO

Branch: `feat/copilot-sdk-adapter` · feature commit: `faf0a5c`

Goal: validate the new `HARNESS=copilot` path (GitHub Copilot via
`@github/copilot-sdk`, BYOK to Azure) with a real model, then deploy a real
Foundry Hosted Agent.

## Done

- Copilot SDK adapter + harness selector landed; `npm test` green (41 tests).
- Runtime image builds from this branch and is **self-contained** for Copilot
  (`npm ci` pulls `@github/copilot-sdk` + transitive `@github/copilot` CLI +
  `copilot-linux-x64`; SDK resolves `@github/copilot/index.js` from
  `node_modules`).
- Local container smoke in **mock** mode passed: `harness:"copilot"` logged,
  JSON + SSE invocations both work.

Image already built locally as `pi-foundry-runtime:copilot-test`.
Rebuild if `src/` changes:

```bash
docker build -f Dockerfile.runtime -t pi-foundry-runtime:copilot-test .
```

## Next — Stage A: local real BYOK smoke (do first)

Needs real model creds. Put them in a local (gitignored) file:

```bash
cat > /tmp/copilot-byok.env <<'EOF'
PI_OPENAI_BASE_URL=https://<account>.cognitiveservices.azure.com/openai/v1
PI_OPENAI_MODEL=<deployment-or-model, e.g. gpt-4.1-mini>
PI_OPENAI_API_KEY=<key>
EOF
```

Run the container with the Copilot harness:

```bash
docker rm -f pf-copilot >/dev/null 2>&1
docker run -d --name pf-copilot -p 18088:8088 \
  -e HARNESS=copilot --env-file /tmp/copilot-byok.env \
  pi-foundry-runtime:copilot-test
docker logs -f pf-copilot   # watch for copilot_provider_configured + server_listening
```

Test cases:

```bash
# 1) JSON round-trip — expect a real model reply (not "mock response: ...")
curl -s -X POST "http://127.0.0.1:18088/invocations" \
  -H "content-type: application/json" \
  -d '{"message":"Reply with exactly: ok"}'

# 2) SSE — expect multiple token events then a done event
curl -s -N -X POST "http://127.0.0.1:18088/invocations?stream=true" \
  -H "accept: text/event-stream" -H "content-type: application/json" \
  -d '{"message":"Count from 1 to 5."}'

# 3) Session resume — same agent_session_id twice, second turn should have context
SID=test-$(date +%s)
curl -s -X POST "http://127.0.0.1:18088/invocations?agent_session_id=$SID" \
  -H "content-type: application/json" -d '{"message":"My name is Ada."}'
curl -s -X POST "http://127.0.0.1:18088/invocations?agent_session_id=$SID" \
  -H "content-type: application/json" -d '{"message":"What is my name?"}'
```

Cleanup: `docker rm -f pf-copilot`

### Two risk points this validates

1. **Azure baseURL normalization** — adapter strips `/openai/v1` (and `/openai`,
   `/v1`) to the resource root for Copilot's azure provider, sets
   `wireApi: "responses"`. Unverified against a live `*.cognitiveservices.azure.com`
   endpoint. If it 404s/401s, try overrides on the container:
   - `-e COPILOT_PROVIDER_TYPE=azure|openai`
   - `-e COPILOT_WIRE_API=responses|completions`
   - `-e COPILOT_API_VERSION=2024-10-21`
   Check the `copilot_provider_configured` log line for the resolved
   `type/baseUrl/wireApi/wireModel`.
2. **resume-vs-create** — adapter tries `resumeSession` first, falls back to
   `createSession` with the same id. Confirm test case 3 retains context and no
   errors on the first (create) turn.

## Next — Stage B: real Foundry Hosted Agent deploy

1. Push the branch runtime image to a registry the ACR remote build can pull
   `FROM` (your ACR or a personal ghcr). We are not committing a release tag, so
   build/push manually (CI `workflow_dispatch` only builds committed refs):
   ```bash
   docker tag pi-foundry-runtime:copilot-test <registry>/pi-foundry-runtime:copilot-test
   docker push <registry>/pi-foundry-runtime:copilot-test
   ```
2. Bootstrap a throwaway agent repo with the pi-foundry skill, pointing at that
   runtime image (`bootstrap.mjs --runtime-image <registry>/...`).
3. **Wire the harness** (skill is not HARNESS-aware yet — see follow-up):
   - append `HARNESS` (and any `COPILOT_*`) to `agent.yaml` +
     `agent.manifest.yaml` under `environment_variables`
   - `azd env set HARNESS=copilot`
   - `configure-env.mjs ... --model ... --base-url ... --api-key-env ...`
     (the PI_OPENAI_* triple is what the Copilot adapter reads)
4. `azd deploy` then `verify.mjs` (invocations REST + `Foundry-Features:
   HostedAgents=V1Preview`), plus a `--session <id>` continuity check.

Inputs still needed: model endpoint/key, registry for the runtime image,
`FOUNDRY_PROJECT_ENDPOINT` / `AZURE_SUBSCRIPTION_ID` / `AZURE_LOCATION` /
`AZURE_CONTAINER_REGISTRY_ENDPOINT`, HostedAgents preview enabled.

## Follow-ups (separate from this branch)

- Make the pi-foundry skill **HARNESS-aware**: `bootstrap` templates
  (`agent.yaml`, `agent.manifest.yaml`) and `configure-env.mjs` should know
  `HARNESS` and `COPILOT_*` so Stage B needs no hand-edits.
- Decide whether `Dockerfile.runtime` should pin `@earendil-works/pi-coding-agent`
  vs `@latest` (tracked separately as the version-drift known issue).
