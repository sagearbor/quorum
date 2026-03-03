#!/usr/bin/env bash
# scripts/create-rpm-avatars.sh
#
# Attempt to create RPM avatars via the Partner API.
# Falls back to procedural placeholders if API key is not configured.
#
# Requirements:
#   - RPM_API_KEY env var (Ready Player Me Partner API key)
#   - RPM_APP_ID env var (Ready Player Me application ID)
#   - curl, jq
#
# Usage:
#   RPM_API_KEY=xxx RPM_APP_ID=yyy bash scripts/create-rpm-avatars.sh
#
# If RPM credentials are not set, generates procedural placeholder meshes instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AVATAR_DIR="$PROJECT_ROOT/apps/web/public/avatars"

mkdir -p "$AVATAR_DIR"

# Archetype → GLB filename mapping (from PRD)
declare -A ARCHETYPES=(
  [medical_clinical]="medical.glb"
  [researcher]="researcher.glb"
  [faculty]="faculty.glb"
  [student_grad]="grad_student.glb"
  [student_undergrad]="undergrad.glb"
  [administrator]="administrator.glb"
  [ethics]="ethics.glb"
  [engineer_tech]="tech.glb"
  [finance_ops]="finance.glb"
  [patient_participant]="patient.glb"
  [humanities_social]="humanities.glb"
  [neutral]="neutral.glb"
)

RPM_API_KEY="${RPM_API_KEY:-}"
RPM_APP_ID="${RPM_APP_ID:-}"

if [[ -z "$RPM_API_KEY" || -z "$RPM_APP_ID" ]]; then
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  RPM_API_KEY or RPM_APP_ID not set.                        ║"
  echo "║  Ready Player Me Partner API requires both credentials.    ║"
  echo "║                                                            ║"
  echo "║  Falling back to procedural placeholder generation.        ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Generating procedural placeholders via TypeScript generator..."
  echo ""

  # Check for tsx/npx
  if command -v npx &>/dev/null; then
    cd "$PROJECT_ROOT"
    npx tsx scripts/generate-placeholder-avatars.ts
  else
    echo "ERROR: npx not found. Install Node.js >= 18 and run:"
    echo "  npx tsx scripts/generate-placeholder-avatars.ts"
    exit 1
  fi

  exit 0
fi

echo "Creating RPM avatars via Partner API..."
echo ""

RPM_BASE="https://api.readyplayer.me/v2"

# Step 1: Create anonymous user to get access token
echo "Creating RPM user..."
USER_RESP=$(curl -s -X POST "$RPM_BASE/users" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $RPM_API_KEY" \
  -d '{"applicationId": "'"$RPM_APP_ID"'"}')

TOKEN=$(echo "$USER_RESP" | jq -r '.data.token // empty')

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: Failed to create RPM user. Response:"
  echo "$USER_RESP"
  echo ""
  echo "Falling back to procedural placeholders..."
  cd "$PROJECT_ROOT"
  npx tsx scripts/generate-placeholder-avatars.ts
  exit 0
fi

echo "  Token acquired."

# Step 2: Get available templates
echo "Fetching avatar templates..."
TEMPLATES_RESP=$(curl -s -X GET "$RPM_BASE/avatars/templates" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-api-key: $RPM_API_KEY")

TEMPLATE_ID=$(echo "$TEMPLATES_RESP" | jq -r '.data[0].id // empty')

if [[ -z "$TEMPLATE_ID" ]]; then
  echo "ERROR: No templates available. Falling back to placeholders..."
  cd "$PROJECT_ROOT"
  npx tsx scripts/generate-placeholder-avatars.ts
  exit 0
fi

echo "  Using template: $TEMPLATE_ID"

# Step 3: Create + download avatar for each archetype
for archetype in "${!ARCHETYPES[@]}"; do
  glb_name="${ARCHETYPES[$archetype]}"
  echo "  Creating $archetype → $glb_name..."

  # Create draft avatar from template
  AVATAR_RESP=$(curl -s -X POST "$RPM_BASE/avatars/templates/$TEMPLATE_ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "x-api-key: $RPM_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"partner": "'"$RPM_APP_ID"'", "bodyType": "fullbody"}')

  AVATAR_ID=$(echo "$AVATAR_RESP" | jq -r '.data.id // empty')

  if [[ -z "$AVATAR_ID" ]]; then
    echo "    WARN: Failed to create avatar for $archetype. Skipping."
    continue
  fi

  # Save avatar
  curl -s -X PUT "$RPM_BASE/avatars/$AVATAR_ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "x-api-key: $RPM_API_KEY" >/dev/null

  # Download GLB
  GLB_URL="https://models.readyplayer.me/$AVATAR_ID.glb?morphTargets=ARKit&textureAtlas=1024"
  HTTP_CODE=$(curl -s -o "$AVATAR_DIR/$glb_name" -w "%{http_code}" "$GLB_URL")

  if [[ "$HTTP_CODE" == "200" ]]; then
    echo "    ✓ Downloaded $glb_name"
  else
    echo "    ✗ Download failed (HTTP $HTTP_CODE). Will use placeholder."
    rm -f "$AVATAR_DIR/$glb_name"
  fi
done

# Check if any GLBs are missing, generate placeholders for those
MISSING=0
for archetype in "${!ARCHETYPES[@]}"; do
  glb_name="${ARCHETYPES[$archetype]}"
  if [[ ! -f "$AVATAR_DIR/$glb_name" ]]; then
    MISSING=$((MISSING + 1))
  fi
done

if [[ $MISSING -gt 0 ]]; then
  echo ""
  echo "$MISSING avatars missing — generating placeholders for gaps..."
  cd "$PROJECT_ROOT"
  npx tsx scripts/generate-placeholder-avatars.ts
fi

echo ""
echo "Done! Avatar assets in: $AVATAR_DIR"
