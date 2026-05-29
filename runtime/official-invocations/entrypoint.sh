#!/usr/bin/env bash
set -euo pipefail

NODE_BACKEND_PORT="${NODE_BACKEND_PORT:-18080}"
NODE_BACKEND_HOST="${NODE_BACKEND_HOST:-127.0.0.1}"
export PI_FOUNDRY_BACKEND_URL="${PI_FOUNDRY_BACKEND_URL:-http://${NODE_BACKEND_HOST}:${NODE_BACKEND_PORT}}"

node_pid=""
python_pid=""

cleanup() {
  if [[ -n "${python_pid}" ]]; then kill "${python_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${node_pid}" ]]; then kill "${node_pid}" >/dev/null 2>&1 || true; fi
  wait "${python_pid}" >/dev/null 2>&1 || true
  wait "${node_pid}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "Starting Node pi-foundry backend on ${NODE_BACKEND_HOST}:${NODE_BACKEND_PORT}"
PORT="${NODE_BACKEND_PORT}" HOST="${NODE_BACKEND_HOST}" node /app/src/backend.mjs &
node_pid="$!"

# Wait for the backend before exposing the official host.
for _ in $(seq 1 60); do
  if curl -fsS "http://${NODE_BACKEND_HOST}:${NODE_BACKEND_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${node_pid}" >/dev/null 2>&1; then
    echo "Node backend exited before becoming healthy" >&2
    wait "${node_pid}"
  fi
  sleep 1
done

if ! curl -fsS "http://${NODE_BACKEND_HOST}:${NODE_BACKEND_PORT}/health" >/dev/null 2>&1; then
  echo "Node backend did not become healthy" >&2
  exit 1
fi

echo "Starting official Invocations wrapper on public port ${PORT:-8088}"
echo "Proxy backend: ${PI_FOUNDRY_BACKEND_URL}"
/opt/official-invocations-wrapper/.venv/bin/python /app/runtime/official-invocations/main.py &
python_pid="$!"

wait -n "${node_pid}" "${python_pid}"
exit_code="$?"
if ! kill -0 "${node_pid}" >/dev/null 2>&1; then
  echo "Node backend exited" >&2
fi
if ! kill -0 "${python_pid}" >/dev/null 2>&1; then
  echo "Official Invocations wrapper exited" >&2
fi
exit "${exit_code}"
