#!/usr/bin/env bash
# Quorum — unified start script
#
# Usage:
#   ./scripts/start.sh              # Supabase backend + frontend (default)
#   ./scripts/start.sh --local      # SQLite + MockLLM (no keys needed)
#   ./scripts/start.sh api          # Backend only (Supabase)
#   ./scripts/start.sh web          # Frontend only
#   ./scripts/start.sh --local api  # Backend only (SQLite)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- Parse flags ---
MODE="supabase"
COMPONENT="all"

for arg in "$@"; do
  case "$arg" in
    --local)  MODE="local" ;;
    api|web|all) COMPONENT="$arg" ;;
  esac
done

# --- Load env files ---
# Backend env: apps/api/.env or root .env
for f in "$ROOT/apps/api/.env" "$ROOT/.env"; do
  if [ -f "$f" ]; then
    set -a; source "$f"; set +a
    break
  fi
done

# Frontend env is loaded by Next.js from apps/web/.env.local automatically

# Always route frontend through the API backend
export NEXT_PUBLIC_API_URL=http://localhost:8000

if [ "$MODE" = "local" ]; then
  export QUORUM_LOCAL=true
  export QUORUM_TEST_MODE=true
  export QUORUM_LLM_PROVIDER=mock
  export QUORUM_DB_PATH="${ROOT}/apps/api/quorum_local.db"
fi

# --- Dependency check ---
ensure_deps() {
  if ! python3 -c "import fastapi" 2>/dev/null; then
    echo "Installing Python deps..."
    pip3 install -r "$ROOT/apps/api/requirements.txt" -q
  fi
  if ! python3 -c "import quorum_llm" 2>/dev/null; then
    echo "Installing quorum_llm..."
    pip3 install -e "$ROOT/packages/llm" -q
  fi
}

# --- Start functions ---
start_api() {
  ensure_deps
  cd "$ROOT/apps/api"
  if [ "$MODE" = "local" ]; then
    echo "=== API (SQLite + MockLLM) ==="
    echo "  DB:  $QUORUM_DB_PATH"
    echo "  LLM: mock"
  else
    echo "=== API (Supabase) ==="
    echo "  DB:  ${SUPABASE_URL:-NOT SET — check .env}"
  fi
  echo "  URL: http://localhost:8000"
  echo "  Docs: http://localhost:8000/docs"
  echo ""
  uvicorn main:app --reload --host 0.0.0.0 --port 8000
}

start_web() {
  cd "$ROOT"
  if ! [ -d node_modules ]; then
    pnpm install
  fi
  echo "=== Frontend ==="
  echo "  URL: http://localhost:3000"
  echo ""
  pnpm --filter web dev
}

# --- Run ---

# Build the flags string so spawned terminals inherit the mode
FLAGS=""
[ "$MODE" = "local" ] && FLAGS="--local"

case "$COMPONENT" in
  api) start_api ;;
  web) start_web ;;
  all)
    # On macOS, open two Terminal tabs so logs don't interleave
    if [ "$(uname)" = "Darwin" ] && [ -z "${QUORUM_CHILD:-}" ]; then
      echo "Opening two Terminal tabs..."
      export QUORUM_CHILD=1
      osascript -e "
        tell application \"Terminal\"
          activate
          do script \"cd '$ROOT' && '$ROOT/scripts/start.sh' $FLAGS api\"
          delay 0.5
          do script \"cd '$ROOT' && sleep 3 && '$ROOT/scripts/start.sh' $FLAGS web\"
        end tell
      " 2>/dev/null && exit 0
    fi
    # Fallback: run both in this terminal
    start_api &
    API_PID=$!
    sleep 3
    start_web &
    WEB_PID=$!
    trap "kill $API_PID $WEB_PID 2>/dev/null" EXIT
    wait
    ;;
esac
