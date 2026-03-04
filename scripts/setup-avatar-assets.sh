#!/usr/bin/env bash
# scripts/setup-avatar-assets.sh
#
# One-command setup for all avatar assets (avatars + animations).
#
# What it does:
#   1. Tries to create RPM avatars via Partner API (if credentials set)
#   2. Falls back to procedural placeholder GLTFs
#   3. Generates animation stubs (idle/walk/jog/sit)
#
# Usage:
#   bash scripts/setup-avatar-assets.sh
#
# Optional env vars:
#   RPM_API_KEY  — Ready Player Me Partner API key
#   RPM_APP_ID   — Ready Player Me application ID

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AVATAR_DIR="$PROJECT_ROOT/apps/web/public/avatars"
ANIM_DIR="$PROJECT_ROOT/apps/web/public/animations"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Quorum Avatar Asset Setup                                  ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Ensure output directories exist
mkdir -p "$AVATAR_DIR" "$ANIM_DIR"

# Step 1: Generate avatars (RPM or placeholder)
echo "Step 1: Avatar generation"
echo "─────────────────────────"
bash "$SCRIPT_DIR/create-rpm-avatars.sh"
echo ""

# Step 2: Verify avatar files were generated
echo "Step 2: Verifying avatar assets"
echo "───────────────────────────────"
AVATAR_COUNT=$(find "$AVATAR_DIR" -name '*.gltf' -o -name '*.glb' | wc -l | tr -d ' ')
echo "  Found $AVATAR_COUNT avatar files in $AVATAR_DIR"

if [ "$AVATAR_COUNT" -eq 0 ]; then
  echo "  WARNING: No avatar files generated. Check errors above."
  exit 1
fi
echo ""

# Step 3: Verify animation stubs
echo "Step 3: Verifying animation assets"
echo "───────────────────────────────────"
ANIM_COUNT=$(find "$ANIM_DIR" -name '*.gltf' -o -name '*.glb' | wc -l | tr -d ' ')
echo "  Found $ANIM_COUNT animation files in $ANIM_DIR"

if [ "$ANIM_COUNT" -eq 0 ]; then
  echo "  WARNING: No animation files generated. Check errors above."
  exit 1
fi
echo ""

# Summary
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Setup complete!                                            ║"
echo "║                                                             ║"
echo "║  Avatars:    $AVATAR_DIR"
echo "║  Animations: $ANIM_DIR"
echo "║                                                             ║"
echo "║  To replace placeholders with real RPM avatars:             ║"
echo "║    RPM_API_KEY=xxx RPM_APP_ID=yyy bash $0"
echo "║                                                             ║"
echo "║  See: apps/web/public/avatars/README.md                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
