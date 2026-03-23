#!/bin/zsh
set -a
source "$(dirname "$0")/.env"
set +a
cd "$(dirname "$0")/apps/api"
exec /Users/sophie.arborbot/Library/Python/3.11/bin/uvicorn main:app --port 9000
