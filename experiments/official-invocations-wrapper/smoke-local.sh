#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_PORT="${NODE_PORT:-18080}"
WRAPPER_PORT="${WRAPPER_PORT:-8088}"
SESSION_ID="${SESSION_ID:-official-exp-001}"

node_pid=""
wrapper_pid=""
cleanup() {
  if [[ -n "${wrapper_pid}" ]]; then kill "${wrapper_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${node_pid}" ]]; then kill "${node_pid}" >/dev/null 2>&1 || true; fi
  wait "${wrapper_pid}" >/dev/null 2>&1 || true
  wait "${node_pid}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cd "${ROOT_DIR}"
PORT="${NODE_PORT}" PI_MOCK=1 npm start >/tmp/pi-foundry-official-wrapper-node.log 2>&1 &
node_pid="$!"

PI_FOUNDRY_BACKEND_URL="http://127.0.0.1:${NODE_PORT}" \
uv run --with-requirements experiments/official-invocations-wrapper/requirements.txt \
  experiments/official-invocations-wrapper/main.py >/tmp/pi-foundry-official-wrapper-python.log 2>&1 &
wrapper_pid="$!"

for _ in $(seq 1 60); do
  if curl --noproxy '*' -fsS "http://127.0.0.1:${NODE_PORT}/health" >/dev/null 2>&1 \
    && curl --noproxy '*' -fsS "http://127.0.0.1:${WRAPPER_PORT}/readiness" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "--- wrapper readiness ---"
curl --noproxy '*' -sS "http://127.0.0.1:${WRAPPER_PORT}/readiness"
echo

echo "--- invocation json ---"
curl --noproxy '*' -sS \
  "http://127.0.0.1:${WRAPPER_PORT}/invocations?agent_session_id=${SESSION_ID}-json" \
  -H 'content-type: application/json' \
  -d '{"message":"Say exactly: ok"}'
echo

echo "--- invocation stream ---"
curl --noproxy '*' -sS -N \
  "http://127.0.0.1:${WRAPPER_PORT}/invocations?agent_session_id=${SESSION_ID}-stream&stream=true" \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"message":"Say exactly: ok"}'
echo
