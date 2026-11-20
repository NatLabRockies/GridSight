#!/usr/bin/env bash
# GridSight development launcher
#
# Usage:
#   ./dev.sh          — run everything locally (requires bun, uv)
#   ./dev.sh docker   — run via Docker Compose (requires docker)
#   ./dev.sh clean    — kill any leftover processes on dev ports
#
# Local mode:
#   - Python backend on :5001 (with --reload)
#   - Bun auth/proxy on :3001
#   - Vite dev server on :5173  ← open this in your browser
#
# Docker mode:
#   Same architecture but containerised. Source is bind-mounted for HMR.

set -euo pipefail
cd "$(dirname "$0")"

# Load .env, the same file docker-compose reads (`env_file: required: false`).
# Without this, credentials reach the server only when dev.sh happens to be
# started from an interactive shell whose rc file exports them — start it from
# a script, an editor, or a non-zsh shell and every provider key silently
# disappears, leaving the app on Ollama with no error to explain why.
#
# Anything already in the environment wins, so `FOO=bar ./dev.sh` and a real
# shell export both still beat the file: a stale .env shadowing live exports
# would be the same silent-config bug in the other direction.
load_dotenv() {
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"   # strip leading whitespace
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    key="${line%%=*}"
    [ "$key" = "$line" ] && continue          # no '=' → not an assignment
    val="${line#*=}"
    case "$val" in                            # strip one layer of quotes
      \"*\") val="${val%\"}"; val="${val#\"}" ;;
      \'*\') val="${val%\'}"; val="${val#\'}" ;;
    esac
    [ -z "${!key:-}" ] && export "$key=$val"
  done < .env
}
if [ -f .env ]; then
  echo "  → Loading .env"
  load_dotenv
fi

MODE="${1:-local}"

PIDS=()

kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  Killing leftover processes on :${port} (PIDs: ${pids//$'\n'/ })"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 0.5
  fi
}

cleanup() {
  echo ""
  echo "Shutting down…"
  if [ ${#PIDS[@]} -gt 0 ]; then
    for pid in "${PIDS[@]}"; do
      kill -TERM "$pid" 2>/dev/null || true
    done
    sleep 1
    for pid in "${PIDS[@]}"; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
  # Clean up any stragglers on our ports
  kill_port 5001
  kill_port 3001
  kill_port 5173
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

if [ "$MODE" = "clean" ]; then
  echo "Cleaning up dev ports…"
  kill_port 5001
  kill_port 3001
  kill_port 5173
  echo "Done."
  exit 0
fi

if [ "$MODE" = "docker" ]; then
  echo "Starting GridSight (Docker dev mode)…"
  echo "  → Vite dev server: http://localhost:5173"
  echo "  → Bun proxy:       http://localhost:3001"
  echo "  → Python backend:  http://localhost:5001 (internal)"
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
  exit 0
fi

# ── Local mode ──────────────────────────────────────────────────────────────

echo "Starting GridSight (local dev mode)…"

# Kill any leftover processes from a previous run
kill_port 5001
kill_port 3001
kill_port 5173

# 1. Python backend
echo "  → Python backend:  http://localhost:5001"

# Sync core deps + first-party extensions (gridsight-sdk, gridsight-seds).
# External extensions (GAT, DemandTldr) live in sibling repos and are NOT in
# the lockfile, so we install them separately after syncing. This keeps them
# from being uninstalled by subsequent `uv sync` calls.
(cd server && uv sync --group dev)
for ext_path in "../GAT" "../GAT/gridsight-ext" "../DemandTldr/gridsight-ext"; do
  abs="$(cd "$(dirname "$0")" && realpath "$ext_path" 2>/dev/null || true)"
  if [ -d "$abs" ]; then
    echo "  → Installing external extension: $ext_path"
    (cd server && uv pip install --quiet -e "$abs")
  fi
done

# Write backend descriptor so the MCP server subprocess can discover the
# port and API key without the Tauri app. Mirrors what sidecar.rs writes.
_DEV_API_KEY="${API_KEY:-dev-api-key}"
cat > "$(dirname "$0")/desktop/.dev-backend.json" <<EOF
{
  "port": 5001,
  "apiKey": "${_DEV_API_KEY}"
}
EOF

(cd server && API_KEY="${_DEV_API_KEY}" \
  DATA_DIR="${DATA_DIR:-../data}" \
  DB_PATH="${DB_PATH:-../data/gridsight.db}" \
  LLM_MODEL="${LLM_MODEL:-gpt-oss:20B}" \
  OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}" \
  LOG_LEVEL="${LOG_LEVEL:-info}" \
  GRIDSIGHT_DESKTOP=1 \
  uv run --no-sync uvicorn app:app --host 127.0.0.1 --port 5001 --reload) &
PIDS+=($!)

# 2. Bun auth/proxy server
echo "  → Bun proxy:       http://localhost:3001"
(cd web && BACKEND_URL=http://127.0.0.1:5001 \
  API_KEY="${API_KEY:-dev-api-key}" \
  ADMIN_USER="${ADMIN_USER:-admin}" \
  ADMIN_PASS="${ADMIN_PASS:-changeme}" \
  SESSION_SECRET="${SESSION_SECRET:-dev-secret-change-me}" \
  bun run server/index.js) &
PIDS+=($!)

# 3. Vite dev server (HMR)
echo "  → Vite dev server: http://localhost:5173  ← open this"
(cd web && VITE_LOG_LEVEL="${VITE_LOG_LEVEL:-debug}" bunx vite --host 127.0.0.1 --port 5173) &
PIDS+=($!)

wait
