"""All API routes from CONTRACT.md — wired to quorum_llm pipeline."""

from __future__ import annotations

import json
import logging
import uuid

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

from .database import get_supabase
from .health import calculate_health_score
from .llm import llm_provider
from .architect_agent import generate_roles, send_guidance
from .models import (
    AIStartRequest,
    AIStartResponse,
    ContributeRequest,
    ContributeResponse,
    CreateEventRequest,
    CreateEventResponse,
    CreateQuorumRequest,
    CreateQuorumResponse,
    GenerateRolesRequest,
    GenerateRolesResponse,
    GuidanceRequest,
    GuidanceResponse,
    QuorumStateResponse,
    ResolveRequest,
    ResolveResponse,
)
from .ws_manager import manager

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
    db.table("contributions").insert(contrib_row).execute()

    # Broadcast contribution
    await manager.broadcast(quorum_id, {
        "type": "contribution",
        "data": contrib_row,
    })

    # --- Tier 2: conflict detection if >=2 contributions on same field ---
    all_contribs = (
        db.table("contributions")
        .select("*")
        .eq("quorum_id", quorum_id)
        .order("created_at")
        .execute()
    )
    roles_data = (
        db.table("roles").select("*").eq("quorum_id", quorum_id).execute()
    )

    llm_contribs = _db_contribs_to_llm(all_contribs.data)
    llm_roles = _db_roles_to_llm(roles_data.data)

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
        db.table("contributions").update({"tier_processed": tier}).eq("id", contribution_id).execute()

    # --- Recalculate health score ---
    artifact_result = db.table("artifacts").select("*").eq("quorum_id", quorum_id).execute()
    artifact = artifact_result.data[0] if artifact_result.data else None

    health_score, metrics = calculate_health_score(
        roles_data.data, all_contribs.data, artifact,
    )

    # Save health score to quorum
    db.table("quorums").update({"heat_score": health_score}).eq("id", quorum_id).execute()

    # Broadcast health update
    await manager.broadcast(quorum_id, {
        "type": "health_update",
        "data": {"score": health_score, "metrics": metrics},
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

    roles = db.table("roles").select("*").eq("quorum_id", quorum_id).execute()

    # Compute active roles (distinct user_tokens per role)
    role_participants: dict[str, set[str]] = {}
    for c in contributions.data:
        role_participants.setdefault(c["role_id"], set()).add(c["user_token"])

    active_roles = [
        {"role_id": r["id"], "participant_count": len(role_participants.get(r["id"], set()))}
        for r in roles.data
    ]

    health_score, _ = calculate_health_score(
        roles.data, contributions.data, artifact,
    )

    return QuorumStateResponse(
        quorum=quorum.data,
        contributions=contributions.data,
        artifact=artifact,
        health_score=health_score,
        active_roles=active_roles,
    )


# ---------------------------------------------------------------------------
# POST /quorums/{quorum_id}/resolve
# ---------------------------------------------------------------------------
@router.post("/quorums/{quorum_id}/resolve", response_model=ResolveResponse)
async def resolve_quorum(quorum_id: str, body: ResolveRequest):
    db = get_supabase()

    quorum_result = (
        db.table("quorums").select("*").eq("id", quorum_id).single().execute()
    )
    if not quorum_result.data:
        raise HTTPException(status_code=404, detail="Quorum not found")
    if quorum_result.data["status"] == "resolved":
        raise HTTPException(status_code=409, detail="Quorum already resolved")

    # Gather all contributions + roles
    contributions = (
        db.table("contributions")
        .select("*")
        .eq("quorum_id", quorum_id)
        .order("created_at")
        .execute()
    )
    roles_data = (
        db.table("roles").select("*").eq("quorum_id", quorum_id).execute()
    )

    llm_roles = _db_roles_to_llm(roles_data.data)
    llm_contribs = _db_contribs_to_llm(contributions.data)

    # Build quorum context for artifact generation
    llm_quorum = LLMQuorum(
        id=quorum_id,
        title=quorum_result.data["title"],
        description=quorum_result.data.get("description", ""),
        roles=llm_roles,
        status=quorum_result.data["status"],
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
    existing = db.table("artifacts").select("id, version").eq("quorum_id", quorum_id).execute()

    # Determine status: PENDING_RATIFICATION if any roles have 0 contributions
    contributing_role_ids = {c["role_id"] for c in contributions.data}
    all_role_ids = {r["id"] for r in roles_data.data}
    missing_roles = all_role_ids - contributing_role_ids
    artifact_status = "pending_ratification" if missing_roles else "draft"

    if existing.data:
        current = existing.data[0]
        new_version = current["version"] + 1
        update_result = (
            db.table("artifacts")
            .update({
                "version": new_version,
                "content_hash": content_hash,
                "sections": sections_json,
                "status": artifact_status,
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
            "sections": sections_json,
            "status": artifact_status,
        }
        db.table("artifacts").insert(artifact_row).execute()

    # Mark quorum resolved
    db.table("quorums").update({"status": "resolved"}).eq("id", quorum_id).execute()

    # Broadcast artifact update
    await manager.broadcast(quorum_id, {
        "type": "artifact_update",
        "data": {
            "artifact_id": artifact_id,
            "status": artifact_status,
            "content_hash": content_hash,
            "sections": sections_json,
        },
    })

    download_url = f"/artifacts/{artifact_id}/download"
    return ResolveResponse(artifact_id=artifact_id, download_url=download_url)


# ---------------------------------------------------------------------------
# POST /events/{event_id}/architect/generate-roles
# ---------------------------------------------------------------------------
@router.post(
    "/events/{event_id}/architect/generate-roles",
    response_model=GenerateRolesResponse,
)
async def architect_generate_roles(event_id: str, body: GenerateRolesRequest):
    db = get_supabase()

    # Verify event exists
    event = db.table("events").select("id").eq("id", event_id).single().execute()
    if not event.data:
        raise HTTPException(status_code=404, detail="Event not found")

    roles = await generate_roles(body.problem)
    return GenerateRolesResponse(
        roles=[r.model_dump() for r in roles],
        problem_summary=body.problem[:100],
    )


# ---------------------------------------------------------------------------
# POST /events/{event_id}/architect/ai-start
# ---------------------------------------------------------------------------
@router.post(
    "/events/{event_id}/architect/ai-start",
    response_model=AIStartResponse,
)
async def architect_ai_start(event_id: str, body: AIStartRequest):
    db = get_supabase()

    # Verify event exists
    event = db.table("events").select("id, slug").eq("id", event_id).single().execute()
    if not event.data:
        raise HTTPException(status_code=404, detail="Event not found")

    quorum_id = str(uuid.uuid4())
    quorum_row = {
        "id": quorum_id,
        "event_id": event_id,
        "title": body.quorum_title,
        "description": body.problem[:500],
        "status": "open",
        "carousel_mode": "multi-view",
    }
    db.table("quorums").insert(quorum_row).execute()

    # Insert roles from AI suggestions
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
            "prompt_template": [
                {"field_name": "focus", "prompt": role_def.suggested_prompt_focus}
            ],
            "fallback_chain": [],
        }
        db.table("roles").insert(role_row).execute()

    # Auto-activate if mode is "auto"
    if body.mode == "auto":
        db.table("quorums").update({"status": "active"}).eq("id", quorum_id).execute()

    share_url = f"/event/{event.data['slug']}/quorum/{quorum_id}"
    return AIStartResponse(quorum_id=quorum_id, share_url=share_url, mode=body.mode)


# ---------------------------------------------------------------------------
# POST /quorums/{quorum_id}/architect/guidance
# ---------------------------------------------------------------------------
@router.post(
    "/quorums/{quorum_id}/architect/guidance",
    response_model=GuidanceResponse,
)
async def architect_guidance(quorum_id: str, body: GuidanceRequest):
    db = get_supabase()

    # Verify quorum exists
    quorum = db.table("quorums").select("id").eq("id", quorum_id).single().execute()
    if not quorum.data:
        raise HTTPException(status_code=404, detail="Quorum not found")

    result = await send_guidance(quorum_id, body.message, body.target_role_id)
    return GuidanceResponse(**result)


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
