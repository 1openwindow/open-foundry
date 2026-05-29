# Experimental official Invocations wrapper

This experiment evaluates **choice C: hybrid mode**:

```text
Foundry /invocations
  -> official azure-ai-agentserver-invocations Python host
  -> proxy to existing Node pi-foundry runtime
  -> Pi RPC adapter / artifact manager / BYO Pi workflow
```

The goal is to test whether the official protocol-host layer can replace the
hand-written Node HTTP edge without rewriting the Pi runtime bridge.

## What this proves

- The official `InvocationAgentServerHost` can own the outer `/invocations` endpoint.
- The existing Node runtime can remain the Pi/task backend.
- SSE `token` / `done` events can be proxied unchanged.

## What this does not prove yet

- Production Docker shape.
- Hosted deployment with two processes.
- Long-running polling/cancel handlers.
- Telemetry parity.
- Artifact publishing in hosted mode.

## Run locally

From the repo root, start the existing Node backend on an internal port:

```bash
PORT=18080 PI_MOCK=1 npm start
```

In another shell, run the official wrapper:

```bash
PI_FOUNDRY_BACKEND_URL=http://127.0.0.1:18080 \
uv run --with-requirements experiments/official-invocations-wrapper/requirements.txt \
  experiments/official-invocations-wrapper/main.py
```

Invoke the official wrapper:

```bash
curl --noproxy '*' -sS -N \
  'http://127.0.0.1:8088/invocations?agent_session_id=exp-001' \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"message":"Say exactly: ok"}'
```

Expected SSE:

```text
data: {"type":"token","content":"mock response: Say exactly: ok"}

data: {"type":"done", ...}
```

## One-command local smoke

From the repo root:

```bash
experiments/official-invocations-wrapper/smoke-local.sh
```

This starts the Node backend in mock mode, starts the official wrapper, calls
`/readiness`, then invokes `/invocations` through the official wrapper.

## Experimental Docker image

The experiment includes a standalone Dockerfile that starts both processes:

1. Node pi-foundry backend on `127.0.0.1:18080`.
2. Python official invocations host on public port `8088`.

Build from the repo root:

```bash
docker build \
  -f experiments/official-invocations-wrapper/Dockerfile \
  -t pi-foundry-official-invocations:local \
  .
```

Run in mock mode:

```bash
docker run --rm -p 8088:8088 \
  -e PI_MOCK=1 \
  pi-foundry-official-invocations:local
```

Invoke:

```bash
curl --noproxy '*' -sS -N \
  'http://127.0.0.1:8088/invocations?agent_session_id=docker-exp-001' \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"message":"Say exactly: ok"}'
```

## Next decisions

If the Docker image works locally and in Foundry, we can decide whether the
extra Python host is worth it compared with the current direct Node
implementation.
