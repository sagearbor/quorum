"""All API routes from CONTRACT.md."""

from __future__ import annotations

import hashlib
import json
import uuid

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from .database import get_supabase
from .llm import llm_provider
from .models import (
    ContributeRequest,
    ContributeResponse,
    CreateEventRequest,
    CreateEventResponse,
    CreateQuorumRequest,
    CreateQuorumResponse,
    HealthMetrics,
    QuorumStateResponse,
    ResolveRequest,
    ResolveResponse,
)
from .ws_manager import manager

router = APIRouter()


# ---------------------------------------------------------------------------
# POST /events
# ---------------------------------------------------------------------------
@router.post("/events", response_model=CreateEventResponse)
async def create_event(body: CreateEventRequest):
    db = get_supabase()
    event_id = str(uuid.uuid4())
    row = {
        "id": event_id,
        "name": body.name,
        "slug": body.slug,
        "access_code": body.access_code,
        "max_active_quorums": body.max_active_quorums,
    }
    result = db.table("events").insert(row).execute()
    created = result.data[0]
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
    db = get_supabase()

    # Verify event exists
    event = db.table("events").select("id, slug").eq("id", event_id).single().execute()
    if not event.data:
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
    db.table("quorums").insert(quorum_row).execute()

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
        db.table("roles").insert(role_row).execute()

    share_url = f"/event/{event.data['slug']}/quorum/{quorum_id}"
    return CreateQuorumResponse(id=quorum_id, status="open", share_url=share_url)


# ---------------------------------------------------------------------------
# POST /quorums/{quorum_id}/contribute
# ---------------------------------------------------------------------------
@router.post("/quorums/{quorum_id}/contribute", response_model=ContributeResponse)
async def contribute(quorum_id: str, body: ContributeRequest):
    db = get_supabase()

    # Verify quorum exists and is not resolved/archived
    quorum = db.table("quorums").select("id, status").eq("id", quorum_id).single().execute()
    if not quorum.data:
        raise HTTPException(status_code=404, detail="Quorum not found")
    if quorum.data["status"] in ("resolved", "archived"):
        raise HTTPException(status_code=409, detail="Quorum is no longer accepting contributions")

    # Activate quorum on first contribution
    if quorum.data["status"] == "open":
        db.table("quorums").update({"status": "active"}).eq("id", quorum_id).execute()

    # Tier-1 processing (deterministic — stub for now)
    tier = 1
    await llm_provider.complete(body.content, tier=1)

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
    db.table("contributions").insert(contrib_row).execute()

    # Broadcast to live WebSocket subscribers
    await manager.broadcast(quorum_id, {
        "type": "contribution",
        "data": contrib_row,
    })

    return ContributeResponse(contribution_id=contribution_id, tier_processed=tier)


# ---------------------------------------------------------------------------
# GET /quorums/{quorum_id}/state
# ---------------------------------------------------------------------------
@router.get("/quorums/{quorum_id}/state", response_model=QuorumStateResponse)
async def get_quorum_state(quorum_id: str):
    db = get_supabase()

    quorum = db.table("quorums").select("*").eq("id", quorum_id).single().execute()
    if not quorum.data:
        raise HTTPException(status_code=404, detail="Quorum not found")

    contributions = (
        db.table("contributions")
        .select("*")
        .eq("quorum_id", quorum_id)
        .order("created_at")
        .execute()
    )

    artifact_result = (
        db.table("artifacts").select("*").eq("quorum_id", quorum_id).execute()
    )
    artifact = artifact_result.data[0] if artifact_result.data else None

    roles = db.table("roles").select("id").eq("quorum_id", quorum_id).execute()

    # Compute active roles (distinct user_tokens per role)
    role_participants: dict[str, set[str]] = {}
    for c in contributions.data:
        role_participants.setdefault(c["role_id"], set()).add(c["user_token"])

    active_roles = [
        {"role_id": r["id"], "participant_count": len(role_participants.get(r["id"], set()))}
        for r in roles.data
    ]

    # Compute health score from basic metrics
    total_roles = len(roles.data)
    covered_roles = sum(1 for r in roles.data if r["id"] in role_participants)
    role_coverage = (covered_roles / total_roles * 100) if total_roles > 0 else 0

    metrics = HealthMetrics(role_coverage_pct=role_coverage)
    health_score = (
        metrics.completion_pct * 0.3
        + metrics.consensus_score * 0.2
        + metrics.critical_path_score * 0.2
        + metrics.role_coverage_pct * 0.2
        + metrics.blocker_score * 0.1
    )

    return QuorumStateResponse(
        quorum=quorum.data,
        contributions=contributions.data,
        artifact=artifact,
        health_score=round(health_score, 2),
        active_roles=active_roles,
    )


# ---------------------------------------------------------------------------
# POST /quorums/{quorum_id}/resolve
# ---------------------------------------------------------------------------
@router.post("/quorums/{quorum_id}/resolve", response_model=ResolveResponse)
async def resolve_quorum(quorum_id: str, body: ResolveRequest):
    db = get_supabase()

    quorum = (
        db.table("quorums").select("id, status").eq("id", quorum_id).single().execute()
    )
    if not quorum.data:
        raise HTTPException(status_code=404, detail="Quorum not found")
    if quorum.data["status"] == "resolved":
        raise HTTPException(status_code=409, detail="Quorum already resolved")

    # Gather contributions for synthesis
    contributions = (
        db.table("contributions")
        .select("*")
        .eq("quorum_id", quorum_id)
        .order("created_at")
        .execute()
    )

    # Tier-3 synthesis (stub — real impl in Stream E)
    synthesis_prompt = json.dumps([c["content"] for c in contributions.data])
    synthesized = await llm_provider.complete(synthesis_prompt, tier=3)

    content_hash = hashlib.sha256(synthesized.encode()).hexdigest()[:16]
    artifact_id = str(uuid.uuid4())

    # Check for existing artifact (optimistic locking via version + CAS)
    existing = db.table("artifacts").select("id, version").eq("quorum_id", quorum_id).execute()

    if existing.data:
        current = existing.data[0]
        new_version = current["version"] + 1
        # CAS: update only if version hasn't changed
        update_result = (
            db.table("artifacts")
            .update({
                "version": new_version,
                "content_hash": content_hash,
                "sections": [{"content": synthesized, "source_contributions": [c["id"] for c in contributions.data]}],
                "status": "draft",
            })
            .eq("id", current["id"])
            .eq("version", current["version"])  # CAS condition
            .execute()
        )
        if not update_result.data:
            raise HTTPException(status_code=409, detail="Artifact version conflict — retry")
        artifact_id = current["id"]
    else:
        artifact_row = {
            "id": artifact_id,
            "quorum_id": quorum_id,
            "version": 1,
            "content_hash": content_hash,
            "sections": [{"content": synthesized, "source_contributions": [c["id"] for c in contributions.data]}],
            "status": "draft",
        }
        db.table("artifacts").insert(artifact_row).execute()

    # Mark quorum resolved
    db.table("quorums").update({"status": "resolved"}).eq("id", quorum_id).execute()

    # Broadcast artifact update
    await manager.broadcast(quorum_id, {
        "type": "artifact_update",
        "data": {"artifact_id": artifact_id, "status": "draft", "content_hash": content_hash},
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
            # Keep connection alive; client can send pings or role_join messages
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
