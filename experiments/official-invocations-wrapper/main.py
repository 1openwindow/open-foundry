"""Experimental official Invocations wrapper for pi-foundry.

This process uses the official azure-ai-agentserver-invocations host for the
outer /invocations protocol and proxies requests to the existing Node pi-foundry
runtime. It is intentionally experimental: the goal is to evaluate whether the
official protocol-host layer can replace our hand-written HTTP edge without
rewriting the Pi RPC adapter, artifact manager, and BYO Pi workflow.

Run locally with a Node backend in another shell:

    PORT=18080 PI_MOCK=1 npm start

Then run this wrapper:

    PI_FOUNDRY_BACKEND_URL=http://127.0.0.1:18080 uv run \
      --with-requirements experiments/official-invocations-wrapper/requirements.txt \
      experiments/official-invocations-wrapper/main.py

Invoke the wrapper:

    curl -sS -N 'http://127.0.0.1:8088/invocations?agent_session_id=exp-001' \
      -H 'content-type: application/json' \
      -H 'accept: text/event-stream' \
      -d '{"message":"Say exactly: ok"}'
"""

import logging
import os
from urllib.parse import urlencode

import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

from azure.ai.agentserver.invocations import InvocationAgentServerHost

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("pi_foundry_official_invocations_wrapper")

BACKEND_URL = os.environ.get("PI_FOUNDRY_BACKEND_URL", "http://127.0.0.1:18080").rstrip("/")
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("PI_FOUNDRY_PROXY_TIMEOUT_SECONDS", "600"))

app = InvocationAgentServerHost()


def _state_value(request: Request, name: str):
    return getattr(request.state, name, None)


@app.invoke_handler
async def handle_invoke(request: Request):
    """Proxy official Invocations requests to the Node pi-foundry runtime."""
    session_id = _state_value(request, "session_id") or request.query_params.get("agent_session_id")
    invocation_id = _state_value(request, "invocation_id")
    body = await request.body()

    accept = request.headers.get("accept", "")
    wants_stream = "text/event-stream" in accept or request.query_params.get("stream") == "true"

    logger.info(
        "proxy invocation=%s session=%s stream=%s backend=%s",
        invocation_id,
        session_id,
        wants_stream,
        BACKEND_URL,
    )

    query = {}
    if wants_stream:
        query["stream"] = "true"
    if session_id:
        query["agent_session_id"] = session_id
    backend_url = f"{BACKEND_URL}/invocations"
    if query:
        backend_url = f"{backend_url}?{urlencode(query)}"

    timeout = httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=30.0)

    if not wants_stream:
        headers = {
            "content-type": request.headers.get("content-type", "application/json"),
            "accept": "application/json",
        }
        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                upstream = await client.post(backend_url, content=body, headers=headers)
            except Exception as error:  # noqa: BLE001 - surface startup/proxy errors as JSON
                logger.exception("failed to connect to backend")
                return JSONResponse(
                    status_code=502,
                    content={"error": "backend_unavailable", "message": str(error)},
                )

        content_type = upstream.headers.get("content-type", "application/json")
        if "application/json" in content_type:
            try:
                return JSONResponse(status_code=upstream.status_code, content=upstream.json())
            except ValueError:
                pass
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=content_type.split(";", 1)[0],
        )

    headers = {
        "content-type": request.headers.get("content-type", "application/json"),
        "accept": "text/event-stream",
    }
    client = httpx.AsyncClient(timeout=timeout)

    try:
        upstream_cm = client.stream("POST", backend_url, content=body, headers=headers)
        upstream = await upstream_cm.__aenter__()
    except Exception as error:  # noqa: BLE001 - surface startup/proxy errors as JSON
        await client.aclose()
        logger.exception("failed to connect to backend")
        return JSONResponse(
            status_code=502,
            content={"error": "backend_unavailable", "message": str(error)},
        )

    if upstream.status_code >= 400:
        text = await upstream.aread()
        await upstream_cm.__aexit__(None, None, None)
        await client.aclose()
        return JSONResponse(
            status_code=upstream.status_code,
            content={"error": "backend_error", "message": text.decode("utf-8", errors="replace")},
        )

    async def event_generator():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream_cm.__aexit__(None, None, None)
            await client.aclose()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )


if __name__ == "__main__":
    app.run()
