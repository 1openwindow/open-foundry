# pi-foundry

[![skills.sh](https://skills.sh/b/1openwindow/pi-foundry)](https://skills.sh/1openwindow/pi-foundry)

Deploy an existing Pi agent repo to **Microsoft Foundry Hosted Agents** with a
minimal, standard `azd` layout.

You bring the Pi agent (skills, prompts, MCP config, model settings).
pi-foundry provides two things, and nothing else:

1. **`pi-foundry-runtime`** — a versioned container image that owns the
   Foundry Invocations protocol, Pi RPC, session mapping, streaming, and
   health/readiness.
2. **A Pi skill** at `.agents/skills/pi-foundry/` that bootstraps 5 standard
   `azd` files into your repo and runs `azd deploy`.

Your repo stays the source of truth. No private framework directory is
installed. If you stop using pi-foundry you delete 5 files and you're out.

```
your-pi-agent-repo/
  .agents/skills/, prompts/, mcp.config.json, workspace files     ← unchanged
  Dockerfile, azure.yaml, agent.yaml, agent.manifest.yaml, .dockerignore   ← added
                       │
                       ▼
            pi-foundry-runtime:<tag>      ← versioned image (this repo's product)
                       │
                       ▼
         Microsoft Foundry Hosted Agents
```

## Install the skill

The pi-foundry skill lives at `.agents/skills/pi-foundry/`. Install it into your
agent (Claude Code, OpenCode, Codex, Cursor, …) with the [skills](https://www.skills.sh) CLI:

```bash
npx skills add 1openwindow/pi-foundry           # install
npx skills add 1openwindow/pi-foundry --list     # preview what's in the repo
```

Then, in an agent session inside your Pi agent repo, just ask it to deploy (see
Quickstart). You can also run the scripts by hand without installing the skill.

## Quickstart

In any Pi session inside your Pi agent repo, ask:

> Deploy this Pi agent to Foundry.

The skill confirms agent name + runtime image, then runs the four primitives
below. Run them by hand if you prefer (the example uses the published public
runtime image so you can try it immediately):

```bash
SKILL=path/to/pi-foundry/.agents/skills/pi-foundry
IMAGE=ghcr.io/1openwindow/pi-foundry-runtime:0.1.0   # public trial image; publish your own for production

node $SKILL/scripts/bootstrap.mjs       --agent-name <name> --runtime-image $IMAGE
node $SKILL/scripts/configure-env.mjs   --env-name <env> --agent-name <name> --model <model> --base-url <url> --api-key-env PI_OPENAI_API_KEY \
                                        --acr <acr>.azurecr.io --foundry-project-endpoint <url> --azure-subscription-id <sub> --azure-location <region>
azd deploy
node $SKILL/scripts/verify.mjs
```

Note: this is a thin `azd` layout with no `infra/` to provision, so deploy with
`azd deploy` (not `azd up`). `configure-env.mjs` derives the two values `azd
deploy` needs but are awkward to find by hand — `AZURE_AI_PROJECT_ID` (the
project's ARM resource id) and `AZURE_TENANT_ID` — from the project endpoint and
subscription.

You need: `azd` (≥ 1.25.4) with the `azure.ai.agents` extension, a Foundry
project, a runtime image your project can pull (use the public
`ghcr.io/1openwindow/pi-foundry-runtime:0.1.0` to try it, or publish your own),
and a Foundry OpenAI-compatible endpoint + model + an API key (or keyless
managed-identity auth via `PI_MODEL_AUTH=managed-identity`).

The skill ships no model, ACR, or endpoint defaults — you provide those once per
deployment. The only suggested default is the public runtime image above.

## Runtime contract

The runtime image owns these environment variables. Source of truth is
`src/contract.mjs`; the skill's `references/contract.json` is regenerated
from it via `npm run emit:contract`.

| Variable | Required when | Notes |
|---|---|---|
| `PI_OPENAI_API_KEY` / `PI_OPENAI_BASE_URL` / `PI_OPENAI_MODEL` | live (`PI_MOCK!=1`) | OpenAI-compatible triple |
| `PI_ARGS` | optional | defaults to `--mode rpc --no-session`; skill adds `--provider foundry --model <model>` |
| `PI_MOCK` | optional | `1` = run without a real model (smoke) |
| `PI_MODEL_AUTH` | optional | `apikey` (default) or `managed-identity` (keyless) |

Reserved (Foundry-owned, do not redefine): `AGENT_*`, `FOUNDRY_*`
(exception: `FOUNDRY_PROJECT_ENDPOINT`).

When `PI_MOCK` is unset and any of the live triple is missing, the runtime
**fails fast** at startup. Inside the container:

```bash
pi-foundry contract   # full contract JSON
pi-foundry doctor     # exit 1 + JSON report when required env is missing
```

## Repository layout

```
src/                            invocations host, contract SoT, in-container CLI
Dockerfile.runtime              builds pi-foundry-runtime (single Node process)
.agents/skills/pi-foundry/      the skill (SKILL.md + templates + scripts)
scripts/                        runtime build/smoke, emit:contract
test/                           npm test (node --test)
docs/                           runtime-image, reference/
```

## Local development

```bash
npm test                                       # unit + SSE integration, no Docker
PI_MOCK=1 npm run start:backend                # local mock backend
npm run runtime:build && npm run runtime:smoke # build + smoke image (Docker)
npm run emit:contract                          # refresh skill's contract.json
```

## Related docs

- [SKILL.md](./.agents/skills/pi-foundry/SKILL.md) — skill behavior contract (canonical UX doc)
- [DEPLOY.md](./DEPLOY.md) — manual deploy primitives, verify, monitor, common failures, HTTP API
- [docs/runtime-image.md](./docs/runtime-image.md) — build / publish the runtime image
- [docs/http-api.md](./docs/http-api.md) — raw HTTP shape (for direct callers / debugging)
