# pi-foundry

Deploy an existing Pi agent repo to **Microsoft Foundry Hosted Agents** with a
minimal, standard `azd` layout. You bring the Pi agent (skills, prompts, MCP
config, model settings). pi-foundry provides:

- a versioned runtime container image (`pi-foundry-runtime`) that owns the
  Foundry Invocations protocol bridge, Pi RPC lifecycle, session mapping,
  streaming, health/readiness, and artifact publishing,
- a Pi skill at `.agents/skills/pi-foundry/` that bootstraps 5 standard files
  into your repo and runs `azd up`.

Your repo stays the source of truth. No private framework directory is
installed; if you ever stop using pi-foundry you delete five files and you are
out.

```
your-pi-agent-repo/
  .agents/skills/ , prompts/ , mcp.config.json , workspace files     ← unchanged
  Dockerfile, azure.yaml, agent.yaml, agent.manifest.yaml, .dockerignore  ← added
                       │
                       ▼
            pi-foundry-runtime:<tag>      ← versioned image, contract product
                       │
                       ▼
         Microsoft Foundry Hosted Agents
```

## Three layers, kept separate

| Layer | Lives in | Owned by |
|---|---|---|
| User Pi agent | your repo | you |
| 5 thin azd files | your repo (root) | bootstrap (regeneratable) |
| Foundry Invocations bridge, Pi RPC, artifacts, sessions | `pi-foundry-runtime` image | this project |

The runtime image is **self-describing**: `pi-foundry contract` and
`pi-foundry doctor` run inside the container and print the env-var contract /
validate your config. The skill's `references/contract.json` is generated from
the same source of truth (`src/contract.mjs`), so there is no drift.

## Quickstart (skill-driven, recommended)

In any Pi session running inside your Pi agent repo, ask:

> 把我这个 Pi agent 部署到 Foundry。

The pi-foundry skill will inspect the repo, confirm the agent name and runtime
image with you, then run:

```bash
node <skill>/scripts/bootstrap.mjs       --agent-name <name> --runtime-image <acr>/pi-foundry-runtime:<tag>
node <skill>/scripts/configure-env.mjs   --env-name <env> --agent-name <name> --model <model> --base-url <url> --api-key-env PI_OPENAI_API_KEY
azd up
node <skill>/scripts/verify.mjs
# if artifacts are enabled:
node <skill>/scripts/grant-artifact-rbac.mjs
```

Where `<skill>` is the absolute path to `pi-foundry/.agents/skills/pi-foundry`.

You need:

- `azd` with the `azure.ai.agents` extension,
- a Foundry project (subscription, location, project endpoint),
- a published `pi-foundry-runtime` image accessible from your ACR (see
  [docs/runtime-image.md](./docs/runtime-image.md) to build/publish your own),
- a Foundry OpenAI-compatible endpoint, model name, and API key.

The skill never hardcodes a runtime image, model, or API endpoint. You provide
them once per deployment.

## Runtime contract (source of truth)

The runtime image owns these environment variables. The skill's
`references/contract.json` and `src/contract.mjs` are kept in sync via
`npm run emit:contract`.

| Variable | Required when | Notes |
|---|---|---|
| `PI_OPENAI_API_KEY` | live (i.e. `PI_MOCK!=1`) | OpenAI-compatible API key |
| `PI_OPENAI_BASE_URL` | live | OpenAI-compatible endpoint base |
| `PI_OPENAI_MODEL` | live | model/deployment name |
| `PI_ARGS` | optional | defaults to `--mode rpc --no-session`; the skill sets `--provider foundry --model <model>` when a model is configured |
| `PI_MOCK` | optional | `1` to run the backend without a real model (useful for smoke) |
| `ARTIFACT_PUBLISH_MODE` | optional | `disabled` (default) or `static-web` |
| `ARTIFACT_STORAGE_ACCOUNT`, `ARTIFACT_STATIC_WEB_ENDPOINT` | when `static-web` | Azure Storage account + Static Web endpoint |
| `ARTIFACT_BLOB_PREFIX` | optional | defaults to your agent name |
| `WORKSPACE_DIR`, `FILES_DIR`, `STATE_DIR`, `SESSIONS_DIR`, `PI_CODING_AGENT_DIR` | optional | runtime paths; the image sets safe defaults under `/workspace`, `/files`, `/home/node/.pi-foundry` |

Reserved prefixes (Foundry-owned, do not redefine): `AGENT_`, `FOUNDRY_*`
(exception: `FOUNDRY_PROJECT_ENDPOINT`).

When `PI_MOCK` is unset and any of the live triple is missing, the runtime
**fails fast** at startup with a structured error rather than silently falling
back to a maintainer-owned endpoint. Inside the container:

```bash
pi-foundry doctor    # JSON report, exit 1 on missing required env
pi-foundry contract  # full contract JSON
```

## Repository layout

```
src/                        Node Pi backend, runtime helpers, contract SoT, CLI
runtime/official-invocations/   Foundry Invocations protocol host wrapper
Dockerfile.runtime          builds the versioned pi-foundry-runtime image
.agents/skills/pi-foundry/  the skill: SKILL.md + templates + scripts + references
scripts/                    maintainer scripts (emit:contract, runtime build/smoke, artifact RBAC)
test/                       node --test unit + integration suite (npm test)
docs/                       per-feature deep dives (runtime image, artifacts)
```

## Local development

```bash
# unit + SSE integration tests (no Docker, no model needed)
npm test

# run the Node backend locally in mock mode (no model credentials needed)
PI_MOCK=1 npm run start:backend

# build and smoke-test the runtime image locally (requires Docker)
PI_FOUNDRY_RUNTIME_IMAGE=pi-foundry-runtime:local npm run runtime:build
PI_FOUNDRY_RUNTIME_IMAGE=pi-foundry-runtime:local npm run runtime:smoke

# regenerate skill's contract.json from src/contract.mjs
npm run emit:contract
```

For ACR-side image builds (no local Docker) and artifact-RBAC grants, see
[docs/runtime-image.md](./docs/runtime-image.md) and
[docs/artifacts.md](./docs/artifacts.md).

## API shape

`POST /invocations` (JSON):

```json
{ "message": "List files in the current directory.", "sessionId": "optional", "cwd": "." }
```

Response:

```json
{ "requestId": "...", "output": "...", "sessionId": "...", "mock": false, "artifacts": [] }
```

`POST /invocations` with `Accept: text/event-stream` (or `?stream=true`)
streams `data: {"type":"token","content":"..."}` deltas, terminated by:

```json
{ "type": "done", "full_text": "...", "session_id": "...", "request_id": "...", "artifacts": [], "artifact_publish_error": "<optional>" }
```

Stream contract:
- `token` events carry **model deltas only**.
- Server-side trailers (artifact links, publish errors) appear only in `done`
  as structured fields. Do not parse them out of `token` events.

`GET /artifacts/<path>` serves files under `FILES_DIR`; path traversal outside
that directory is rejected.

`GET /invocations/docs/openapi.json` returns the OpenAPI spec.

## Related docs

- [SKILL.md](./.agents/skills/pi-foundry/SKILL.md) — skill behavior contract (the canonical UX doc)
- [docs/runtime-image.md](./docs/runtime-image.md) — building and publishing the runtime image
- [docs/artifacts.md](./docs/artifacts.md) — artifact publishing setup and conventions
- [DEPLOY.md](./DEPLOY.md) — generic remote deploy reference (verify, monitor, common failures)
