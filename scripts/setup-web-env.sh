#!/usr/bin/env bash
# setup-web-env.sh — Build apps/web/.env.local from root .env
#
# Maps root-level vars to their NEXT_PUBLIC_ equivalents and copies any
# NEXT_PUBLIC_* vars that already exist in root .env.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_ENV="$REPO_ROOT/.env"
WEB_ENV="$REPO_ROOT/apps/web/.env.local"

if [ ! -f "$ROOT_ENV" ]; then
  echo "Error: $ROOT_ENV not found. Create it first (see .env.example)." >&2
  exit 1
fi

# Helper: read a var from root .env (ignores comments, trims whitespace)
get_var() {
  grep -E "^${1}=" "$ROOT_ENV" | head -1 | cut -d'=' -f2-
}

# Start fresh
: > "$WEB_ENV"

# 1. Map root vars → NEXT_PUBLIC_ equivalents
SUPABASE_URL="$(get_var SUPABASE_URL)"
SUPABASE_ANON_KEY="$(get_var SUPABASE_ANON_KEY)"

[ -n "$SUPABASE_URL" ]      && echo "NEXT_PUBLIC_SUPABASE_URL=$SUPABASE_URL" >> "$WEB_ENV"
[ -n "$SUPABASE_ANON_KEY" ] && echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY" >> "$WEB_ENV"

# 2. Copy any NEXT_PUBLIC_* vars already in root .env (won't duplicate the above)
grep -E '^NEXT_PUBLIC_' "$ROOT_ENV" | while IFS= read -r line; do
  var_name="${line%%=*}"
  # Skip if we already wrote this var
  grep -q "^${var_name}=" "$WEB_ENV" 2>/dev/null || echo "$line" >> "$WEB_ENV"
done

# 3. Map QUORUM_TEST_MODE if set (backend var → frontend var)
TEST_MODE="$(get_var QUORUM_TEST_MODE)"
[ -n "$TEST_MODE" ] && ! grep -q '^NEXT_PUBLIC_QUORUM_TEST_MODE=' "$WEB_ENV" && \
  echo "NEXT_PUBLIC_QUORUM_TEST_MODE=$TEST_MODE" >> "$WEB_ENV"

# 4. Map AVATAR_MOCK if set
AVATAR_MOCK="$(get_var AVATAR_MOCK)"
[ -n "$AVATAR_MOCK" ] && ! grep -q '^NEXT_PUBLIC_AVATAR_MOCK=' "$WEB_ENV" && \
  echo "NEXT_PUBLIC_AVATAR_MOCK=$AVATAR_MOCK" >> "$WEB_ENV"

COUNT=$(wc -l < "$WEB_ENV" | tr -d ' ')
echo "Wrote $COUNT var(s) to $WEB_ENV"
