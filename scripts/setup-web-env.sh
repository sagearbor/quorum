#!/usr/bin/env bash
# setup-web-env.sh — Copy NEXT_PUBLIC_* vars from root .env to apps/web/.env.local
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_ENV="$REPO_ROOT/.env"
WEB_ENV="$REPO_ROOT/apps/web/.env.local"

if [ ! -f "$ROOT_ENV" ]; then
  echo "Error: $ROOT_ENV not found. Create it first (see apps/web/.env.local.example)." >&2
  exit 1
fi

# Extract NEXT_PUBLIC_* lines from root .env (skip comments and blank lines)
grep -E '^NEXT_PUBLIC_' "$ROOT_ENV" > "$WEB_ENV"

echo "Wrote $(wc -l < "$WEB_ENV" | tr -d ' ') NEXT_PUBLIC_* vars to $WEB_ENV"
