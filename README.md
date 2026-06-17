# open-foundry

[![skills.sh](https://skills.sh/b/1openwindow/open-foundry)](https://skills.sh/1openwindow/open-foundry)

Deploy your existing **Pi, GitHub Copilot, OpenAI Codex, or OpenCode** agent repo
to **Microsoft Foundry Hosted Agents** — by adding 5 standard `azd` files, nothing else.

Your repo stays the source of truth. No private framework directory is installed.
To stop using open-foundry, delete the 5 files and you're out.

## How it works

open-foundry gives you two things:

1. **Runtime images** — containers that handle the Foundry Invocations protocol,
   harness lifecycle, sessions, streaming, and health checks.
2. **A skill** that adds the 5 `azd` files to your repo and runs `azd deploy`.

```
your-agent-repo/
  .agents/skills/, prompts/, mcp.config.json, workspace files   ← unchanged
  Dockerfile, azure.yaml, agent.yaml, agent.manifest.yaml, .dockerignore   ← added
                       │
                       ▼
        <harness>-foundry-runtime:<tag>   (image picks the harness)
                       │
                       ▼
         Microsoft Foundry Hosted Agents
```

The runtime image name selects the harness:

| Image | Harness | Model auth |
|---|---|---|
| `pi-foundry-runtime` | Pi | API key or managed identity |
| `ghcp-foundry-runtime` | GitHub Copilot | API key only |
| `codex-foundry-runtime` | OpenAI Codex | API key only |
| `opencode-foundry-runtime` | OpenCode | API key only |

Public images: `ghcr.io/1openwindow/<image>:0.1`.

## Install the skill

```bash
npx skills add 1openwindow/open-foundry
```

Then, in an agent session inside your repo, just ask: **"Deploy this agent to Foundry."**

## Quickstart

You need: `azd` ≥ 1.25.4 with the `azure.ai.agents` extension, a Foundry project,
a container registry the project can pull from, and an OpenAI-compatible
endpoint + model + API key.

```bash
SKILL=path/to/open-foundry/.agents/skills/open-foundry
IMAGE=ghcr.io/1openwindow/pi-foundry-runtime:0.1   # swap for the harness you want

node $SKILL/scripts/bootstrap.mjs     --agent-name <name> --runtime-image $IMAGE
node $SKILL/scripts/configure-env.mjs --env-name <env> --agent-name <name> --model <model> --base-url <url> --api-key-env OF_OPENAI_API_KEY \
                                      --acr <acr>.azurecr.io --foundry-project-endpoint <url> --azure-subscription-id <sub> --azure-location <region>
azd deploy
node $SKILL/scripts/verify.mjs
```

Notes:
- Deploy with `azd deploy`, not `azd up` — this is a thin layout with no `infra/` to provision.
- The Pi runtime also supports keyless auth via `OF_MODEL_AUTH=managed-identity`; the others are API-key only.
- The skill ships no model, ACR, or endpoint defaults — you provide those per deployment.

## Sample agent repos

Ready-made repos to try a deploy end-to-end:

- [of-pi-agent](https://github.com/1openwindow/of-pi-agent) — Pi
- [of-ghcp-agent](https://github.com/1openwindow/of-ghcp-agent) — GitHub Copilot
- [of-codex-agent](https://github.com/1openwindow/of-codex-agent) — OpenAI Codex
- [of-opencode-agent](https://github.com/1openwindow/of-opencode-agent) — OpenCode

## Runtime contract

The runtime image owns these environment variables (source of truth: `src/contract.mjs`):

| Variable | Required when | Notes |
|---|---|---|
| `OF_OPENAI_API_KEY` / `OF_OPENAI_BASE_URL` / `OF_OPENAI_MODEL` | live (`OF_MOCK!=1`) | OpenAI-compatible triple |
| `OF_MOCK` | optional | `1` = run without a real model (smoke test) |
| `OF_MODEL_AUTH` | optional | `apikey` (default) or `managed-identity` (Pi only) |
| `HARNESS` | baked into the image | do not set in `azd` env |

Reserved (Foundry-owned, do not redefine): `AGENT_*`, `FOUNDRY_*`
(except `FOUNDRY_PROJECT_ENDPOINT`). If the live triple is missing and `OF_MOCK`
is unset, the runtime fails fast at startup. Inside the container, run
`open-foundry contract` or `open-foundry doctor`.

## Local development

```bash
npm test                                       # unit + SSE integration, no Docker
OF_MOCK=1 npm run start:backend                # local mock backend
npm run runtime:build && npm run runtime:smoke # build + smoke image (Docker)
npm run emit:contract                          # refresh skill's contract.json
```

## Docs

- [SKILL.md](./.agents/skills/open-foundry/SKILL.md) — skill behavior (canonical UX doc)
- [DEPLOY.md](./DEPLOY.md) — manual deploy primitives, verify, monitor, common failures
- [docs/runtime-image.md](./docs/runtime-image.md) — build / publish the runtime image
- [docs/http-api.md](./docs/http-api.md) — raw HTTP shape for direct callers
