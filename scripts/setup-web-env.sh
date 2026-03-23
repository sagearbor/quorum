#!/bin/bash
# Copies NEXT_PUBLIC_ vars from root .env into apps/web/.env.local
# Run once after cloning or when root .env changes.
ROOT="$(dirname "$0")/.."
set -a && source "$ROOT/.env" && set +a
cat > "$ROOT/apps/web/.env.local" << ENV
NEXT_PUBLIC_SUPABASE_URL=$SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
NEXT_PUBLIC_QUORUM_TEST_MODE=${QUORUM_TEST_MODE:-false}
NEXT_PUBLIC_API_URL=${API_URL:-http://127.0.0.1:9000}
NEXT_PUBLIC_AVATAR_MOCK=${AVATAR_MOCK:-false}
ENV
echo "apps/web/.env.local written"
