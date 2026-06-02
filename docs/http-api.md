# HTTP API

The `pi-foundry-runtime` image exposes the Foundry Invocations protocol on the
container port (`8088` by default). End users typically reach it via
`azd ai agent invoke` or Pi's remote mode, but the raw HTTP shape is documented
here for direct callers and debugging.

## `POST /invocations` — JSON

Request:

```json
{ "message": "List files in the current directory.", "sessionId": "optional", "cwd": "." }
```

Response:

```json
{
  "requestId": "...",
  "output": "...",
  "sessionId": "...",
  "mock": false
}
```

## `POST /invocations` — Server-Sent Events

Use `Accept: text/event-stream` (or `?stream=true`). The server streams
`data:` lines:

```json
{ "type": "token", "content": "..." }
```

terminated by exactly one:

```json
{
  "type": "done",
  "full_text": "...",
  "session_id": "...",
  "request_id": "..."
}
```

Stream contract:

- `token` events carry **model deltas only**.
- `done` carries the final `full_text` plus correlation ids.
- The server also emits SSE **keepalive comments** (lines starting with `:`) every
  `SSE_HEARTBEAT_MS` (default `20000`, set `0` to disable). They are ignored by every
  spec-compliant SSE parser and never surface as `token`/`done` events.

### Why long tasks must use SSE

Foundry's APIM gateway enforces a ~120s **idle** (no-bytes) timeout. The non-streaming
JSON path holds the connection silent for the whole task, so any task past ~120s is cut
at the gateway with `HTTP 408 {"error":{"code":"Timeout"}}` before the container's
`REQUEST_TIMEOUT_MS` applies. On the SSE path the keepalive bytes reset that idle timer
during silent phases (tool runs, uploads), so long tasks survive. `azd ai agent invoke`
cannot consume SSE; `verify.mjs` streams by default, so use it (or any SSE client) for
tasks longer than ~120s.

## `GET /invocations/docs/openapi.json`

Returns the OpenAPI spec for the routes above.

## Health & readiness

- `GET /health` — process is up
- `GET /readiness` — backend ready to accept invocations
