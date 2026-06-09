# open-foundry

[![skills.sh](https://skills.sh/b/1openwindow/open-foundry)](https://skills.sh/1openwindow/open-foundry)

Deploy an existing Pi, GitHub Copilot, or OpenAI Codex agent repo to **Microsoft
Foundry Hosted Agents** with a minimal, standard `azd` layout.

You bring the agent repo (skills, prompts, MCP config, model settings).
open-foundry provides two things, and nothing else:

1. **Runtime images** — versioned container images that own the Foundry
   Invocations protocol, harness lifecycle, session mapping, streaming, and
   health/readiness.
2. **A skill** at `.agents/skills/open-foundry/` that bootstraps 5 standard `azd`
   files into your repo and runs `azd deploy`.

Runtime image names are the harness selector:

| Image | Harness | Notes |
|---|---|---|
| `pi-foundry-runtime:<tag>` | Pi | Includes `@earendil-works/pi-coding-agent`; supports API key or managed identity model auth. |
| `ghcp-foundry-runtime:<tag>` | GitHub Copilot | Includes `@github/copilot-sdk`; Copilot BYOK is API-key only. |
| `codex-foundry-runtime:<tag>` | OpenAI Codex | Includes `@openai/codex-sdk`; Codex BYOK is API-key only. |

Your repo stays the source of truth. No private framework directory is
installed. If you stop using open-foundry you delete 5 files and you're out.

```
your-agent-repo/
  .agents/skills/, prompts/, mcp.config.json, workspace files     ← unchanged
  Dockerfile, azure.yaml, agent.yaml, agent.manifest.yaml, .dockerignore   ← added
                       │
                       ▼
             pi-foundry-runtime:<tag>, ghcp-foundry-runtime:<tag>, or codex-foundry-runtime:<tag>
                       │
                       ▼
         Microsoft Foundry Hosted Agents
```

## Install the skill

The open-foundry skill lives at `.agents/skills/open-foundry/`. Install it into your
agent (Claude Code, OpenCode, Codex, Cursor, …) with the [skills](https://www.skills.sh) CLI:

```bash
npx skills add 1openwindow/open-foundry           # install
npx skills add 1openwindow/open-foundry --list     # preview what's in the repo
```

Then, in an agent session inside your agent repo, just ask it to deploy (see
Quickstart). You can also run the scripts by hand without installing the skill.

## Quickstart

In any agent session inside your repo, ask:

> Deploy this agent to Foundry.

The skill confirms agent name + runtime image, then runs the four primitives
below. Run them by hand if you prefer. The example uses the Pi runtime image;
use `ghcp-foundry-runtime:<tag>` instead for GitHub Copilot.

```bash
SKILL=path/to/open-foundry/.agents/skills/open-foundry
IMAGE=ghcr.io/1openwindow/pi-foundry-runtime:0.1   # Pi image; pin an exact version for production

node $SKILL/scripts/bootstrap.mjs       --agent-name <name> --runtime-image $IMAGE
node $SKILL/scripts/configure-env.mjs   --env-name <env> --agent-name <name> --model <model> --base-url <url> --api-key-env OF_OPENAI_API_KEY \
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
`ghcr.io/1openwindow/pi-foundry-runtime:0.1` to try Pi, or publish your own),
and a Foundry OpenAI-compatible endpoint + model + an API key. The Pi runtime
also supports keyless managed-identity auth via `OF_MODEL_AUTH=managed-identity`;
the GitHub Copilot and OpenAI Codex runtimes do not.

The skill ships no model, ACR, or endpoint defaults — you provide those once per
deployment. The only suggested default is the public Pi runtime image above.

### GitHub Copilot Runtime

To run the same Hosted Agent bridge with GitHub Copilot instead of Pi, bootstrap
with a `ghcp-foundry-runtime` image:

```bash
IMAGE=ghcr.io/1openwindow/ghcp-foundry-runtime:<tag>

node $SKILL/scripts/bootstrap.mjs     --agent-name <name> --runtime-image $IMAGE
node $SKILL/scripts/configure-env.mjs --env-name <env> --agent-name <name> --model <model> --base-url <url> --api-key-env OF_OPENAI_API_KEY \
                                      --acr <acr>.azurecr.io --foundry-project-endpoint <url> --azure-subscription-id <sub> --azure-location <region>
azd deploy
node $SKILL/scripts/verify.mjs
```

Do not use `--model-auth managed-identity` with `ghcp-foundry-runtime`; Copilot
BYOK is API-key only. There is no separate `HARNESS` setting in `azd` or
`agent.yaml` — the runtime image bakes the harness choice.

### OpenAI Codex Runtime

To run the same Hosted Agent bridge with OpenAI Codex instead of Pi, bootstrap
with a `codex-foundry-runtime` image:

```bash
IMAGE=ghcr.io/1openwindow/codex-foundry-runtime:<tag>

node $SKILL/scripts/bootstrap.mjs     --agent-name <name> --runtime-image $IMAGE
node $SKILL/scripts/configure-env.mjs --env-name <env> --agent-name <name> --model <model> --base-url <url> --api-key-env OF_OPENAI_API_KEY \
                                      --acr <acr>.azurecr.io --foundry-project-endpoint <url> --azure-subscription-id <sub> --azure-location <region>
azd deploy
node $SKILL/scripts/verify.mjs
```

Do not use `--model-auth managed-identity` with `codex-foundry-runtime`; Codex
BYOK is API-key only, same as the Copilot runtime.

## Sample agent repos

Ready-made repos to try a deploy end-to-end:

- [of-pi-agent](https://github.com/1openwindow/of-pi-agent) — minimal Pi agent (`pi-foundry-runtime`).
- [of-ghcp-agent](https://github.com/1openwindow/of-ghcp-agent) — minimal GitHub Copilot agent (`ghcp-foundry-runtime`).
- [of-codex-agent](https://github.com/1openwindow/of-codex-agent) — minimal OpenAI Codex agent (`codex-foundry-runtime`).

## Runtime contract

The runtime image owns these environment variables. Source of truth is
`src/contract.mjs`; the skill's `references/contract.json` is regenerated
from it via `npm run emit:contract`.

| Variable | Required when | Notes |
|---|---|---|
| `OF_OPENAI_API_KEY` / `OF_OPENAI_BASE_URL` / `OF_OPENAI_MODEL` | live (`OF_MOCK!=1`) | OpenAI-compatible triple |
| `PI_ARGS` | optional | defaults to `--mode rpc --no-session`; skill adds `--provider foundry --model <model>` |
| `OF_MOCK` | optional | `1` = run without a real model (smoke) |
| `OF_MODEL_AUTH` | optional | `apikey` (default) or `managed-identity` (keyless); apikey-only on the copilot and codex harnesses |
| `HARNESS` | baked into runtime image | `pi`, `copilot`, or `codex`; do not set in `azd` env for normal deployments |

Reserved (Foundry-owned, do not redefine): `AGENT_*`, `FOUNDRY_*`
(exception: `FOUNDRY_PROJECT_ENDPOINT`).

When `OF_MOCK` is unset and any of the live triple is missing, the runtime
**fails fast** at startup. Inside the container:

```bash
open-foundry contract   # full contract JSON
open-foundry doctor     # exit 1 + JSON report when required env is missing
```

## Repository layout

```
src/                            invocations host, contract SoT, in-container CLI
Dockerfile.runtime              builds pi-foundry-runtime, ghcp-foundry-runtime, or codex-foundry-runtime
.agents/skills/open-foundry/      the skill (SKILL.md + templates + scripts)
scripts/                        runtime build/smoke, emit:contract
test/                           npm test (node --test)
docs/                           runtime-image, reference/
```

## Local development

```bash
npm test                                       # unit + SSE integration, no Docker
OF_MOCK=1 npm run start:backend                # local mock backend
npm run runtime:build && npm run runtime:smoke # build + smoke image (Docker)
npm run emit:contract                          # refresh skill's contract.json
```

## Related docs

- [SKILL.md](./.agents/skills/open-foundry/SKILL.md) — skill behavior contract (canonical UX doc)
- [DEPLOY.md](./DEPLOY.md) — manual deploy primitives, verify, monitor, common failures, HTTP API
- [docs/runtime-image.md](./docs/runtime-image.md) — build / publish the runtime image
- [docs/http-api.md](./docs/http-api.md) — raw HTTP shape (for direct callers / debugging)
