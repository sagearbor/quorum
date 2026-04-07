#!/usr/bin/env bash
# Start Quorum locally with SQLite backend + Mock LLM.
# No Supabase, no API keys required.
#
# Usage:
#   ./scripts/start-local.sh          # Start both API + web
#   ./scripts/start-local.sh api      # API only
#   ./scripts/start-local.sh web      # Web only
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- Environment ---
export QUORUM_LOCAL=true
export QUORUM_TEST_MODE=true
export QUORUM_LLM_PROVIDER=mock
export QUORUM_DB_PATH="${ROOT}/apps/api/quorum_local.db"
export NEXT_PUBLIC_API_URL=http://localhost:8000
export NEXT_PUBLIC_QUORUM_TEST_MODE=false  # Use real API, not demo mode

cd "$ROOT"

component="${1:-all}"

start_api() {
  echo "Starting API server (SQLite + MockLLM)..."
  cd "$ROOT/apps/api"
  # Install dependencies if needed
  if ! python3 -c "import fastapi" 2>/dev/null; then
    pip3 install -r requirements.txt -q
  fi
  if ! python3 -c "import quorum_llm" 2>/dev/null; then
    pip3 install -e "$ROOT/packages/llm" -q
  fi
  echo "  DB: $QUORUM_DB_PATH"
  echo "  LLM: MockLLMProvider"
  echo "  API: http://localhost:8000"
  echo "  Docs: http://localhost:8000/docs"
  uvicorn main:app --reload --host 0.0.0.0 --port 8000
}

start_web() {
  echo "Starting web frontend..."
  cd "$ROOT"
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  NEXT_PUBLIC_API_URL=http://localhost:8000 pnpm --filter web dev
}

case "$component" in
  api)  start_api ;;
  web)  start_web ;;
  all)
    # Run both in parallel
    start_api &
    API_PID=$!
    sleep 2
    start_web &
    WEB_PID=$!
    trap "kill $API_PID $WEB_PID 2>/dev/null" EXIT
    wait
    ;;
  *)
    echo "Usage: $0 [api|web|all]"
    exit 1
    ;;
esac
