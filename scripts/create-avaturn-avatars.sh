#!/usr/bin/env bash
# scripts/create-avaturn-avatars.sh
#
# Generate 12 archetype avatar GLBs using the Avaturn REST API.
#
# ============================================================
# IMPORTANT — AVATURN API LIMITATION
# ============================================================
# Avaturn is a PHOTO-BASED avatar generator. It does NOT support:
#   - Text-to-avatar (no "create avatar from description")
#   - Preset or template avatars without a source photo
#   - Procedural generation from parameters alone
#
# The API requires three photos per avatar:
#   1. image-frontal  — forward-facing face photo (JPEG/PNG)
#   2. image-side-1   — left-profile photo
#   2. image-side-2   — right-profile photo
#   plus a body-type ("male" or "female")
#
# This script therefore operates in PHOTO INPUT MODE:
#   It expects a directory of pre-collected photos organised by archetype.
#   Supply the directory via --photos-dir (default: ./avaturn-photos).
#   Each archetype sub-directory must contain:
#     frontal.jpg  (or .jpeg / .png)
#     side-1.jpg   (or .jpeg / .png)
#     side-2.jpg   (or .jpeg / .png)
#     body-type    (text file containing "male" or "female")
#
#   Example layout:
#     avaturn-photos/
#       medical/frontal.jpg
#       medical/side-1.jpg
#       medical/side-2.jpg
#       medical/body-type        ← contains "female"
#       researcher/frontal.jpg
#       ...
#
# ============================================================
# AUTHENTICATION
# ============================================================
# Set one of:
#   AVATURN_API_KEY         — API key from https://developer.avaturn.me
#   AVATURN_ACCESS_TOKEN    — OAuth access token (takes precedence)
#
# ============================================================
# USAGE
# ============================================================
#   AVATURN_API_KEY=your_key bash scripts/create-avaturn-avatars.sh
#   AVATURN_API_KEY=your_key bash scripts/create-avaturn-avatars.sh \
#       --photos-dir /path/to/photos
#   AVATURN_API_KEY=your_key bash scripts/create-avaturn-avatars.sh \
#       --photos-dir /path/to/photos \
#       --output-dir apps/web/public/avatars/avaturn
#
# OPTIONS
#   --photos-dir DIR    Directory containing per-archetype photo sub-dirs
#                       (default: ./avaturn-photos relative to project root)
#   --output-dir DIR    Where to write the output .glb files
#                       (default: apps/web/public/avatars/avaturn)
#   --dry-run           Validate inputs and print what would be uploaded
#                       without actually calling the API
#   --skip-existing     Skip archetypes whose .glb already exists in output dir
#   --poll-interval N   Seconds between status polls while waiting for
#                       Avaturn to process photos (default: 5)
#   --poll-timeout N    Maximum seconds to wait per avatar (default: 300)
#   --help              Print this message and exit
#
# REQUIREMENTS
#   curl, jq
#
# ============================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Avaturn base API URL (documented at https://docs.avaturn.me)
AVATURN_BASE="https://api.avaturn.me/api/v1"

# Default paths (relative to project root)
DEFAULT_PHOTOS_DIR="$PROJECT_ROOT/avaturn-photos"
DEFAULT_OUTPUT_DIR="$PROJECT_ROOT/apps/web/public/avatars/avaturn"

# Archetype definitions: key = subdirectory name, value = output GLB filename
# Descriptions are comments only — Avaturn does not accept text descriptions;
# they are included here as documentation for the human collecting photos.
declare -A ARCHETYPES
ARCHETYPES=(
  [medical]="medical.glb"           # Doctor in white coat, clinical setting
  [researcher]="researcher.glb"     # Lab scientist, academic attire
  [faculty]="faculty.glb"           # University professor, business-casual
  [grad_student]="grad_student.glb" # Graduate student, smart-casual
  [undergrad]="undergrad.glb"       # College student, casual attire
  [administrator]="administrator.glb" # University dean/director, business attire
  [ethics]="ethics.glb"             # Bioethicist/compliance officer, formal
  [tech]="tech.glb"                 # Software engineer, casual
  [finance]="finance.glb"           # CFO/operations, business attire
  [patient]="patient.glb"           # Patient/community member, casual
  [humanities]="humanities.glb"     # Historian/philosopher, academic attire
  [neutral]="neutral.glb"           # Moderator/facilitator, smart-casual
)

# ---------------------------------------------------------------------------
# Defaults (overridden by flags)
# ---------------------------------------------------------------------------

PHOTOS_DIR="$DEFAULT_PHOTOS_DIR"
OUTPUT_DIR="$DEFAULT_OUTPUT_DIR"
DRY_RUN=false
SKIP_EXISTING=false
POLL_INTERVAL=5
POLL_TIMEOUT=300

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log_info()    { echo "[INFO]  $*"; }
log_ok()      { echo "[OK]    $*"; }
log_warn()    { echo "[WARN]  $*"; }
log_error()   { echo "[ERROR] $*" >&2; }
log_section() { echo ""; echo "--- $* ---"; }

usage() {
  grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \{0,2\}//'
  exit 0
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" &>/dev/null; then
    log_error "Required command not found: $cmd"
    log_error "Install $cmd and retry."
    exit 1
  fi
}

# Resolve first matching image file with a given base name and common extensions.
# Prints the full path if found, empty string otherwise.
find_image() {
  local dir="$1"
  local base="$2"
  for ext in jpg jpeg png JPG JPEG PNG; do
    local candidate="$dir/$base.$ext"
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  echo ""
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --photos-dir)
      PHOTOS_DIR="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-existing)
      SKIP_EXISTING=true
      shift
      ;;
    --poll-interval)
      POLL_INTERVAL="$2"
      shift 2
      ;;
    --poll-timeout)
      POLL_TIMEOUT="$2"
      shift 2
      ;;
    --help|-h)
      usage
      ;;
    *)
      log_error "Unknown argument: $1"
      log_error "Run with --help for usage."
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate environment
# ---------------------------------------------------------------------------

require_command curl
require_command jq

# Resolve authentication: AVATURN_ACCESS_TOKEN takes precedence over API key.
AUTH_HEADER=""
if [[ -n "${AVATURN_ACCESS_TOKEN:-}" ]]; then
  AUTH_HEADER="Authorization: Bearer $AVATURN_ACCESS_TOKEN"
  log_info "Using AVATURN_ACCESS_TOKEN for authentication."
elif [[ -n "${AVATURN_API_KEY:-}" ]]; then
  AUTH_HEADER="Authorization: Bearer $AVATURN_API_KEY"
  log_info "Using AVATURN_API_KEY for authentication."
else
  log_error "No Avaturn credentials found."
  log_error "Set AVATURN_API_KEY or AVATURN_ACCESS_TOKEN and retry."
  log_error ""
  log_error "Get your API key at: https://developer.avaturn.me"
  exit 1
fi

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

echo "============================================================"
echo "  Quorum — Avaturn Avatar Generator"
echo "============================================================"
log_info "Photos dir : $PHOTOS_DIR"
log_info "Output dir : $OUTPUT_DIR"
log_info "Dry run    : $DRY_RUN"
log_info "Skip exist : $SKIP_EXISTING"

# ---------------------------------------------------------------------------
# Validate photo inputs before touching the API
# ---------------------------------------------------------------------------

log_section "Validating photo inputs"

VALIDATION_ERRORS=0
declare -A VALIDATED_ARCHETYPES  # only archetypes with complete photos

for archetype in "${!ARCHETYPES[@]}"; do
  archetype_dir="$PHOTOS_DIR/$archetype"

  if [[ ! -d "$archetype_dir" ]]; then
    log_warn "$archetype: directory not found ($archetype_dir) — will skip."
    VALIDATION_ERRORS=$((VALIDATION_ERRORS + 1))
    continue
  fi

  frontal=$(find_image "$archetype_dir" "frontal")
  side1=$(find_image "$archetype_dir" "side-1")
  side2=$(find_image "$archetype_dir" "side-2")
  body_type_file="$archetype_dir/body-type"

  missing=()
  [[ -z "$frontal" ]] && missing+=("frontal.jpg")
  [[ -z "$side1"   ]] && missing+=("side-1.jpg")
  [[ -z "$side2"   ]] && missing+=("side-2.jpg")

  if [[ ! -f "$body_type_file" ]]; then
    missing+=("body-type")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    log_warn "$archetype: missing files: ${missing[*]} — will skip."
    VALIDATION_ERRORS=$((VALIDATION_ERRORS + 1))
    continue
  fi

  body_type=$(tr -d '[:space:]' < "$body_type_file")
  if [[ "$body_type" != "male" && "$body_type" != "female" ]]; then
    log_warn "$archetype: body-type file must contain 'male' or 'female'," \
             "got: '$body_type' — will skip."
    VALIDATION_ERRORS=$((VALIDATION_ERRORS + 1))
    continue
  fi

  log_ok "$archetype: photos validated (body-type=$body_type)."
  VALIDATED_ARCHETYPES[$archetype]="${ARCHETYPES[$archetype]}"
done

# bash set -u treats an empty associative array as unbound in some versions;
# temporarily relax nounset to safely read the length.
set +u
TOTAL_VALID=${#VALIDATED_ARCHETYPES[@]}
set -u

if [[ $TOTAL_VALID -eq 0 ]]; then
  log_error ""
  log_error "No archetypes have valid photo sets. Nothing to do."
  log_error ""
  log_error "Expected directory layout:"
  log_error "  $PHOTOS_DIR/"
  log_error "    medical/frontal.jpg"
  log_error "    medical/side-1.jpg"
  log_error "    medical/side-2.jpg"
  log_error "    medical/body-type   <- contains 'male' or 'female'"
  log_error "    researcher/..."
  log_error "    (etc.)"
  exit 1
fi

log_info ""
log_info "$TOTAL_VALID / ${#ARCHETYPES[@]} archetypes ready to process."

if [[ $VALIDATION_ERRORS -gt 0 ]]; then
  log_warn "$VALIDATION_ERRORS archetype(s) will be skipped due to missing inputs."
fi

# ---------------------------------------------------------------------------
# Dry-run exit point
# ---------------------------------------------------------------------------

if [[ "$DRY_RUN" == "true" ]]; then
  log_section "Dry-run complete — no API calls made"
  set +u
  log_info "Would upload photos for: ${!VALIDATED_ARCHETYPES[*]}"
  set -u
  log_info "Would write GLBs to: $OUTPUT_DIR"
  exit 0
fi

# ---------------------------------------------------------------------------
# Ensure output directory exists
# ---------------------------------------------------------------------------

mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------------------
# Per-archetype: create avatar, upload photos, poll, export, download
# ---------------------------------------------------------------------------

log_section "Processing archetypes"

SUCCESSES=0
FAILURES=0
declare -a FAILED_ARCHETYPES

# Wrapper for curl that exits on network failure (non-zero curl exit code)
# but returns the HTTP response body regardless of HTTP status code.
avaturn_curl() {
  # Usage: avaturn_curl <http_status_var> [curl args...]
  local status_var="$1"
  shift
  local http_code
  local body
  # Write body to a temp file to separate it from the status code.
  local tmpfile
  tmpfile=$(mktemp)
  http_code=$(curl -s -w "%{http_code}" -o "$tmpfile" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    "$@") || {
    rm -f "$tmpfile"
    log_error "curl command failed (network error)."
    return 1
  }
  body=$(cat "$tmpfile")
  rm -f "$tmpfile"
  # Assign HTTP status to caller's variable via nameref (bash 4.3+).
  printf -v "$status_var" '%s' "$http_code"
  echo "$body"
}

set +u  # guard against empty associative array with set -u
for archetype in "${!VALIDATED_ARCHETYPES[@]}"; do
  set -u
  glb_name="${VALIDATED_ARCHETYPES[$archetype]}"
  output_path="$OUTPUT_DIR/$glb_name"

  echo ""
  log_info "[$archetype] Starting..."

  # --skip-existing guard
  if [[ "$SKIP_EXISTING" == "true" && -f "$output_path" ]]; then
    log_ok "[$archetype] $glb_name already exists — skipping."
    SUCCESSES=$((SUCCESSES + 1))
    continue
  fi

  archetype_dir="$PHOTOS_DIR/$archetype"
  frontal=$(find_image "$archetype_dir" "frontal")
  side1=$(find_image "$archetype_dir" "side-1")
  side2=$(find_image "$archetype_dir" "side-2")
  body_type=$(tr -d '[:space:]' < "$archetype_dir/body-type")

  # ------------------------------------------------------------------
  # Step 1: POST /avatars/new — obtain avatar ID and upload URL
  # ------------------------------------------------------------------
  log_info "[$archetype] Step 1/4: Initializing avatar..."

  http_status=""
  response=$(avaturn_curl http_status -X POST "$AVATURN_BASE/avatars/new") || {
    log_error "[$archetype] Network error on POST /avatars/new. Skipping."
    FAILURES=$((FAILURES + 1))
    FAILED_ARCHETYPES+=("$archetype")
    continue
  }

  if [[ "$http_status" != "200" && "$http_status" != "201" ]]; then
    log_error "[$archetype] POST /avatars/new returned HTTP $http_status."
    log_error "[$archetype] Response: $response"
    FAILURES=$((FAILURES + 1))
    FAILED_ARCHETYPES+=("$archetype")
    continue
  fi

  avatar_id=$(echo "$response" | jq -r '.id // .avatar_id // .data.id // empty')
  upload_url=$(echo "$response" | jq -r '.upload_url // .uploadUrl // .data.upload_url // .data.uploadUrl // empty')

  if [[ -z "$avatar_id" || -z "$upload_url" ]]; then
    log_error "[$archetype] Could not parse avatar_id or upload_url from response."
    log_error "[$archetype] Response: $response"
    FAILURES=$((FAILURES + 1))
    FAILED_ARCHETYPES+=("$archetype")
    continue
  fi

  log_ok "[$archetype] Avatar ID: $avatar_id"

  # ------------------------------------------------------------------
  # Step 2: POST <upload_url> — multipart upload of photos
  # Note: The upload URL is a presigned endpoint returned by step 1.
  # It does NOT carry the Authorization header (it's presigned).
  # ------------------------------------------------------------------
  log_info "[$archetype] Step 2/4: Uploading photos to presigned URL..."

  upload_tmpfile=$(mktemp)
  upload_http=$(curl -s -w "%{http_code}" -o "$upload_tmpfile" \
    -X POST "$upload_url" \
    -F "body-type=$body_type" \
    -F "telephoto=false" \
    -F "image-frontal=@$frontal" \
    -F "image-side-1=@$side1" \
    -F "image-side-2=@$side2") || {
    rm -f "$upload_tmpfile"
    log_error "[$archetype] Network error uploading photos. Skipping."
    FAILURES=$((FAILURES + 1))
    FAILED_ARCHETYPES+=("$archetype")
    continue
  }
  upload_body=$(cat "$upload_tmpfile")
  rm -f "$upload_tmpfile"

  if [[ "$upload_http" != "200" && "$upload_http" != "201" && "$upload_http" != "204" ]]; then
    log_error "[$archetype] Photo upload returned HTTP $upload_http."
    log_error "[$archetype] Response: $upload_body"
    FAILURES=$((FAILURES + 1))
    FAILED_ARCHETYPES+=("$archetype")
    continue
  fi

  log_ok "[$archetype] Photos uploaded."

  # ------------------------------------------------------------------
  # Step 3: Poll for avatar.ready — wait for async processing
  # Avaturn processes photos asynchronously. We poll GET /avatars/{id}
  # and check for a status field. The exact status values and field
  # name are inferred from the API pattern; adjust if the API returns
  # a different shape (e.g. "state", "processing_status", etc.).
  # ------------------------------------------------------------------
  log_info "[$archetype] Step 3/4: Waiting for processing (up to ${POLL_TIMEOUT}s)..."

  elapsed=0
  avatar_status=""
  ready=false

  while [[ $elapsed -lt $POLL_TIMEOUT ]]; do
    poll_tmpfile=$(mktemp)
    poll_http=$(curl -s -w "%{http_code}" -o "$poll_tmpfile" \
      -H "$AUTH_HEADER" \
      -X GET "$AVATURN_BASE/avatars/$avatar_id") || {
      rm -f "$poll_tmpfile"
      log_warn "[$archetype] Network error while polling (elapsed ${elapsed}s). Retrying..."
      sleep "$POLL_INTERVAL"
      elapsed=$((elapsed + POLL_INTERVAL))
      continue
    }
    poll_body=$(cat "$poll_tmpfile")
    rm -f "$poll_tmpfile"

    if [[ "$poll_http" != "200" ]]; then
      log_warn "[$archetype] Poll returned HTTP $poll_http (elapsed ${elapsed}s). Retrying..."
      sleep "$POLL_INTERVAL"
      elapsed=$((elapsed + POLL_INTERVAL))
      continue
    fi

    # Avaturn may use "status", "state", or "processing_status" — check all.
    avatar_status=$(echo "$poll_body" | jq -r \
      '.status // .state // .processing_status // "unknown"')

    case "$avatar_status" in
      ready|completed|done|exported)
        log_ok "[$archetype] Processing complete (status=$avatar_status, ${elapsed}s elapsed)."
        ready=true
        break
        ;;
      failed|error|processing_failed)
        log_error "[$archetype] Avatar processing failed (status=$avatar_status)."
        log_error "[$archetype] This is usually caused by poor image quality, missing"
        log_error "[$archetype] face in photos, or unsupported image format."
        log_error "[$archetype] Response: $poll_body"
        break
        ;;
      processing|pending|uploading|queued|unknown|*)
        log_info "[$archetype] Status: $avatar_status (${elapsed}s elapsed)..."
        sleep "$POLL_INTERVAL"
        elapsed=$((elapsed + POLL_INTERVAL))
        ;;
    esac
  done

  if [[ "$ready" != "true" ]]; then
    if [[ $elapsed -ge $POLL_TIMEOUT ]]; then
      log_error "[$archetype] Timed out waiting for processing after ${POLL_TIMEOUT}s."
    fi
    FAILURES=$((FAILURES + 1))
    FAILED_ARCHETYPES+=("$archetype")
    continue
  fi

  # ------------------------------------------------------------------
  # Step 4a: POST /exports/new — request GLB export
  # ------------------------------------------------------------------
  log_info "[$archetype] Step 4/4: Requesting GLB export..."

  export_payload=$(jq -n \
    --arg avatar_id "$avatar_id" \
    '{"avatar_id": $avatar_id, "format": "glb", "lod": 0}')

  export_tmpfile=$(mktemp)
  export_http=$(curl -s -w "%{http_code}" -o "$export_tmpfile" \
    -X POST "$AVATURN_BASE/exports/new" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "$export_payload") || {
    rm -f "$export_tmpfile"
    log_error "[$archetype] Network error requesting export. Skipping."
    FAILURES=$((FAILURES + 1))
    FAILED_ARCHETYPES+=("$archetype")
    continue
  }
  export_body=$(cat "$export_tmpfile")
  rm -f "$export_tmpfile"

  if [[ "$export_http" != "200" && "$export_http" != "201" ]]; then
    log_error "[$archetype] POST /exports/new returned HTTP $export_http."
    log_error "[$archetype] Response: $export_body"
    FAILURES=$((FAILURES + 1))
    FAILED_ARCHETYPES+=("$archetype")
    continue
  fi

  # Parse GLB download URL from export response.
  # Field name varies: "url", "download_url", "glb_url", "model_url".
  glb_url=$(echo "$export_body" | jq -r \
    '.url // .download_url // .glb_url // .model_url // .data.url // empty')

  if [[ -z "$glb_url" ]]; then
    log_error "[$archetype] Could not parse GLB URL from export response."
    log_error "[$archetype] Response: $export_body"
    FAILURES=$((FAILURES + 1))
    FAILED_ARCHETYPES+=("$archetype")
    continue
  fi

  # ------------------------------------------------------------------
  # Step 4b: Download the GLB file
  # ------------------------------------------------------------------
  log_info "[$archetype] Downloading GLB from: $glb_url"

  dl_http=$(curl -s -w "%{http_code}" -L \
    -o "$output_path" \
    "$glb_url") || {
    log_error "[$archetype] Network error downloading GLB. Skipping."
    rm -f "$output_path"
    FAILURES=$((FAILURES + 1))
    FAILED_ARCHETYPES+=("$archetype")
    continue
  }

  if [[ "$dl_http" != "200" ]]; then
    log_error "[$archetype] GLB download returned HTTP $dl_http."
    rm -f "$output_path"
    FAILURES=$((FAILURES + 1))
    FAILED_ARCHETYPES+=("$archetype")
    continue
  fi

  # Basic sanity check: a GLB must start with the magic bytes 0x676C5446 ("glTF")
  file_magic=$(xxd -l 4 -p "$output_path" 2>/dev/null || true)
  if [[ "$file_magic" != "676c5446" ]]; then
    log_warn "[$archetype] Downloaded file does not appear to be a valid GLB" \
             "(magic bytes: $file_magic). It may still load correctly."
  fi

  file_size=$(wc -c < "$output_path")
  log_ok "[$archetype] Saved $glb_name (${file_size} bytes) -> $output_path"
  SUCCESSES=$((SUCCESSES + 1))

done
set -u  # restore nounset after loop

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "============================================================"
echo "  Summary"
echo "============================================================"
log_info "Succeeded : $SUCCESSES / $TOTAL_VALID"
log_info "Failed    : $FAILURES / $TOTAL_VALID"

if [[ ${#FAILED_ARCHETYPES[@]} -gt 0 ]]; then
  log_warn "Failed archetypes: ${FAILED_ARCHETYPES[*]}"
fi

TOTAL_SKIPPED=$(( ${#ARCHETYPES[@]} - TOTAL_VALID ))
if [[ $TOTAL_SKIPPED -gt 0 ]]; then
  log_warn "$TOTAL_SKIPPED archetype(s) had no photos and were skipped entirely."
fi

echo ""
log_info "Output directory: $OUTPUT_DIR"

if [[ $FAILURES -gt 0 ]]; then
  echo ""
  log_warn "Some avatars failed. Common causes:"
  log_warn "  - Photos contain no visible face or are too low-resolution"
  log_warn "  - Image format not supported (use JPEG or PNG)"
  log_warn "  - Avaturn API key invalid or rate-limited"
  log_warn "  - Avatar processing timeout (try --poll-timeout 600)"
  echo ""
  log_warn "Re-run with --skip-existing to retry only the failed ones:"
  log_warn "  AVATURN_API_KEY=... bash scripts/create-avaturn-avatars.sh \\"
  log_warn "      --skip-existing --photos-dir $PHOTOS_DIR"
  exit 1
fi

echo ""
log_ok "All avatars generated successfully."
