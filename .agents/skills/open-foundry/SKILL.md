---
name: open-foundry
description: Helps a user deploy their existing coding-agent repo (pi, GitHub Copilot, or OpenAI Codex) to Microsoft Foundry Hosted Agents via a thin azd-compatible layout. Use when the user wants to add Foundry deployment to a local coding-agent repo, configure azd env settings, deploy with azd deploy, verify remote invocations, or debug deployment, session, and streaming issues.
---

# Deploy a Coding Agent to Foundry

You are the UX over the **open-foundry runtime image**. The runtime image owns the Foundry Invocations bridge, the in-process harness lifecycle (pi, GitHub Copilot, or OpenAI Codex), sessions, and streaming. Your job is to get the user from "I have a coding-agent repo" to "it runs on Foundry" with the minimum possible footprint in their repo.

The user should be able to say things like:

- "Deploy this agent to Foundry."
- "Add Foundry deployment to my current repo."
- "Why did azd up fail?"

## Prerequisites

Confirm these before bootstrapping; if missing, tell the user exactly what to install/obtain.

- **azd ≥ 1.25.4** with the Foundry extension: `azd version`, then `azd extension list` (expect `azure.ai.agents`); install with `azd extension install azure.ai.agents`. Sign in with `azd auth login`. `az` (Azure CLI) is **not** required — the scripts use `azd auth token` + ARM REST.
- **Node ≥ 20** to run the skill scripts.
- **A Foundry project**: subscription id, location, and project endpoint (`https://<account>.services.ai.azure.com/api/projects/<project>`).
- **A runtime image** the Foundry project can pull, named `<harness>-foundry-runtime`. Use the ready-to-use one for your harness — the contract `harnesses` table holds each one's `runtimeImage` (currently `ghcr.io/1openwindow/pi-foundry-runtime:0.1` for pi, `ghcr.io/1openwindow/ghcp-foundry-runtime:0.1` for GitHub Copilot, `ghcr.io/1openwindow/codex-foundry-runtime:0.1` for OpenAI Codex, `ghcr.io/1openwindow/opencode-foundry-runtime:0.1` for OpenCode). Advanced: pin an exact version or build your own (see [docs/runtime-image.md](https://github.com/1openwindow/open-foundry/blob/main/docs/runtime-image.md)).
- **A container registry** (`<acr>.azurecr.io`) for `azd deploy`'s remote build, with `AcrPull` granted to the Foundry agent identities.
- **A model**: OpenAI-compatible endpoint + model name, plus either an API key or — for keyless `managed-identity` — the Azure rights to create a role assignment (`Owner` or `User Access Administrator` on the model account), since `grant-model-access.mjs` writes one.
- **Foundry `HostedAgents` preview** enabled for the tenant/subscription; without it, session creation returns `403 preview_feature_required`.

## Mental model

Three layers. Keep them separate; don't blur them.

```
User-owned coding-agent repo
  .agents/skills/ , prompts/ , MCP config , workspace files
        |
        v
Five thin standard files (this skill bootstraps them):
  Dockerfile, azure.yaml, agent.yaml, agent.manifest.yaml, .dockerignore
        |
        v
Versioned open-foundry runtime image (the contract product)
  Foundry Invocations host + in-process harness backend (pi / Copilot / Codex) + sessions
        |
        v
Microsoft Foundry Hosted Agents
```

Critical properties:

- **Zero open-foundry-private files in the user repo.** No private directories, generated config, or scripts — only the 5 azd-native files. If the user later wants to leave open-foundry, they delete 5 files and they're out.
- **All contract knowledge lives in the runtime image and `references/contract.json`.** Env var names, required-when rules, resource tiers, reserved prefixes: never hardcode them in conversation; read from contract.
- **`azd deploy` is the deploy command.** This is a thin layout with **no `infra/` Bicep** — the Foundry project and ACR already exist and are passed via env, so there is nothing to provision. `azd up` fails here (it looks for `infra/main.bicep`); use `azd deploy`. Don't wrap it. Don't add custom workflows. Don't introduce intermediate CLIs.

## Skill assets

```
SKILL.md                                this file
templates/
  Dockerfile, azure.yaml, agent.yaml,
  agent.manifest.yaml, .dockerignore    the 5 files bootstrap copies into the user repo
scripts/
  bootstrap.mjs                         cp templates/* into cwd, substitute placeholders
  configure-env.mjs                     wrap azd env set; never print secrets; reads contract
  grant-model-access.mjs                keyless: grant agent identity the model role (managed-identity only)
  verify.mjs                            stream an invocation over SSE (long-task verify; short tasks: azd ai agent invoke)
  _lib.mjs                              shared helpers (internal)
references/
  contract.json                         single source of truth for env / tiers / reserved prefixes
  troubleshooting.md                    error -> action map
```

Rules:

- **Use scripts only for deterministic side-effects** (file copy, env set, RBAC, invoke). Use plain `ls`, `cat`, `git status` for inspection; do not write a custom inspect script.
- **Always read `references/contract.json` before quoting env var names or rules to the user.** It is the spec.
- **Never write secrets to repo files or echo them back.** Set the model API key with `azd env set OF_OPENAI_API_KEY=<key>` — by default the user runs it (keeps the key out of chat); only run it yourself if they paste it.
- **Never edit the user's `.agents/skills/`, prompts, MCP config, or business code.**
- **Never invent a `open-foundry.yaml` or `.azd/open-foundry/` directory.** That is the old layout.
- If a user repo already has a non-open-foundry `azure.yaml`, **stop and ask** before replacing. Back up before overwriting.

## First steps every time

1. Identify the current directory:
   - **User coding-agent repo**: has `.agents/skills/` (with skills other than `open-foundry`), `prompts/`, `mcp.config.json`, or similar.
   - **Already bootstrapped repo**: has `agent.yaml` with `kind: hosted` and open-foundry-style env vars.
   - **open-foundry development checkout**: has `Dockerfile.runtime` and `.agents/skills/open-foundry/SKILL.md`. **Do not bootstrap here.**
2. Determine the harness from the **runtime image** — never from repo structure:
  - **Already bootstrapped**: read the runtime image out of the root `Dockerfile` (`ARG OPEN_FOUNDRY_RUNTIME_IMAGE=` / `FROM`). The image is named `<harness>-foundry-runtime`, so its prefix selects the harness — the prefix⇒harness mappings live in the contract `harnesses` table (e.g. `pi-foundry-runtime` ⇒ pi, `ghcp-foundry-runtime` ⇒ copilot, `codex-foundry-runtime` ⇒ codex, `opencode-foundry-runtime` ⇒ opencode). `bootstrap.mjs` and `configure-env.mjs` do this inference for you.
  - **Not yet bootstrapped**: there is nothing to infer from. Ask the user which harness they want, then offer the matching `runtimeImage` from the contract `harnesses` table as a default they can accept as-is (currently `ghcr.io/1openwindow/pi-foundry-runtime:0.1` for pi, `ghcr.io/1openwindow/ghcp-foundry-runtime:0.1` for Copilot, `ghcr.io/1openwindow/codex-foundry-runtime:0.1` for Codex, `ghcr.io/1openwindow/opencode-foundry-runtime:0.1` for OpenCode). Default to pi unless they ask for Copilot, Codex, or OpenCode. Don't make them hunt for a registry or tag.
  - Repo files like `.github/agents/*.md`, `.github/copilot-instructions.md`, `.pi/settings.json`, `.codex/`, or `.opencode/` are at most a **hint** ("this looks like it may be aimed at Copilot/pi/codex/opencode") — they never decide the harness. If an image name is custom/unrecognizable, ask the user "is this a pi, copilot, codex, or opencode image?".
3. Use plain commands: `pwd`, `ls -la`, `cat azure.yaml 2>/dev/null`, `git status --short`. No special inspect script.
4. State what you plan to do before running any mutating command.

## Required inputs

Ask the user only for what you can't infer:

- **Agent name** — default to a sanitized version of the repo directory name. Lowercase a-z/0-9/hyphen, 3-64 chars.
- **Runtime image** — this is also the **harness selector**: the image is named `<harness>-foundry-runtime`, so its prefix picks the harness (prefix⇒harness mappings live in the contract `harnesses` table). Default to pi unless the user asks for Copilot, Codex, or OpenCode. Offer the chosen harness's `runtimeImage` from the contract — it works out of the box and the user can accept it as-is (currently `ghcr.io/1openwindow/pi-foundry-runtime:0.1` for pi, `ghcr.io/1openwindow/ghcp-foundry-runtime:0.1` for Copilot, `ghcr.io/1openwindow/codex-foundry-runtime:0.1` for Codex, `ghcr.io/1openwindow/opencode-foundry-runtime:0.1` for OpenCode); never ask them to supply a registry or tag. Advanced: pin an exact version or provide your own like `<acr>.azurecr.io/<harness>-foundry-runtime:<tag>`; see [docs/runtime-image.md](https://github.com/1openwindow/open-foundry/blob/main/docs/runtime-image.md) for how to build/publish one.
- **Model** — `OF_OPENAI_MODEL`, e.g. `gpt-4.1-mini`.
- **OpenAI-compatible endpoint** — `OF_OPENAI_BASE_URL`, usually `https://<account>.cognitiveservices.azure.com/openai/v1`.
- **Foundry project + subscription** — `FOUNDRY_PROJECT_ENDPOINT` (e.g. `https://<account>.services.ai.azure.com/api/projects/<project>`), `AZURE_SUBSCRIPTION_ID`, `AZURE_LOCATION`. `configure-env.mjs` derives `AZURE_AI_PROJECT_ID` (the project's ARM resource id, required by `azd deploy`) and `AZURE_TENANT_ID` from these automatically; if derivation fails it prints how to pass them explicitly.
- **Container registry** — `AZURE_CONTAINER_REGISTRY_ENDPOINT` (`<acr>.azurecr.io`) for the remote build. Take the endpoint of an ACR the project can pull from; the skill doesn't create or wire it.
- **API key** — `azd env set OF_OPENAI_API_KEY=<key>` (user runs it by default). `--from-env-file`/`--api-key-env` for CI; keyless `--model-auth managed-identity` is pi-only.

## Standard workflow

```text
1. Inspect repo (ls/cat).
2. Confirm agent name and runtime image with user.
3. node <skill>/scripts/bootstrap.mjs --agent-name <name> --runtime-image <image>
4. node <skill>/scripts/configure-env.mjs --env-name <env> --agent-name <name> --model <model> --base-url <url> \
     --acr <acr>.azurecr.io --foundry-project-endpoint <url> --azure-subscription-id <sub> --azure-location <region>
5. Have the user set the key: azd env set OF_OPENAI_API_KEY=<key>
6. azd deploy
7. azd ai agent invoke <name> '{"input": "<prompt>"}'   (long tasks: node <skill>/scripts/verify.mjs)
```

Where `<skill>` is the absolute path to this skill directory, e.g. `~/repos/open-foundry/.agents/skills/open-foundry`.

### Bootstrap

`bootstrap.mjs` writes 5 files at the repo root:

```
Dockerfile               # FROM <runtime-image>, COPY . /workspace
azure.yaml               # host: azure.ai.agent, points at Dockerfile
agent.yaml               # Hosted Agent definition with env_variables list
agent.manifest.yaml      # template manifest with {{VAR}} placeholders
.dockerignore            # excludes .git, .azure, .env, node_modules, .files
```

It refuses to overwrite existing files. If the user repo already has any of these, explain what would be replaced and re-run with `--force` (it auto-backs up `.bak.<timestamp>`).

It validates `--cpu`/`--memory` against `contract.json`'s `resourceTiers`. Allowed pairs: `0.25/0.5Gi, 0.5/1Gi, 1/2Gi, 2/4Gi`.

### Configure env

`configure-env.mjs` is a thin wrapper around `azd env set` with three properties:

- Uses `KEY=value` form so values that begin with `--` or contain shell-sensitive characters (e.g. `$web`) aren't reparsed by azd.
- Refuses to print secrets; logs them as `<redacted>`.
- When `--from-env-file <path>` is given, strips reserved `AGENT_*`/`FOUNDRY_*` (except `FOUNDRY_PROJECT_ENDPOINT`), so values copied from another agent's `.env` don't cross-contaminate.

If the user wants additional env vars (e.g. `GITHUB_TOKEN`), tell them to:
1. `azd env set GITHUB_TOKEN=<value>` directly.
2. Append it to `agent.yaml` and `agent.manifest.yaml` under `environment_variables`.

### Deploy

Just `azd deploy` (not `azd up` — there is no `infra/` to provision; see the mental model note). The skill does not wrap or intercept it. If it fails, look at `references/troubleshooting.md`.

### Keyless (managed identity)

For `OF_MODEL_AUTH=managed-identity` (no API key), the Hosted Agent calls the model with its own **Instance Identity**, which must hold a data-plane role on the model account or invocations return 401/403. After the first `azd deploy` (the identity only exists once deployed), grant it:

```text
node <skill>/scripts/grant-model-access.mjs
```

It resolves the agent's Instance Identity Principal ID from `azd ai agent show`, the model account scope from `AZURE_AI_PROJECT_ID`, and grants `Cognitive Services OpenAI User` via ARM REST (no `az` CLI needed; idempotent). Then redeploy so the new revision picks up keyless auth. Use `--dry-run` to preview the principal/scope/role first. The Instance Identity is stable across versions, so this is a one-time grant per agent.

### Harness selection

The harness is fixed by the **runtime image** — there is no `HARNESS` knob to set. Each harness
ships as its own `<harness>-foundry-runtime` image (a `pi-foundry-runtime` image has no Copilot or
Codex, and vice versa); pick the one you want at bootstrap and everything else is identical:

```text
node <skill>/scripts/bootstrap.mjs --agent-name <name> --runtime-image <acr>/<harness>-foundry-runtime:<tag>
node <skill>/scripts/configure-env.mjs --env-name <env> --agent-name <name> \
  --model <model> --base-url <url>
```

The harnesses differ only in two **data-driven** ways, both read from the contract `harnesses`
table — no harness names are hardcoded in the scripts or runtime:

- **Driver** — pi runs pi-coding-agent via its in-process SDK; copilot runs `@github/copilot-sdk`;
  codex runs `@openai/codex-sdk`; opencode runs `@opencode-ai/sdk` (the `opencode` CLI server).
- **Model auth** — pi supports both `apikey` and keyless `managed-identity`. Copilot, Codex, and
  OpenCode are
  BYOK **apikey-only**, so `--model-auth managed-identity` is rejected: `configure-env.mjs` catches
  it locally (by reading the runtime image from `./Dockerfile`) and the runtime rejects it at startup
  as a backstop.

Copilot and Codex ship verified provider defaults (`COPILOT_*` / `CODEX_*`) that need no flags —
override them in `agent.yaml` + `agent.manifest.yaml` if needed; pi builds its `foundry` provider
from `OF_OPENAI_BASE_URL` + `OF_OPENAI_MODEL`.

### Verify

For a short smoke test, use `azd ai agent invoke <name> '{"input": "<prompt>"}'`. For long tasks (>~120s), use `verify.mjs`: it streams the invocation over SSE so the runtime's keepalive bytes outlast Foundry's ~120s gateway idle timeout, which a non-streaming `azd ai agent invoke` cannot. It mints a data-plane token with `azd auth token` and auto-discovers the endpoint and agent name from `azd env` + `agent.yaml`. Pass `--session <id>` to reuse a session for continuity tests; omit it to start a new session.

## Troubleshooting

When something fails:

1. Read the error.
2. Open `references/troubleshooting.md`, find a matching symptom.
3. Give the user **one sentence** for the cause and **one command** for the fix.
4. If nothing matches, fall back to:
   - `azd ai agent doctor --no-prompt`
   - `azd ai agent show <agent-name> --output json --no-prompt`
   - `azd ai agent monitor <agent-name> --tail 100 --type console`

Common patterns are in `references/troubleshooting.md`; don't re-derive them in chat.

## Re-deploys, env changes

The skill is **stateless and reentrant**. To change model or swap regions:

```text
node <skill>/scripts/configure-env.mjs --agent-name <name> --model <new-model>
azd deploy
```

## Hard rules (do not violate)

Red lines not already in the Rules above:

- ❌ No wrapping `azd` with intermediate scripts.
- ❌ No personal/internal ACR names, model names, or model endpoints as defaults — always require explicit user input. (The public `runtimeImage`s in the contract `harnesses` table are this repo's own images and fine to suggest as defaults.)
- ✅ Inspect with `ls`/`cat`; mutate with the bundled scripts; deploy with plain `azd deploy`.

## Communication style

- One concise question at a time when collecting inputs.
- State assumptions before mutating.
- Translate errors to "one-sentence cause + one-command fix".
- Don't dump long command lists when the user asked you to do the work — execute and report.
