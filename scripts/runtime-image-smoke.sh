#!/usr/bin/env bash
set -euo pipefail

IMAGE_TAG="${PI_FOUNDRY_RUNTIME_IMAGE:-pi-foundry-runtime:local}"
HOST_PORT="${HOST_PORT:-8125}"
CONTAINER_NAME="pi-foundry-runtime-smoke-${HOST_PORT}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="${WORKSPACE:-${ROOT_DIR}/examples/demo-agent/demo-workspace}"

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup

echo "Starting runtime image smoke test"
echo "Image:     ${IMAGE_TAG}"
echo "Workspace: ${WORKSPACE}"
echo "Port:      ${HOST_PORT}"

docker run -d \
  --name "${CONTAINER_NAME}" \
  -p "${HOST_PORT}:8088" \
  -e PI_MOCK=1 \
  -v "${WORKSPACE}:/workspace" \
  "${IMAGE_TAG}" >/dev/null

for _ in $(seq 1 60); do
  if curl --noproxy '*' -fsS "http://127.0.0.1:${HOST_PORT}/readiness" >/dev/null; then
    break
  fi
  sleep 1
done

echo "--- readiness ---"
curl --noproxy '*' -fsS "http://127.0.0.1:${HOST_PORT}/readiness"
echo

echo "--- invocation ---"
curl --noproxy '*' -fsS "http://127.0.0.1:${HOST_PORT}/invocations" \
  -H 'content-type: application/json' \
  -d '{"message":"Say exactly: ok"}'
echo

echo "Runtime image smoke test passed"
