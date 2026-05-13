"""A2A server — FastAPI routes for the Linux Foundation A2A 1.0 protocol.

Endpoints exposed under ``/a2a``:

  * ``GET  /a2a/`` — protocol discovery banner
  * ``POST /a2a/guidance`` — architect guidance (Quorum-specific, kept from v0)
  * ``GET  /a2a/guidance/{quorum_id}`` — list recent guidance
  * ``GET  /a2a/agents/{role_id}/.well-known/agent-card.json`` — SDK canonical
  * ``GET  /a2a/agents/{role_id}/.well-known/agent.json`` — alias for older
    clients (the Linux Foundation A2A spec accepts both during the 0.3→1.0
    migration window; we serve identical content from both)
  * ``POST /a2a/agents/{role_id}/message:send`` — v1.0 canonical send-message
  * ``POST /a2a/agents/{role_id}/tasks/send`` — alias matching the developer
    checklist (10.3 named it this way before v1.0 renamed the method)

All AgentCard payloads, request bodies, and response bodies are typed via
``a2a-sdk``'s protobuf classes; we serialize them through the SDK's own
helpers so the JSON field-name casing (``contextId`` not ``context_id``)
matches what other A2A-compliant clients send and expect.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from google.protobuf.json_format import MessageToDict, ParseDict
from google.protobuf.timestamp_pb2 import Timestamp

# Canonical GuidanceRequest lives in apps.api.models — import & re-export so
# legacy callers (and tests) that imported it from a2a_server keep working.
from models import GuidanceRequest  # noqa: F401  (re-export)

# SDK imports — use the real a2a-sdk types, not bespoke dicts.
from a2a.types.a2a_pb2 import (
    Artifact,
    Message,
    Part,
    Role,
    SendMessageRequest,
    SendMessageResponse,
    Task,
    TaskState,
    TaskStatus,
)

from database import get_supabase
from db.aexec import aexec  # 12.6: thread-pool wrapper for sync Supabase calls.
from .a2a_client import A2AClient
from .agent_card import build_agent_card_dict

logger = logging.getLogger(__name__)

# Default base URL for cards. Override via QUORUM_A2A_BASE_URL.
DEFAULT_BASE_URL = os.environ.get("QUORUM_A2A_BASE_URL", "http://localhost:8000")


a2a_router = APIRouter(prefix="/a2a", tags=["a2a"])


# ---------------------------------------------------------------------------
# Endpoint registry helpers (replaces the process-local _agent_registry dict)
# ---------------------------------------------------------------------------

def lookup_endpoint(role_id: str, db: Any | None = None) -> str | None:
    """Look up the registered A2A endpoint URL for a role.

    Reads from the ``agent_endpoints`` table (created by migration
    20260512000004). Returns the URL string or None if no row exists or the
    table itself is missing (graceful degradation for stacks running on the
    pre-10.3 schema).

    Args:
        role_id: Role ID to look up.
        db: Optional Supabase client; if None we create a fresh one.
    """
    if db is None:
        db = get_supabase()
    try:
        result = (
            db.table("agent_endpoints")
            .select("url")
            .eq("role_id", role_id)
            .maybe_single()
            .execute()
        )
    except Exception:
        # Table missing (e.g. migration not applied) — log once and bail.
        logger.debug("lookup_endpoint: agent_endpoints unreadable", exc_info=True)
        return None
    if not result or not result.data:
        return None
    return result.data.get("url")


def register_endpoint(
    role_id: str,
    *,
    base_url: str | None = None,
    capabilities: dict[str, Any] | None = None,
    db: Any | None = None,
) -> str | None:
    """Upsert an ``agent_endpoints`` row for a role.

    Returns the URL that was registered, or None on failure.  Never raises —
    role creation must continue even when the registry table is unavailable.
    """
    if db is None:
        db = get_supabase()
    base = (base_url or DEFAULT_BASE_URL).rstrip("/")
    url = f"{base}/a2a/agents/{role_id}"
    row = {
        "role_id": role_id,
        "url": url,
        "capabilities": capabilities or {},
        "registered_at": datetime.now(timezone.utc).isoformat(),
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        db.table("agent_endpoints").upsert(row).execute()
        return url
    except Exception:
        logger.warning(
            "register_endpoint: failed to upsert agent_endpoints row for role=%s",
            role_id,
            exc_info=True,
        )
        return None


# ---------------------------------------------------------------------------
# Discovery banner
# ---------------------------------------------------------------------------

@a2a_router.get("/")
async def a2a_root() -> dict[str, Any]:
    """A2A discovery banner — declares we speak the LF A2A 1.0 protocol."""
    return {
        "protocol": "a2a",
        "protocol_version": "1.0",
        "implementation": "a2a-sdk",  # honest disclosure of our wire impl
        "name": "quorum-a2a",
        "description": (
            "Quorum multi-agent coordination — per-role A2A endpoints. "
            "GET /a2a/agents/{role_id}/.well-known/agent-card.json to discover a role."
        ),
    }


# ---------------------------------------------------------------------------
# Architect Guidance (Quorum-specific, kept from v0)
# ---------------------------------------------------------------------------
# GuidanceRequest is the canonical model from apps.api.models — re-exported
# at the top of this module so the v0 import path
# (`from quorum_a2a.a2a_server import GuidanceRequest`) keeps working.
# On THIS route, `body.quorum_id` MUST be populated since the A2A endpoint
# has no URL path parameter; we validate that explicitly below.


@a2a_router.post("/guidance")
async def post_guidance(body: GuidanceRequest) -> dict[str, Any]:
    """Send architect guidance — via A2A if target agent known, else Supabase fallback."""
    if not body.quorum_id:
        raise HTTPException(
            status_code=422,
            detail="quorum_id is required for /a2a/guidance (no URL path param)",
        )
    client = A2AClient()

    if body.target_role_id:
        url = client.get_agent_url(body.target_role_id)
        if url:
            try:
                result = await client.send_message(
                    target_role_id=body.target_role_id,
                    message={
                        "type": "architect_guidance",
                        "quorum_id": body.quorum_id,
                        "message": body.message,
                    },
                )
                if result:
                    return {"status": "sent_a2a", "target_role_id": body.target_role_id}
            except Exception:
                logger.warning(
                    "A2A guidance dispatch failed, falling back to Supabase",
                    exc_info=True,
                )

    db = get_supabase()
    row = {
        "id": str(uuid.uuid4()),
        "quorum_id": body.quorum_id,
        "role_id": body.target_role_id or "_architect",
        "user_token": "_architect",
        "content": body.message,
        "structured_fields": {"type": "architect_guidance"},
        "tier_processed": 0,
        "role_name": "_architect_guidance",
    }
    try:
        # 12.6: bounce the sync insert to a thread.
        await aexec(db.table("contributions").insert(row))
    except Exception:
        logger.warning("Guidance Supabase insert failed", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to store guidance")

    return {"status": "stored_supabase", "contribution_id": row["id"]}


@a2a_router.get("/guidance/{quorum_id}")
async def get_guidance(quorum_id: str) -> dict[str, Any]:
    """Return recent architect guidance messages for a quorum."""
    db = get_supabase()
    # 12.6: thread-pool the sync Supabase fetch.
    result = await aexec(
        db.table("contributions")
        .select("id, content, created_at, role_id")
        .eq("quorum_id", quorum_id)
        .eq("user_token", "_architect")
        .order("created_at", desc=True)
        .limit(50)
    )
    return {"quorum_id": quorum_id, "messages": result.data}


# ---------------------------------------------------------------------------
# Per-role AgentCard (well-known)
# ---------------------------------------------------------------------------

def _load_role_and_config(role_id: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Load a role row + optional agent_configs row from the DB.

    Raises HTTPException(404) when the role doesn't exist. ``agent_configs``
    is returned as None when the table is missing or the row is absent.
    """
    db = get_supabase()
    role_result = (
        db.table("roles")
        .select("id, quorum_id, name, authority_rank, capacity")
        .eq("id", role_id)
        .maybe_single()
        .execute()
    )
    if not role_result or not role_result.data:
        raise HTTPException(status_code=404, detail="Role not found")
    role = role_result.data

    agent_config: dict[str, Any] | None = None
    try:
        cfg_result = (
            db.table("agent_configs")
            .select("system_prompt, domain_tags, agent_slug")
            .eq("role_id", role_id)
            .maybe_single()
            .execute()
        )
        if cfg_result and cfg_result.data:
            agent_config = cfg_result.data
    except Exception:
        # agent_configs may not exist on this stack (pre-10.1) — that's fine.
        logger.debug("agent_configs lookup failed for role %s", role_id, exc_info=True)

    return role, agent_config


def _resolve_base_url(request: Request) -> str:
    """Use QUORUM_A2A_BASE_URL when set, else derive from the request origin."""
    env_url = os.environ.get("QUORUM_A2A_BASE_URL")
    if env_url:
        return env_url.rstrip("/")
    # Fallback: reconstruct from request scope.  Strips trailing slash.
    return f"{request.url.scheme}://{request.url.netloc}".rstrip("/")


@a2a_router.get("/agents/{role_id}/.well-known/agent-card.json")
async def get_agent_card_v1(role_id: str, request: Request) -> JSONResponse:
    """LF A2A 1.0 canonical AgentCard endpoint.

    Returns the spec-compliant card built from the role + agent_config.
    """
    # 12.6: thread-pool the sync DB lookups inside ``_load_role_and_config``.
    role, agent_config = await aexec(lambda: _load_role_and_config(role_id))
    base_url = _resolve_base_url(request)
    card_dict = build_agent_card_dict(role, base_url=base_url, agent_config=agent_config)
    return JSONResponse(card_dict)


@a2a_router.get("/agents/{role_id}/.well-known/agent.json")
async def get_agent_card_legacy(role_id: str, request: Request) -> JSONResponse:
    """Alias for the older ``.well-known/agent.json`` path.

    Several A2A clients still probe this URL during the 1.0 migration window.
    We serve identical content to ``agent-card.json`` so both work.
    """
    return await get_agent_card_v1(role_id, request)


# Also keep the legacy /agent.json (no .well-known prefix) that the v0 router
# served, for any consumers that pinned to it before 10.3.
@a2a_router.get("/agents/{role_id}/agent.json")
async def get_agent_card_v0(role_id: str, request: Request) -> JSONResponse:
    """Pre-1.0 alias kept for backward compatibility with internal callers."""
    return await get_agent_card_v1(role_id, request)


# ---------------------------------------------------------------------------
# Per-role message:send (a.k.a. tasks/send in earlier drafts)
# ---------------------------------------------------------------------------

def _now_proto_timestamp() -> Timestamp:
    ts = Timestamp()
    ts.GetCurrentTime()
    return ts


def _extract_user_text(message: Message) -> str:
    """Extract concatenated text from a v1.0 Message's parts.

    In v1.0 the Message field is ``parts`` (renamed from ``content`` in v0.3).
    A Part may carry text, raw bytes, a url, or structured data — we only
    surface the text channel since the agent_engine consumes plain strings.
    """
    chunks: list[str] = []
    for part in message.parts:
        if part.text:
            chunks.append(part.text)
    return "\n".join(chunks).strip()


def _build_completed_response(
    *,
    context_id: str,
    task_id: str,
    reply_text: str,
) -> SendMessageResponse:
    """Build a SendMessageResponse carrying a completed Task with the reply."""
    reply_message = Message(
        message_id=str(uuid.uuid4()),
        context_id=context_id,
        task_id=task_id,
        role=Role.ROLE_AGENT,
        parts=[Part(text=reply_text)],
    )
    artifact = Artifact(
        artifact_id=str(uuid.uuid4()),
        name="reply",
        parts=[Part(text=reply_text)],
    )
    task = Task(
        id=task_id,
        context_id=context_id,
        status=TaskStatus(
            state=TaskState.TASK_STATE_COMPLETED,
            timestamp=_now_proto_timestamp(),
        ),
        history=[reply_message],
        artifacts=[artifact],
    )
    return SendMessageResponse(task=task)


async def _handle_send_message(role_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Parse a SendMessageRequest body, run the agent turn, return the response dict.

    All payloads go through the SDK's protobuf types so the wire format is
    LF-A2A-1.0 compliant.  We map the incoming Message text → our agent_engine
    via ``process_agent_turn``, then build a Task whose status is COMPLETED and
    whose artifacts/history carry the reply.
    """
    # 1. Verify role exists (and grab quorum_id for the agent turn).
    # 12.6: ``_load_role_and_config`` is sync and hits Supabase twice — bounce
    # it to a thread so the A2A endpoint doesn't stall the event loop.
    role, _ = await aexec(lambda: _load_role_and_config(role_id))
    quorum_id: str = str(role.get("quorum_id") or "")
    if not quorum_id:
        raise HTTPException(status_code=400, detail="Role has no quorum_id")

    # 2. Parse the SendMessageRequest body into a typed proto.
    proto_request = SendMessageRequest()
    try:
        ParseDict(body, proto_request, ignore_unknown_fields=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Invalid A2A SendMessageRequest body: {exc}"
        ) from None

    if not proto_request.HasField("message"):
        raise HTTPException(status_code=400, detail="SendMessageRequest missing message")

    incoming = proto_request.message
    user_text = _extract_user_text(incoming) or "(empty)"

    context_id = incoming.context_id or str(uuid.uuid4())
    task_id = incoming.task_id or str(uuid.uuid4())
    # Treat context_id as the station_id for our agent_engine — a stable per-
    # conversation identifier on the A2A side maps to our per-station thread.
    station_id = context_id

    # 3. Drive the agent turn.  Use the same engine humans hit on /ask.
    try:
        from agent_engine import process_agent_turn
        from llm import llm_provider

        reply, _reply_msg_id, _reply_tags = await process_agent_turn(
            quorum_id=quorum_id,
            role_id=role_id,
            station_id=station_id,
            user_message=user_text,
            supabase_client=get_supabase(),
            llm_provider=llm_provider,
        )
    except Exception:  # noqa: BLE001
        # NEVER include the exception text in the wire response — the A2A
        # endpoint is unauthenticated and the SendMessageResponse Task
        # artifact is serialized straight back over the wire. Leaking
        # ``str(exc)`` here can expose partial API keys, internal URLs, DB
        # row contents, or table names. Operators still get the full trace
        # via ``exc_info=True`` in the log line below.
        logger.error("A2A task-send: agent turn failed", exc_info=True)
        reply = "Agent turn unavailable. Please retry."

    # 4. Wrap reply as a SendMessageResponse and serialize for the wire.
    response_proto = _build_completed_response(
        context_id=context_id,
        task_id=task_id,
        reply_text=reply,
    )
    return MessageToDict(response_proto, preserving_proto_field_name=False)


@a2a_router.post("/agents/{role_id}/message:send")
async def post_message_send(role_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """LF A2A 1.0 canonical task-send endpoint.

    Body shape::

        {
          "message": {
            "messageId": "...",
            "role": "ROLE_USER",
            "content": [{"text": "..."}]
          }
        }

    Returns a serialized ``SendMessageResponse`` with the completed Task and
    the agent's reply as a TextPart artifact.
    """
    return await _handle_send_message(role_id, body)


@a2a_router.post("/agents/{role_id}/tasks/send")
async def post_tasks_send(role_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Alias matching the developer checklist's task-send naming.

    Pre-v1.0 A2A drafts called this endpoint ``tasks/send`` (or ``tasks:send``).
    We accept both shapes — an older ``tasks/send`` body that puts the message
    at the top level OR a ``message`` key — and forward to the same handler.

    Older v0.3 messages used ``content`` instead of ``parts``; we accept the
    legacy shape and rewrite it to v1.0 ``parts``.
    """
    # Normalize older shapes: accept {"id": ..., "message": {...}} OR a bare
    # message at the top level.
    if "message" not in body and (
        "content" in body or "role" in body or "parts" in body
    ):
        body = {"message": body}
    msg = body.get("message")
    if isinstance(msg, dict) and "content" in msg and "parts" not in msg:
        msg["parts"] = msg.pop("content")
    return await _handle_send_message(role_id, body)
