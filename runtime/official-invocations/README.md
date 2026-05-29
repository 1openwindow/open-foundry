# Official Invocations wrapper

This is the supported Foundry-facing runtime shape:

```text
Foundry /invocations
  -> official azure-ai-agentserver-invocations Python host
  -> proxy to existing Node pi-foundry runtime
  -> Pi RPC adapter / artifact manager / BYO Pi workflow
```

The official protocol-host layer replaces the hand-written Node HTTP edge without rewriting the Pi runtime bridge.

## What this proves

- The official `InvocationAgentServerHost` can own the outer `/invocations` endpoint.
- The existing Node runtime can remain the Pi/task backend.
- SSE `token` / `done` events can be proxied unchanged.
- Non-streaming clients can receive the backend JSON response unchanged.

## Remaining hardening areas

- Long-running polling/cancel handlers.
- Telemetry parity with the SDK host.

## Run locally

From the repo root, start the existing Node backend on an internal port:

```bash
PORT=18080 PI_MOCK=1 npm run start:backend
```

In another shell, run the official wrapper:

```bash
PI_FOUNDRY_BACKEND_URL=http://127.0.0.1:18080 \
uv run --with-requirements runtime/official-invocations/requirements.txt \
  runtime/official-invocations/main.py
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
runtime/official-invocations/smoke-local.sh
```

This starts the Node backend in mock mode, starts the official wrapper, calls
`/readiness`, then invokes `/invocations` through the official wrapper in both
non-streaming JSON mode and streaming SSE mode.

## Docker image

The default Dockerfile starts both processes:

1. Node pi-foundry backend on `127.0.0.1:18080`.
2. Python official invocations host on public port `8088`.

Build from the repo root:

```bash
docker build \
  -f Dockerfile \
  -t pi-foundry-official-invocations:local \
  .
```

Run in mock mode:

```bash
docker run --rm -p 8088:8088 \
  -e PI_MOCK=1 \
  pi-foundry-official-invocations:local
```

Invoke non-streaming JSON:

```bash
curl --noproxy '*' -sS \
  'http://127.0.0.1:8088/invocations?agent_session_id=docker-exp-json' \
  -H 'content-type: application/json' \
  -d '{"message":"Say exactly: ok"}'
```

Invoke streaming SSE:

```bash
curl --noproxy '*' -sS -N \
  'http://127.0.0.1:8088/invocations?agent_session_id=docker-exp-stream&stream=true' \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"message":"Say exactly: ok"}'
```

## Next decisions

The Docker image is now the default Foundry-facing shape: the official Python host owns the public Invocations protocol and proxies to the internal Node Pi backend.
