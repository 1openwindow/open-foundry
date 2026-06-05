---
name: open-foundry
description: Helps a user deploy their existing Pi agent repo to Microsoft Foundry Hosted Agents via a thin azd-compatible layout. Use when the user wants to add Foundry deployment to a local Pi agent repo, configure azd/PI_* settings, deploy with azd deploy, verify remote invocations, or debug deployment, session, and streaming issues.
---

# Deploy a Pi Agent to Foundry

You are the UX over the **open-foundry runtime image**. The runtime image owns the Foundry Invocations bridge, Pi RPC lifecycle, sessions, and streaming. Your job is to get the user from "I have a Pi agent repo" to "it runs on Foundry" with the minimum possible footprint in their repo.

The user should be able to say things like:

- "Deploy this Pi agent to Foundry."
- "Add Foundry deployment to my current repo."
- "Why did azd up fail?"

## Prerequisites

Confirm these before bootstrapping; if missing, tell the user exactly what to install/obtain.

- **azd ≥ 1.25.4** with the Foundry extension: `azd version`, then `azd extension list` (expect `azure.ai.agents`); install with `azd extension install azure.ai.agents`. Sign in with `azd auth login`. `az` (Azure CLI) is **not** required — the scripts use `azd auth token` + ARM REST.
- **Node ≥ 20** to run the skill scripts.
- **A Foundry project**: subscription id, location, and project endpoint (`https://<account>.services.ai.azure.com/api/projects/<project>`).
- **A runtime image** the Foundry project can pull, named `<harness>-foundry-runtime`. For a quick trial use the published image for your harness — the contract `harnesses` table holds each one's `trialImage` (currently `ghcr.io/1openwindow/pi-foundry-runtime:0.1` for pi, `ghcr.io/1openwindow/ghcp-foundry-runtime:0.1` for GitHub Copilot); for production pin an exact version or publish your own (see [docs/runtime-image.md](https://github.com/1openwindow/open-foundry/blob/main/docs/runtime-image.md)).
- **A container registry** (`<acr>.azurecr.io`) for `azd deploy`'s remote build, with `AcrPull` granted to the Foundry agent identities.
- **A model**: OpenAI-compatible endpoint + model name, plus either an API key or — for keyless `managed-identity` — the Azure rights to create a role assignment (`Owner` or `User Access Administrator` on the model account), since `grant-model-access.mjs` writes one.
- **Foundry `HostedAgents` preview** enabled for the tenant/subscription; invocations send `Foundry-Features: HostedAgents=V1Preview` and otherwise return `403 preview_feature_required`.

## Mental model

Three layers. Keep them separate; don't blur them.

```
User-owned Pi agent repo
  .agents/skills/ , prompts/ , MCP config , workspace files
        |
        v
Five thin standard files (this skill bootstraps them):
  Dockerfile, azure.yaml, agent.yaml, agent.manifest.yaml, .dockerignore
        |
        v
Versioned open-foundry runtime image (the contract product)
  Foundry Invocations host + Pi RPC backend + sessions
        |
        v
Microsoft Foundry Hosted Agents
```

Critical properties:

- **Zero open-foundry-private files in the user repo.** No `.azd/open-foundry/`, no `open-foundry.yaml`, no `lock.yaml`, no `render.mjs`, no `doctor.mjs`. Only the 5 azd-native files. If the user later wants to leave open-foundry, they delete 5 files and they're out.
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
  verify.mjs                            invoke over the invocations REST endpoint (sends the Foundry preview header)
  _lib.mjs                              shared helpers (internal)
references/
  contract.json                         single source of truth for env / tiers / reserved prefixes
  troubleshooting.md                    error -> action map
```

Rules:

- **Use scripts only for deterministic side-effects** (file copy, env set, RBAC, invoke). Use plain `ls`, `cat`, `git status` for inspection; do not write a custom inspect script.
- **Always read `references/contract.json` before quoting env var names or rules to the user.** It is the spec.
- **Never write secrets to repo files or print them in responses.** Pass them via `--api-key-env` or `--from-env-file`.
- **Never edit the user's `.agents/skills/`, prompts, MCP config, or business code.**
- **Never invent a `open-foundry.yaml` or `.azd/open-foundry/` directory.** That is the old layout.
- If a user repo already has a non-open-foundry `azure.yaml`, **stop and ask** before replacing. Back up before overwriting.

## First steps every time

1. Identify the current directory:
   - **User Pi agent repo**: has `.agents/skills/` (with skills other than `open-foundry`), `prompts/`, `mcp.config.json`, or similar.
   - **Already bootstrapped repo**: has `agent.yaml` with `kind: hosted` and open-foundry-style env vars.
   - **open-foundry development checkout**: has `Dockerfile.runtime` and `.agents/skills/open-foundry/SKILL.md`. **Do not bootstrap here.**
2. Determine the harness from the **runtime image** — never from repo structure:
   - **Already bootstrapped**: read the runtime image out of the root `Dockerfile` (`ARG OPEN_FOUNDRY_RUNTIME_IMAGE=` / `FROM`). The image is named `<harness>-foundry-runtime`, so its prefix selects the harness — the prefix⇒harness mappings live in the contract `harnesses` table (e.g. `pi-foundry-runtime` ⇒ pi, `ghcp-foundry-runtime` ⇒ copilot). `bootstrap.mjs` and `configure-env.mjs` do this inference for you.
   - **Not yet bootstrapped**: there is nothing to infer from. Ask the user which harness they want, then offer the matching `trialImage` from the contract `harnesses` table as a default they can accept as-is (currently `ghcr.io/1openwindow/pi-foundry-runtime:0.1` for pi, `ghcr.io/1openwindow/ghcp-foundry-runtime:0.1` for Copilot). Default to pi unless they ask for Copilot. Don't make them hunt for a registry or tag.
   - Repo files like `.github/agents/*.md`, `.github/copilot-instructions.md`, or `.pi/settings.json` are at most a **hint** ("this looks like it may be aimed at Copilot/pi") — they never decide the harness. If an image name is custom/unrecognizable, ask the user "is this a pi or copilot image?".
3. Use plain commands: `pwd`, `ls -la`, `cat azure.yaml 2>/dev/null`, `git status --short`. No special inspect script.
4. State what you plan to do before running any mutating command.

## Required inputs

Ask the user only for what you can't infer:

- **Agent name** — default to a sanitized version of the repo directory name. Lowercase a-z/0-9/hyphen, 3-64 chars.
- **Runtime image** — this is also the **harness selector**: the image is named `<harness>-foundry-runtime`, so its prefix picks the harness (prefix⇒harness mappings live in the contract `harnesses` table). Default to pi unless the user asks for Copilot. For a quick trial, offer the chosen harness's `trialImage` from the contract — it works out of the box and the user can accept it as-is (currently `ghcr.io/1openwindow/pi-foundry-runtime:0.1` for pi, `ghcr.io/1openwindow/ghcp-foundry-runtime:0.1` for Copilot); never ask them to supply a registry or tag for a trial. For production, pin an exact version or provide your own like `<acr>.azurecr.io/<harness>-foundry-runtime:<tag>`; see [docs/runtime-image.md](https://github.com/1openwindow/open-foundry/blob/main/docs/runtime-image.md) for how to build/publish one.
- **Model** — `OF_OPENAI_MODEL`, e.g. `gpt-4.1-mini`. Default `PI_ARGS` is built from it.
- **OpenAI-compatible endpoint** — `OF_OPENAI_BASE_URL`, usually `https://<account>.cognitiveservices.azure.com/openai/v1`.
- **Foundry project + subscription** — `FOUNDRY_PROJECT_ENDPOINT` (e.g. `https://<account>.services.ai.azure.com/api/projects/<project>`), `AZURE_SUBSCRIPTION_ID`, `AZURE_LOCATION`. `configure-env.mjs` derives `AZURE_AI_PROJECT_ID` (the project's ARM resource id, required by `azd deploy`) and `AZURE_TENANT_ID` from these automatically; if derivation fails it prints how to pass them explicitly.
- **Container registry** — `AZURE_CONTAINER_REGISTRY_ENDPOINT` (`<acr>.azurecr.io`) for the remote build.
- **API key** — never as a CLI arg. Either env var name (`--api-key-env`) or `--from-env-file`. Or use keyless `--model-auth managed-identity`.

## Standard workflow

```text
1. Inspect repo (ls/cat).
2. Confirm agent name and runtime image with user.
3. node <skill>/scripts/bootstrap.mjs --agent-name <name> --runtime-image <image>
4. node <skill>/scripts/configure-env.mjs --env-name <env> --agent-name <name> --model <model> --base-url <url> --api-key-env <ENV> \
     --acr <acr>.azurecr.io --foundry-project-endpoint <url> --azure-subscription-id <sub> --azure-location <region>
5. azd deploy
6. node <skill>/scripts/verify.mjs
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

- Uses `KEY=value` form so values like `--mode rpc ...` and `$web` aren't reparsed by azd.
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

### GitHub Copilot harness

The harness is fixed by the runtime image — there is no `HARNESS` knob to set. To run on
GitHub Copilot instead of pi, bootstrap with a `ghcp-foundry-runtime` image (the
`pi-foundry-runtime` image has no Copilot, and vice versa); everything else is identical.
The same pattern holds for any harness in the contract `harnesses` table — pick its
`<harness>-foundry-runtime` image.

```text
node <skill>/scripts/bootstrap.mjs --agent-name <name> --runtime-image <acr>/ghcp-foundry-runtime:<tag>
node <skill>/scripts/configure-env.mjs --env-name <env> --agent-name <name> \
  --model <model> --base-url <url> --api-key-env <ENV>
```

Copilot BYOK is API-key only, so `--model-auth managed-identity` is rejected — `configure-env.mjs`
catches it locally (by reading the runtime image from `./Dockerfile`) and the runtime rejects it at
startup as a backstop. The verified `COPILOT_*` defaults need no flags; override them in `agent.yaml`
+ `agent.manifest.yaml` if needed.

### Verify

`verify.mjs` smoke-tests the deployed agent over the **invocations REST endpoint**. It does not use `azd ai agent invoke`, because Hosted Agent session creation currently requires the opt-in header `Foundry-Features: HostedAgents=V1Preview` that the CLI does not send (otherwise HTTP 403 `preview_feature_required`). The script mints a data-plane token with `azd auth token`, creates a session, and POSTs the invocation with that header. It auto-discovers the endpoint and agent name from `azd env` + `agent.yaml`. Pass `--session <id>` to reuse a session for continuity tests; omit it to start a new session.

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

To migrate from the old `.azd/open-foundry/` layout (legacy users only):

- Read their `.azd/open-foundry/open-foundry.yaml` to recover values.
- Run `bootstrap.mjs --force` with those values.
- Delete `.azd/open-foundry/` and any root `agent.yaml`/`agent.manifest.yaml` generated by the old `render.mjs` (the new templates put them in the same place; check headers — old ones say "Generated by open-foundry").

## Hard rules (do not violate)

- ❌ No `.azd/open-foundry/` directory in user repo.
- ❌ No `open-foundry.yaml`, no `open-foundry.lock.yaml`, no `render.mjs`/`doctor.mjs`/`postdeploy.mjs` copied into user repo.
- ❌ No secrets in repo files or chat output.
- ❌ No edits to `.agents/skills/` (other than this skill), prompts, MCP config, business code.
- ❌ No wrapping `azd` with intermediate scripts.
- ❌ No personal/internal **ACR** names, model names, or model endpoints as defaults. Always require explicit user input for those. (The public `trialImage`s in the contract `harnesses` table — e.g. `ghcr.io/1openwindow/<harness>-foundry-runtime:<tag>` — are this repo's published contract product and are fine to suggest as trial values.)
- ✅ Inspect with `ls`/`cat`; mutate with the bundled scripts; deploy with `azd deploy`.

## Communication style

- One concise question at a time when collecting inputs.
- State assumptions before mutating.
- Translate errors to "one-sentence cause + one-command fix".
- Don't dump long command lists when the user asked you to do the work — execute and report.
