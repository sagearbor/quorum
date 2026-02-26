"""All API routes from CONTRACT.md — wired to quorum_llm pipeline.

Uses DBProvider + RealtimeProvider abstractions for Supabase/Azure switchability.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from quorum_llm import (
    Contribution as LLMContribution,
    LLMTier,
    Quorum as LLMQuorum,
    Role as LLMRole,
    detect_conflicts,
    generate_artifact,
    synthesize_contributions,
)

from .health import calculate_health_score
from .llm import llm_provider
from .models import (
    ContributeRequest,
    ContributeResponse,
    CreateEventRequest,
    CreateEventResponse,
    CreateQuorumRequest,
    CreateQuorumResponse,
    PollResponse,
    QuorumStateResponse,
    ResolveRequest,
    ResolveResponse,
)
from .realtime import get_realtime_provider
from .ws_manager import manager

# Ensure packages/ is importable for db provider
_packages_path = str(Path(__file__).resolve().parent.parent.parent / "packages")
if _packages_path not in sys.path:
    sys.path.insert(0, _packages_path)

from db import get_db_provider

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers: convert DB rows → quorum_llm data models
# ---------------------------------------------------------------------------

def _db_roles_to_llm(roles_data: list[dict]) -> list[LLMRole]:
    return [
        LLMRole(
            id=r["id"],
            name=r["name"],
            authority_rank=r.get("authority_rank", 0),
            capacity=r.get("capacity", "unlimited"),
        )
        for r in roles_data
    ]


def _db_contribs_to_llm(contribs_data: list[dict]) -> list[LLMContribution]:
    return [
        LLMContribution(
            id=c["id"],
            role_id=c["role_id"],
            content=c["content"],
            structured_fields=c.get("structured_fields") or {},
            tier_processed=c.get("tier_processed", 1),
        )
        for c in contribs_data
    ]


def _compute_etag(data: dict) -> str:
    """Compute a simple ETag from JSON-serialized state."""
    raw = json.dumps(data, sort_keys=True, default=str)
    return hashlib.md5(raw.encode()).hexdigest()


# ---------------------------------------------------------------------------
# POST /events
# ---------------------------------------------------------------------------
@router.post("/events", response_model=CreateEventResponse)
async def create_event(body: CreateEventRequest):
    db = get_db_provider()
    event_id = str(uuid.uuid4())
    row = {
        "id": event_id,
        "name": body.name,
        "slug": body.slug,
        "access_code": body.access_code,
        "max_active_quorums": body.max_active_quorums,
    }
    created = await db.create_event(row)
    return CreateEventResponse(
        id=created["id"],
        slug=created["slug"],
        created_at=created["created_at"],
    )


# ---------------------------------------------------------------------------
# POST /events/{event_id}/quorums
# ---------------------------------------------------------------------------
@router.post("/events/{event_id}/quorums", response_model=CreateQuorumResponse)
async def create_quorum(event_id: str, body: CreateQuorumRequest):
    db = get_db_provider()

    # Verify event exists
    event = await db.get_event_by_id(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    quorum_id = str(uuid.uuid4())
    quorum_row = {
        "id": quorum_id,
        "event_id": event_id,
        "title": body.title,
        "description": body.description,
        "status": "open",
        "carousel_mode": body.carousel_mode.value,
    }
    await db.create_quorum(quorum_row)

    # Insert roles
    for role_def in body.roles:
        role_id = str(uuid.uuid4())
        role_row = {
            "id": role_id,
            "quorum_id": quorum_id,
            "name": role_def.name,
            "capacity": (
                str(role_def.capacity) if role_def.capacity != "unlimited" else "unlimited"
            ),
            "authority_rank": role_def.authority_rank,
            "prompt_template": [f.model_dump() for f in role_def.prompt_template],
            "fallback_chain": role_def.fallback_chain,
        }
        await db.create_role(role_row)

    share_url = f"/event/{event['slug']}/quorum/{quorum_id}"
    return CreateQuorumResponse(id=quorum_id, status="open", share_url=share_url)


# ---------------------------------------------------------------------------
# POST /quorums/{quorum_id}/contribute
# ---------------------------------------------------------------------------
@router.post("/quorums/{quorum_id}/contribute", response_model=ContributeResponse)
async def contribute(quorum_id: str, body: ContributeRequest):
    db = get_db_provider()
    rt = get_realtime_provider()

    # Verify quorum exists and is not resolved/archived
    quorum = await db.get_quorum(quorum_id)
    if not quorum:
        raise HTTPException(status_code=404, detail="Quorum not found")
    if quorum["status"] in ("resolved", "archived"):
        raise HTTPException(status_code=409, detail="Quorum is no longer accepting contributions")

    # Activate quorum on first contribution
    if quorum["status"] == "open":
        await db.update_quorum(quorum_id, {"status": "active"})

    # --- Tier 1: keyword extraction on every contribution (deterministic) ---
    tier = 1
    await llm_provider.complete(body.content, tier=LLMTier.KEYWORD)

    contribution_id = str(uuid.uuid4())
    contrib_row = {
        "id": contribution_id,
        "quorum_id": quorum_id,
        "role_id": body.role_id,
        "user_token": body.user_token,
        "content": body.content,
        "structured_fields": body.structured_fields,
        "tier_processed": tier,
    }
    await db.add_contribution(contrib_row)

    # Broadcast contribution
    await rt.broadcast(quorum_id, "contribution", contrib_row)

    # --- Tier 2: conflict detection if >=2 contributions on same field ---
    all_contribs = await db.get_contributions(quorum_id)
    roles_data = await db.get_roles(quorum_id)

    llm_contribs = _db_contribs_to_llm(all_contribs)
    llm_roles = _db_roles_to_llm(roles_data)

    # Check for overlapping structured fields that need Tier 2
    fields_lists = [c.structured_fields for c in llm_contribs]
    from quorum_llm import find_overlapping_fields

    overlaps = find_overlapping_fields(fields_lists)
    if overlaps:
        tier = 2
        try:
            conflicts = await detect_conflicts(llm_contribs, llm_roles, llm_provider)
            if conflicts:
                logger.info(
                    "Tier 2: detected %d conflicts in quorum %s",
                    len(conflicts), quorum_id,
                )
        except Exception:
            logger.warning("Tier 2 conflict detection failed for quorum %s", quorum_id, exc_info=True)

        # Update contribution tier
        await db.update_contribution(contribution_id, {"tier_processed": tier})

    # --- Recalculate health score ---
    artifact = await db.get_artifact(quorum_id)

    health_score, metrics = calculate_health_score(
        roles_data, all_contribs, artifact,
    )

    # Save health score to quorum
    await db.update_quorum(quorum_id, {"heat_score": health_score})

    # Broadcast health update
    await rt.broadcast(quorum_id, "health_update", {"score": health_score, "metrics": metrics})

    return ContributeResponse(contribution_id=contribution_id, tier_processed=tier)


# ---------------------------------------------------------------------------
# GET /quorums/{quorum_id}/state
# ---------------------------------------------------------------------------
@router.get("/quorums/{quorum_id}/state", response_model=QuorumStateResponse)
async def get_quorum_state(quorum_id: str):
    db = get_db_provider()

    state = await db.get_quorum_state(quorum_id)
    if not state:
        raise HTTPException(status_code=404, detail="Quorum not found")

    quorum = state["quorum"]
    contributions = state["contributions"]
    roles = state["roles"]
    artifact = state["artifact"]

    # Compute active roles (distinct user_tokens per role)
    role_participants: dict[str, set[str]] = {}
    for c in contributions:
        role_participants.setdefault(c["role_id"], set()).add(c["user_token"])

    active_roles = [
        {"role_id": r["id"], "participant_count": len(role_participants.get(r["id"], set()))}
        for r in roles
    ]

    health_score, _ = calculate_health_score(roles, contributions, artifact)

    return QuorumStateResponse(
        quorum=quorum,
        contributions=contributions,
        artifact=artifact,
        health_score=health_score,
        active_roles=active_roles,
    )


# ---------------------------------------------------------------------------
# GET /quorums/{quorum_id}/poll — polling fallback for Azure SQL mode
# ---------------------------------------------------------------------------
@router.get("/quorums/{quorum_id}/poll", response_model=PollResponse)
async def poll_quorum(quorum_id: str):
    """Returns quorum state + ETag for polling clients."""
    db = get_db_provider()

    state = await db.get_quorum_state(quorum_id)
    if not state:
        raise HTTPException(status_code=404, detail="Quorum not found")

    quorum = state["quorum"]
    contributions = state["contributions"]
    roles = state["roles"]
    artifact = state["artifact"]

    # Compute active roles
    role_participants: dict[str, set[str]] = {}
    for c in contributions:
        role_participants.setdefault(c["role_id"], set()).add(c["user_token"])

    active_roles = [
        {"role_id": r["id"], "participant_count": len(role_participants.get(r["id"], set()))}
        for r in roles
    ]

    health_score, metrics = calculate_health_score(roles, contributions, artifact)

    response_data = {
        "quorum": quorum,
        "contributions": contributions,
        "artifact": artifact,
        "health_score": health_score,
        "active_roles": active_roles,
    }

    etag = _compute_etag(response_data)

    return PollResponse(
        quorum=quorum,
        contributions=contributions,
        artifact=artifact,
        health_score=health_score,
        active_roles=active_roles,
        etag=etag,
    )


# ---------------------------------------------------------------------------
# POST /quorums/{quorum_id}/resolve
# ---------------------------------------------------------------------------
@router.post("/quorums/{quorum_id}/resolve", response_model=ResolveResponse)
async def resolve_quorum(quorum_id: str, body: ResolveRequest):
    db = get_db_provider()
    rt = get_realtime_provider()

    quorum = await db.get_quorum(quorum_id)
    if not quorum:
        raise HTTPException(status_code=404, detail="Quorum not found")
    if quorum["status"] == "resolved":
        raise HTTPException(status_code=409, detail="Quorum already resolved")

    # Gather all contributions + roles
    contributions = await db.get_contributions(quorum_id)
    roles_data = await db.get_roles(quorum_id)

    llm_roles = _db_roles_to_llm(roles_data)
    llm_contribs = _db_contribs_to_llm(contributions)

    # Build quorum context for artifact generation
    llm_quorum = LLMQuorum(
        id=quorum_id,
        title=quorum["title"],
        description=quorum.get("description", ""),
        roles=llm_roles,
        status=quorum["status"],
    )

    # --- Tier 3: full artifact synthesis ---
    artifact_content = await generate_artifact(llm_quorum, llm_contribs, llm_provider)

    # Serialize sections for DB storage
    sections_json = [
        {
            "title": s.title,
            "content": s.content,
            "source_contribution_ids": s.source_contribution_ids,
        }
        for s in artifact_content.sections
    ]
    content_hash = artifact_content.content_hash

    artifact_id = str(uuid.uuid4())

    # Check for existing artifact (optimistic locking via version + CAS)
    existing = await db.get_artifact(quorum_id)

    # Determine status: PENDING_RATIFICATION if any roles have 0 contributions
    contributing_role_ids = {c["role_id"] for c in contributions}
    all_role_ids = {r["id"] for r in roles_data}
    missing_roles = all_role_ids - contributing_role_ids
    artifact_status = "pending_ratification" if missing_roles else "draft"

    if existing:
        new_version = existing["version"] + 1
        updated = await db.update_artifact(
            existing["id"],
            existing["version"],
            {
                "version": new_version,
                "content_hash": content_hash,
                "sections": sections_json,
                "status": artifact_status,
            },
        )
        if not updated:
            raise HTTPException(status_code=409, detail="Artifact version conflict — retry")
        artifact_id = existing["id"]
    else:
        artifact_row = {
            "id": artifact_id,
            "quorum_id": quorum_id,
            "version": 1,
            "content_hash": content_hash,
            "sections": sections_json,
            "status": artifact_status,
        }
        await db.create_artifact(artifact_row)

    # Mark quorum resolved
    await db.update_quorum(quorum_id, {"status": "resolved"})

    # Broadcast artifact update
    await rt.broadcast(quorum_id, "artifact_update", {
        "artifact_id": artifact_id,
        "status": artifact_status,
        "content_hash": content_hash,
        "sections": sections_json,
    })

    download_url = f"/artifacts/{artifact_id}/download"
    return ResolveResponse(artifact_id=artifact_id, download_url=download_url)


# ---------------------------------------------------------------------------
# WS /quorums/{quorum_id}/live
# ---------------------------------------------------------------------------
@router.websocket("/quorums/{quorum_id}/live")
async def quorum_live(websocket: WebSocket, quorum_id: str):
    await manager.connect(quorum_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "role_join":
                await manager.broadcast(quorum_id, {
                    "type": "role_join",
                    "data": msg.get("data", {}),
                })
    except WebSocketDisconnect:
        manager.disconnect(quorum_id, websocket)
