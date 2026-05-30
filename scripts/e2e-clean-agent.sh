#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/e2e-clean-agent.sh [options]

Runs the pi-foundry clean-agent UX smoke in a temporary copy of a clean Pi agent repo.
Default mode is local-only: install adapter, render, and validate generated agent YAML under .azd/pi-foundry/generated without deploying.

Options:
  --source <path>        Clean Pi agent fixture. Default: ~/repos/clean-pi-agent
  --skill <path>         pi-foundry skill directory. Default: <repo>/.agents/skills/pi-foundry
  --agent-name <name>    Agent/environment name. Default: clean-pi-agent
  --remote               Run real azd up + remote invoke + artifact validation.
  --env-file <path>      Dotenv file used to configure azd env in --remote mode.
                         Secrets are set into azd env but never printed.
  --keep                 Keep the temporary adapted repo and print its path.
  -h, --help             Show this help.

Examples:
  scripts/e2e-clean-agent.sh
  scripts/e2e-clean-agent.sh --remote --env-file ~/repos/pi-foundry/.azure/pi-foundry-local/.env
EOF
}

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source_repo="$HOME/repos/clean-pi-agent"
skill_dir="$repo_root/.agents/skills/pi-foundry"
agent_name="clean-pi-agent"
remote=0
keep=0
env_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) source_repo=${2:?missing value for --source}; shift 2 ;;
    --skill) skill_dir=${2:?missing value for --skill}; shift 2 ;;
    --agent-name) agent_name=${2:?missing value for --agent-name}; shift 2 ;;
    --remote) remote=1; shift ;;
    --env-file) env_file=${2:?missing value for --env-file}; shift 2 ;;
    --keep) keep=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unexpected argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! -d "$source_repo" ]]; then
  echo "source repo not found: $source_repo" >&2
  exit 1
fi
if [[ ! -f "$skill_dir/scripts/install-adapter.mjs" ]]; then
  echo "pi-foundry skill not found: $skill_dir" >&2
  exit 1
fi
if [[ $remote -eq 1 && -z "$env_file" ]]; then
  echo "--remote requires --env-file <path>" >&2
  exit 1
fi
if [[ -n "$env_file" && ! -f "$env_file" ]]; then
  echo "env file not found: $env_file" >&2
  exit 1
fi

work_parent=$(mktemp -d /tmp/pi-foundry-clean-e2e.XXXXXX)
work_dir="$work_parent/clean-pi-agent"
cleanup() {
  if [[ $keep -eq 1 ]]; then
    echo "Kept temporary repo: $work_dir"
  else
    rm -rf "$work_parent"
  fi
}
trap cleanup EXIT

cp -a "$source_repo/." "$work_dir"
cd "$work_dir"

echo "== Inspect clean repo =="
node "$skill_dir/scripts/inspect-repo.mjs"

echo "== Install adapter =="
node "$skill_dir/scripts/install-adapter.mjs" --environment "$agent_name" --agent-name "$agent_name"

echo "== Validate generated adapter files =="
test ! -e agent.yaml
test ! -e agent.manifest.yaml
test -f .azd/pi-foundry/generated/agent.yaml
test -f .azd/pi-foundry/generated/agent.manifest.yaml
test -f .azd/pi-foundry/azd-agent.mjs
node .azd/pi-foundry/render.mjs --check

if [[ $remote -eq 0 ]]; then
  echo "Local-only E2E passed: adapter install, generated agent YAML, and render check are valid."
  exit 0
fi

echo "== Configure azd env from env file (secrets redacted) =="
python3 - "$env_file" "$agent_name" <<'PY'
from pathlib import Path
import re
import subprocess
import sys

env_file = Path(sys.argv[1])
agent_name = sys.argv[2]
values = {}
for raw in env_file.read_text(errors="replace").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    values[key] = value

keys = [
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_TENANT_ID",
    "AZURE_LOCATION",
    "FOUNDRY_PROJECT_ENDPOINT",
    "AZURE_AI_PROJECT_ID",
    "AZURE_CONTAINER_REGISTRY_ENDPOINT",
    "PI_MOCK",
    "PI_ARGS",
    "PI_OPENAI_BASE_URL",
    "PI_OPENAI_MODEL",
    "PI_OPENAI_API_KEY",
    "REQUEST_TIMEOUT_MS",
    "ENABLE_DIAGNOSTICS",
    "ARTIFACT_PUBLISH_MODE",
    "ARTIFACT_STORAGE_ACCOUNT",
    "ARTIFACT_STATIC_WEB_ENDPOINT",
    "ARTIFACT_STATIC_WEB_CONTAINER",
]

def set_env(key, value):
    subprocess.run(["azd", "env", "set", f"{key}={value}"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    if re.search(r"(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)", key, re.I):
        print(f"configured {key}=<redacted>")
    else:
        print(f"configured {key}")

for key in keys:
    if key not in values or values[key] == "":
        continue
    value = values[key]
    if key == "ARTIFACT_STATIC_WEB_CONTAINER":
        value = "$web"
    set_env(key, value)

set_env("ARTIFACT_BLOB_PREFIX", agent_name)
PY

echo "== Doctor =="
node .azd/pi-foundry/doctor.mjs

echo "== Deploy =="
azd up --no-prompt
# azd-agent.mjs may temporarily materialize root agent files during deploy for
# current azd extension compatibility, but it should clean them up afterward.
test ! -e agent.yaml
test ! -e agent.manifest.yaml

echo "== Show deployed agent =="
azd ai agent show "$agent_name"
version=$(azd ai agent show "$agent_name" | awk '/^Version[[:space:]]/{print $2; exit}')
if [[ -z "$version" ]]; then
  echo "could not resolve deployed agent version" >&2
  exit 1
fi

echo "== Invoke remote agent =="
azd ai agent invoke "$agent_name" \
  --protocol invocations \
  --version "$version" \
  --new-session \
  --timeout 900 \
  'Say exactly: ok' | tee invoke-ok.out

grep -q '"output": "ok"' invoke-ok.out
grep -q '"mock": false' invoke-ok.out

echo "== Artifact remote validation =="
azd ai agent invoke "$agent_name" \
  --protocol invocations \
  --version "$version" \
  --new-session \
  --timeout 900 \
  "Create a tiny downloadable static HTML artifact named index.html titled 'Clean Pi Agent on Foundry'. Save it under the artifact directory you were instructed to use. Write artifact-manifest.json listing index.html. Reply concisely with artifact links." | tee invoke-artifact.out

url=$(grep -Eo 'https://[^" )]+' invoke-artifact.out | grep '/index.html' | head -1 || true)
if [[ -z "$url" ]]; then
  echo "artifact index.html URL not found in invocation output" >&2
  exit 1
fi

echo "== Curl artifact URL =="
curl --noproxy '*' -fsSI "$url" | tee artifact-head.out
grep -q '^HTTP/.* 200' artifact-head.out

echo "Remote E2E passed for $agent_name version $version"
echo "Artifact URL: $url"
