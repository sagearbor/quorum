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
from .models import (
    ContributeRequest,
    ContributeResponse,
    CreateEventRequest,
    CreateEventResponse,
    CreateQuorumRequest,
    CreateQuorumResponse,
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

async def resolve_dependencies(quorum_id: str, completed_role_id: str, db) -> None:
    """Check if any blocked roles can now be unblocked.

    For each role in the quorum whose blocked_by list contains completed_role_id,
    check if ALL items in its blocked_by now have >= 1 accepted contribution.
    If yes, update role status to 'active' and broadcast a WebSocket event.
    """
    roles = db.table("roles").select("*").eq("quorum_id", quorum_id).execute()
    contributions = (
        db.table("contributions").select("*").eq("quorum_id", quorum_id).execute()
    )

    # Build set of role_ids that have at least one contribution
    roles_with_contributions = {c["role_id"] for c in contributions.data}

    for role in roles.data:
        blocked_by = role.get("blocked_by") or []
        if not blocked_by:
            continue
        if role.get("status") != "blocked":
            continue
        if completed_role_id not in blocked_by:
            continue

        # Check if ALL blocking roles now have contributions
        all_satisfied = all(dep_id in roles_with_contributions for dep_id in blocked_by)
        if all_satisfied:
            db.table("roles").update({"status": "active"}).eq("id", role["id"]).execute()
            await manager.broadcast(quorum_id, {
                "type": "role_unblocked",
                "role_id": role["id"],
                "role_name": role["name"],
            })


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

    # Insert roles — two passes: first create all roles to get IDs, then insert.
    # blocked_by values arrive as position indices (integers) referencing other
    # roles in the request list.  We resolve them to real UUIDs after assigning IDs.
    role_ids: list[str] = []
    for _ in body.roles:
        role_ids.append(str(uuid.uuid4()))

    for idx, role_def in enumerate(body.roles):
        # Resolve index-based blocked_by to real UUIDs
        resolved_blocked_by = [role_ids[int(i)] for i in role_def.blocked_by]
        status = "blocked" if resolved_blocked_by else "active"

        role_row = {
            "id": role_ids[idx],
            "quorum_id": quorum_id,
            "name": role_def.name,
            "capacity": (
                str(role_def.capacity) if role_def.capacity != "unlimited" else "unlimited"
            ),
            "authority_rank": role_def.authority_rank,
            "prompt_template": [f.model_dump() for f in role_def.prompt_template],
            "fallback_chain": role_def.fallback_chain,
            "blocked_by": resolved_blocked_by,
            "status": status,
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

    # --- Resolve blocked_by dependencies ---
    await resolve_dependencies(quorum_id, body.role_id, db)

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
# GET /quorums/{quorum_id}/role-status
# ---------------------------------------------------------------------------
@router.get("/quorums/{quorum_id}/role-status")
async def get_role_status(quorum_id: str):
    db = get_supabase()

    roles = db.table("roles").select("*").eq("quorum_id", quorum_id).execute()
    if not roles.data:
        raise HTTPException(status_code=404, detail="No roles found for quorum")

    contributions = (
        db.table("contributions").select("*").eq("quorum_id", quorum_id).execute()
    )

    # Build role_id -> name lookup and contribution counts
    role_map = {r["id"]: r for r in roles.data}
    contrib_counts: dict[str, int] = {}
    for c in contributions.data:
        contrib_counts[c["role_id"]] = contrib_counts.get(c["role_id"], 0) + 1

    result = []
    for role in roles.data:
        blocked_by = role.get("blocked_by") or []
        blocked_by_names = [role_map[bid]["name"] for bid in blocked_by if bid in role_map]
        result.append({
            "role_id": role["id"],
            "name": role["name"],
            "status": role.get("status", "active"),
            "blocked_by_names": blocked_by_names,
            "contributions_count": contrib_counts.get(role["id"], 0),
        })

    return result


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
