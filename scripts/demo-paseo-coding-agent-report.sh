#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROMPT_FILE="${1:-$ROOT/examples/demo-agent/demo-workspace/prompts/coding-agent-report.zh.md}"
PROVIDER="${PASEO_PROVIDER:-foundry-pi}"
MODEL="${PASEO_MODEL:-gpt-5.4}"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

paseo run --provider "$PROVIDER" --model "$MODEL" "$(cat "$PROMPT_FILE")"
