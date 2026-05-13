"""OpenAI Realtime API + Whisper STT helpers for the Architect voice flow.

This module wraps two endpoints used by the Architect "Talk to me" mic button:

    POST /architect/realtime/session   → mint ephemeral client_secret
    POST /architect/transcribe          → Whisper fallback when WebRTC fails

Why a separate module:
  - Keeps `routes.py` from growing further (~1.6k lines already).
  - Concentrates the OpenAI HTTP plumbing (httpx → api.openai.com) in one place
    so it can be monkeypatched cleanly in tests.
  - The Realtime API does not go through the `LLMProvider` interface — it is
    a session-oriented, audio-native API rather than a tiered text-completion
    one — so it does not belong in packages/llm.

Refs (May 2026):
  - https://developers.openai.com/api/docs/guides/realtime
  - https://developers.openai.com/api/docs/guides/realtime-webrtc
  - https://developers.openai.com/api/docs/guides/speech-to-text

Threat model for the realtime session endpoint:
  - We MUST NOT return the user's main OPENAI_API_KEY to the browser.
  - OpenAI's `POST /v1/realtime/client_secrets` endpoint mints an ephemeral
    `ek_…` token bound to a single session that the browser uses against
    `wss://api.openai.com/v1/realtime` (or `POST /v1/realtime/calls` for the
    WebRTC SDP offer).
  - The ephemeral token is short-lived (~1 minute at issue time per current
    docs) and scoped to one session, so it is safe to ship to a browser.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, UploadFile, File

from models import (
    RealtimeSessionRequest,
    RealtimeSessionResponse,
    TranscribeResponse,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Defaults — overridable via env vars (documented in CONTRACT.md)
# ---------------------------------------------------------------------------

# As of May 2026 the GA realtime model is `gpt-realtime`. The previous preview
# alias `gpt-4o-realtime-preview` still resolves but is being phased out. We
# default to the GA name and let operators override via OPENAI_REALTIME_MODEL.
DEFAULT_REALTIME_MODEL = "gpt-realtime"
DEFAULT_REALTIME_VOICE = "alloy"

# OpenAI base URL — overridable so the backend test suite can point at a
# captured-request fixture without monkeypatching httpx.
OPENAI_API_BASE = os.environ.get("OPENAI_API_BASE", "https://api.openai.com")
OPENAI_CLIENT_SECRETS_PATH = "/v1/realtime/client_secrets"
OPENAI_TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions"

# Whisper default — `whisper-1` is still the cheapest STT model and is
# guaranteed-available. `gpt-4o-mini-transcribe` is cheaper-per-second on
# short clips but is gated behind tier-1+ accounts; default to whisper-1 so
# the fallback works on free-tier keys too.
DEFAULT_TRANSCRIBE_MODEL = os.environ.get("OPENAI_TRANSCRIBE_MODEL", "whisper-1")

# Cap upload size at 25 MB (OpenAI's documented limit for /v1/audio/transcriptions).
# A 25 MB webm/opus blob is ~25 minutes — more than enough for an architect prompt.
MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024


# ---------------------------------------------------------------------------
# Form-fill tool schema — what gpt-realtime is allowed to call on our behalf.
#
# The Realtime API expects each tool to be a flat object with `type: "function"`
# at the top level (different shape from Chat Completions which nests under a
# `function` key). The browser receives these via the session config and
# surfaces tool-call deltas as conversation items so the frontend can update
# Zustand state.
# ---------------------------------------------------------------------------

ARCHITECT_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "set_event_metadata",
        "description": (
            "Populate the Architect's event-creation form fields. Call this "
            "whenever the user names the event, describes the problem, or "
            "specifies a slug. Do not call until you have at minimum an "
            "event_title."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "event_title": {
                    "type": "string",
                    "description": (
                        "Short human-readable title, e.g. 'Clinical Trial "
                        "Review — BREATHE-AI'. Title case, no trailing period."
                    ),
                },
                "event_slug": {
                    "type": "string",
                    "description": (
                        "URL-safe slug derived from the title. Lowercase, "
                        "hyphen-separated, no spaces, no punctuation. "
                        "Example: 'breathe-ai-review'."
                    ),
                },
                "problem_description": {
                    "type": "string",
                    "description": (
                        "2-3 sentence rich description of the decision the "
                        "quorum needs to make. Plain prose, no markdown."
                    ),
                },
            },
            "required": ["event_title"],
        },
    },
    {
        "type": "function",
        "name": "set_quorum_problem",
        "description": (
            "Update only the problem-description field on the active quorum "
            "draft. Use when the user clarifies or expands the problem "
            "without changing the event metadata."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "problem_description": {
                    "type": "string",
                    "description": "Updated problem statement (2-3 sentences).",
                },
            },
            "required": ["problem_description"],
        },
    },
    {
        "type": "function",
        "name": "submit_form",
        "description": (
            "Submit the architect form once the user is satisfied. Do NOT "
            "call this unless the user explicitly says some variant of 'go', "
            "'submit', 'create it', 'looks good', 'do it'."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
]


ARCHITECT_INSTRUCTIONS = (
    "You are the Quorum Architect — a voice assistant that helps a human "
    "operator design a multi-agent quorum at a live tech expo. Your job is "
    "to listen to the operator describe a problem, then call the "
    "`set_event_metadata` tool to fill the event-creation form. Be concise; "
    "this is a noisy room. After populating the form, ask one short "
    "follow-up question if anything important is missing (e.g. the slug, "
    "the problem scope). Never narrate what you are about to do — just "
    "call the tool. When the operator says 'go' or 'submit', call "
    "`submit_form`. Keep spoken replies under 15 words."
)


router = APIRouter()


# ---------------------------------------------------------------------------
# POST /architect/realtime/session
# ---------------------------------------------------------------------------
@router.post("/architect/realtime/session", response_model=RealtimeSessionResponse)
async def create_realtime_session(body: RealtimeSessionRequest | None = None):
    """Mint an ephemeral OpenAI Realtime API client_secret for the browser.

    Flow:
      1. Frontend POSTs to this route (no body required).
      2. We hit `POST /v1/realtime/client_secrets` with our main OPENAI_API_KEY.
      3. We pass through the `value` and `expires_at` to the browser.
      4. Browser opens a WebRTC PeerConnection and POSTs its SDP offer to
         `POST /v1/realtime/calls` using the `ek_…` token as Bearer.

    Failures:
      - 401 if OPENAI_API_KEY is not set
      - 502 if OpenAI returns a non-2xx
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=401,
            detail=(
                "OPENAI_API_KEY is not configured on the backend. The "
                "Architect voice flow requires a live OpenAI key. Set it in "
                "apps/api/.env and restart the API server."
            ),
        )

    model = (body and body.model) or os.environ.get(
        "OPENAI_REALTIME_MODEL", DEFAULT_REALTIME_MODEL
    )
    voice = (body and body.voice) or os.environ.get(
        "OPENAI_REALTIME_VOICE", DEFAULT_REALTIME_VOICE
    )

    instructions = (body and body.instructions) or ARCHITECT_INSTRUCTIONS

    # Tool list — overridable per-request so other voice flows (not just the
    # architect) can reuse this endpoint with their own tools. Default is the
    # form-fill toolset above.
    tools = (body and body.tools) or ARCHITECT_TOOLS

    payload: dict[str, Any] = {
        "session": {
            "type": "realtime",
            "model": model,
            "audio": {
                "output": {"voice": voice},
            },
            "instructions": instructions,
            "tools": tools,
            "tool_choice": "auto",
        }
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    url = f"{OPENAI_API_BASE}{OPENAI_CLIENT_SECRETS_PATH}"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        logger.exception("Realtime session: httpx error talking to OpenAI")
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach OpenAI Realtime API: {exc}",
        ) from exc

    if resp.status_code >= 400:
        # Surface OpenAI's error verbatim — auth/billing failures need to be
        # visible to the operator so they know to add credit / fix the key.
        try:
            body_json = resp.json()
        except ValueError:
            body_json = {"raw": resp.text}
        logger.warning(
            "Realtime session: OpenAI returned %d — %r", resp.status_code, body_json,
        )
        raise HTTPException(
            status_code=502,
            detail={"openai_status": resp.status_code, "openai_body": body_json},
        )

    data = resp.json()

    # Response shape (May 2026): the GA endpoint returns the ephemeral key at
    # `value` plus an `expires_at` epoch-seconds field. Older preview docs
    # showed `{client_secret: {value, expires_at}}` — handle both for
    # forward/backward compat without crashing.
    value = data.get("value") or (data.get("client_secret") or {}).get("value")
    expires_at = data.get("expires_at") or (
        data.get("client_secret") or {}
    ).get("expires_at")

    if not value:
        raise HTTPException(
            status_code=502,
            detail=(
                "OpenAI Realtime returned no client_secret value — response "
                f"shape unexpected: {list(data.keys())}"
            ),
        )

    return RealtimeSessionResponse(
        client_secret=value,
        expires_at=expires_at,
        model=model,
        voice=voice,
    )


# ---------------------------------------------------------------------------
# POST /architect/transcribe — Whisper STT fallback
# ---------------------------------------------------------------------------
@router.post("/architect/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(file: UploadFile = File(...)):
    """Whisper STT fallback for the Architect voice flow.

    Used when WebRTC to gpt-realtime is unavailable (network policy, rate
    limit, free-tier key). The frontend records via MediaRecorder, POSTs the
    blob here, and we relay to OpenAI's /v1/audio/transcriptions. This is
    strictly STT — no audio is returned to the browser. The frontend then
    fills the form from `text` as if the user had typed it.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=401,
            detail="OPENAI_API_KEY is not configured on the backend.",
        )

    # Read once so we can size-check before forwarding.
    audio_bytes = await file.read()
    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="Empty audio upload.")
    if len(audio_bytes) > MAX_TRANSCRIBE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Audio file too large: {len(audio_bytes)} bytes "
                f"(max {MAX_TRANSCRIBE_BYTES})."
            ),
        )

    url = f"{OPENAI_API_BASE}{OPENAI_TRANSCRIPTIONS_PATH}"
    headers = {"Authorization": f"Bearer {api_key}"}
    files = {
        "file": (file.filename or "audio.webm", audio_bytes, file.content_type or "audio/webm"),
    }
    data = {"model": DEFAULT_TRANSCRIBE_MODEL, "response_format": "json"}

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(url, headers=headers, files=files, data=data)
    except httpx.HTTPError as exc:
        logger.exception("Transcribe: httpx error talking to OpenAI")
        raise HTTPException(
            status_code=502, detail=f"Could not reach OpenAI Whisper API: {exc}"
        ) from exc

    if resp.status_code >= 400:
        try:
            err = resp.json()
        except ValueError:
            err = {"raw": resp.text}
        raise HTTPException(
            status_code=502,
            detail={"openai_status": resp.status_code, "openai_body": err},
        )

    payload = resp.json()
    text = payload.get("text", "")
    if not isinstance(text, str):
        text = json.dumps(payload)
    return TranscribeResponse(text=text, model=DEFAULT_TRANSCRIBE_MODEL)
