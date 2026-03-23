#!/usr/bin/env bash
set -euo pipefail
# Copies NEXT_PUBLIC_ vars from root .env into apps/web/.env.local
# Run once after cloning or when root .env changes.
# See apps/web/.env.local.example for the full variable reference.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$ROOT/.env" ]; then
  echo "Error: $ROOT/.env not found. Create it first (see apps/web/.env.local.example)." >&2
  exit 1
fi

set -a && source "$ROOT/.env" && set +a
cat > "$ROOT/apps/web/.env.local" << ENV
NEXT_PUBLIC_SUPABASE_URL=$SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
NEXT_PUBLIC_QUORUM_TEST_MODE=${QUORUM_TEST_MODE:-false}
NEXT_PUBLIC_API_URL=${API_URL:-http://127.0.0.1:9000}
NEXT_PUBLIC_AVATAR_MOCK=${AVATAR_MOCK:-false}
NEXT_PUBLIC_AVATAR_PROVIDER=${AVATAR_PROVIDER:-}
NEXT_PUBLIC_ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY:-}
NEXT_PUBLIC_ELEVENLABS_AGENT_ID=${ELEVENLABS_AGENT_ID:-}
NEXT_PUBLIC_SIMLI_API_KEY=${SIMLI_API_KEY:-}
ENV
echo "Wrote apps/web/.env.local ($(grep -c '=' "$ROOT/apps/web/.env.local") vars)"
