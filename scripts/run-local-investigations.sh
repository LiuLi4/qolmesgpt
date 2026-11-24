#!/usr/bin/env bash
# Run the bounded, read-only investigation service and worker for local development.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?Set DATABASE_URL before starting investigations}"
export QOLMESGPT_WORKSPACE_ROOT="${QOLMESGPT_WORKSPACE_ROOT:-$PWD/apps/web/.qolmesgpt-workspaces}"
server_pid=""
worker_pid=""
config_directory=""
cleanup() {
  if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; wait "$worker_pid" 2>/dev/null || true; fi
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$config_directory" ]]; then rm -rf -- "$config_directory"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -z "${HOLMESGPT_URL:-}" ]]; then
  # Optional trusted local shell file. Never copy it into the repository.
  model_env_file="${QOLMESGPT_MODEL_ENV_FILE:-$HOME/.config/qolmesgpt/holmes-investigation/yuanxi.env}"
  if [[ -f "$model_env_file" ]]; then
    set -a
    source "$model_env_file"
    set +a
  elif [[ -n "${QOLMESGPT_MODEL_ENV_FILE:-}" ]]; then
    echo "QOLMESGPT_MODEL_ENV_FILE does not exist" >&2
    exit 1
  fi
  source scripts/investigation-model.sh
  resolve_investigation_model
  if [[ -n "${YUANXI_API_KEY:-}" ]]; then
    node scripts/check-investigation-model.mjs
  fi
  python_bin="${HOLMES_PYTHON:-$PWD/.venv/bin/python}"
  config_directory="$(mktemp -d "${TMPDIR:-/tmp}/qolmesgpt-holmes.XXXXXXXX")"
  export HOLMES_CONFIGPATH_DIR="$config_directory"
  # An inherited registry must not silently select a different provider/model.
  export MODEL_LIST_FILE_LOCATION="$config_directory/model_list.yaml"
  export HOLMESGPT_API_KEY="${HOLMESGPT_API_KEY:-$("$python_bin" -c 'import secrets; print(secrets.token_urlsafe(32))')}"
  export HOLMES_API_KEY="$HOLMESGPT_API_KEY"
  export HOLMESGPT_URL="http://127.0.0.1:${QOLMESGPT_HOLMES_PORT:-5051}"
  export LOG_LEVEL=WARNING ENABLE_TELEMETRY=false SENTRY_DSN="" ENABLE_CONVERSATION_WORKER=false
  "$python_bin" - <<'PY'
import os
from pathlib import Path
import yaml
from holmes.plugins.toolsets import load_builtin_toolsets
config = {
    "model": os.environ["MODEL"], "api_key": os.environ["API_KEY"],
    "max_steps": 5,
    # All evidence is supplied by the TypeScript collector; tools cannot leave its scope.
    "toolsets": {tool.name: {"enabled": False} for tool in load_builtin_toolsets()},
}
if os.environ.get("API_BASE"):
    config["api_base"] = os.environ["API_BASE"]
path = Path(os.environ["HOLMES_CONFIGPATH_DIR"]) / "config.yaml"
path.touch(mode=0o600)
path.write_text(yaml.safe_dump(config))
PY
  "$python_bin" -m uvicorn server:app --host 127.0.0.1 --port "${QOLMESGPT_HOLMES_PORT:-5051}" --log-level warning &
  server_pid=$!
  ready=false
  for _ in {1..30}; do
    if curl --silent --fail "$HOLMESGPT_URL/healthz" >/dev/null; then ready=true; break; fi
    if ! kill -0 "$server_pid" 2>/dev/null; then echo "HolmesGPT server failed to start" >&2; exit 1; fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then echo "HolmesGPT startup timed out" >&2; exit 1; fi
fi
# Do not print configuration or credentials. HolmesGPT logs are restricted to warnings.
echo "Investigation worker connecting to $HOLMESGPT_URL"
cd apps/workers
node dist/investigation/main.js &
worker_pid=$!
wait "$worker_pid"
