#!/usr/bin/env bash
set -euo pipefail

docker build \
  -f examples/demo-agent/Dockerfile \
  --pull=false \
  --network=host \
  --build-arg HTTP_PROXY="${HTTP_PROXY:-${http_proxy:-}}" \
  --build-arg HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-}}" \
  --build-arg NO_PROXY="${NO_PROXY:-${no_proxy:-}}" \
  -t "${IMAGE_TAG:-pi-foundry-demo:local}" \
  .
