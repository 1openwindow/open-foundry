# Paseo integration

This document describes how to use the deployed `pi-foundry` Microsoft Foundry Hosted Agent from a local Paseo daemon.

## Architecture

Paseo normally talks to its built-in Pi provider by spawning a local `pi --mode rpc` process. The adapter in this repository exposes a Pi-RPC-compatible stdio process and forwards prompts to the remote Foundry Invocations endpoint.

```text
Paseo client / phone
  -> local Paseo daemon
  -> integrations/paseo/foundry-pi-rpc-shim.mjs
  -> Microsoft Foundry Hosted Agent /invocations
  -> pi-foundry container
  -> pi --mode rpc
```

The shim runs locally on the same machine as the Paseo daemon. It is not deployed into the Foundry container.

## Prerequisites

- `azd` installed and authenticated locally:

  ```bash
  azd auth login
  ```

- `pi-foundry` deployed and verified:

  ```bash
  cd /home/zihch/repos/pi-foundry
  azd ai agent invoke pi-foundry \
    --protocol invocations \
    --version 3 \
    --new-session \
    --timeout 600 \
    'Say exactly: ok'
  ```

- Local Paseo daemon installed and running.

## Configure Paseo

Edit `~/.paseo/config.json` and add a provider entry under `agents.providers`:

```json
{
  "agents": {
    "providers": {
      "foundry-pi": {
        "extends": "pi",
        "label": "Foundry Pi",
        "description": "Remote pi-foundry Hosted Agent via Microsoft Foundry Invocations",
        "command": [
          "node",
          "/home/zihch/repos/pi-foundry/integrations/paseo/foundry-pi-rpc-shim.mjs"
        ],
        "env": {
          "FOUNDRY_INVOCATIONS_ENDPOINT": "https://zihch-eus2.services.ai.azure.com/api/projects/zihch-eus2/agents/pi-foundry/endpoint/protocols/invocations?api-version=2025-11-15-preview",
          "FOUNDRY_TENANT_ID": "72f988bf-86f1-41af-91ab-2d7cd011db47",
          "FOUNDRY_TOKEN_COMMAND_CWD": "/home/zihch/repos/pi-foundry",
          "FOUNDRY_MODEL": "gpt-5.4-mini",
          "FOUNDRY_MODEL_LABEL": "Foundry gpt-5.4-mini"
        },
        "models": [
          {
            "id": "gpt-5.4-mini",
            "label": "Foundry gpt-5.4-mini",
            "isDefault": true
          }
        ]
      }
    }
  }
}
```

Then restart the local Paseo daemon:

```bash
paseo restart
paseo status
```

Expected provider status includes:

```text
foundry-pi      available
```

## Smoke test

```bash
paseo run --provider foundry-pi --model gpt-5.4-mini 'Say exactly: ok'
```

Expected logs:

```text
[User] Say exactly: ok
ok
```

## Phone access

The phone app connects to the local Paseo daemon, not directly to Foundry. Keep the local daemon running, pair the phone with Paseo as usual, then select:

```text
Provider: Foundry Pi
Model: Foundry gpt-5.4-mini
```

## Adapter environment variables

| Variable | Purpose |
|---|---|
| `FOUNDRY_INVOCATIONS_ENDPOINT` | Foundry Hosted Agent invocations endpoint |
| `FOUNDRY_TENANT_ID` | Azure tenant used by `azd auth token` |
| `FOUNDRY_TOKEN_COMMAND_CWD` | Directory where `azd auth token` should run; usually the `pi-foundry` repo |
| `FOUNDRY_TOKEN_SCOPE` | Optional token scope, defaults to `https://ai.azure.com/.default` |
| `FOUNDRY_BEARER_TOKEN` | Optional precomputed bearer token; bypasses `azd auth token` |
| `FOUNDRY_MODEL` | Model id exposed to Paseo |
| `FOUNDRY_MODEL_LABEL` | Human-readable model label |
| `FOUNDRY_AGENT_SESSION_ID` | Optional fixed Foundry session id; by default one is generated per spawned shim process |

## Limitations

This is a lightweight compatibility adapter, not a native Paseo Foundry provider.

Current limitations:

- Supports regular chat and streaming assistant text.
- Uses Foundry `agent_session_id` for remote session continuity.
- Does not implement Pi tree rewind against the remote hosted agent.
- Does not map remote tool calls into rich Paseo tool-call UI.
- Requires the local machine running the Paseo daemon to have a valid `azd auth login` session.

A longer-term production design would be either:

1. a native Paseo `foundry` provider that speaks Foundry Invocations directly, or
2. a generic ACP bridge for Foundry Hosted Agents.
