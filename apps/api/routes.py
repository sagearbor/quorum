"""All API routes from CONTRACT.md — wired to quorum_llm pipeline."""

from __future__ import annotations

import json
import logging
import pathlib
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

# TODO: migrate to DatabaseProvider from db/factory.py
from coordination.factory import get_coordination_backend
from database import get_supabase
from health import calculate_health_score
from llm import llm_provider
from architect_agent import generate_roles, send_guidance
from models import (
    A2ARequestCreate,
    A2ARequestResponse,
    AIStartRequest,
    AIStartResponse,
    AskRequest,
    AskResponse,
    ContributeRequest,
    ContributeResponse,
    CreateEventRequest,
    CreateEventResponse,
    CreateQuorumRequest,
    CreateQuorumResponse,
    DocumentCreateRequest,
    DocumentResponse,
    DocumentUpdateRequest,
    DocumentUpdateResponse,
    GenerateRolesRequest,
    GenerateRolesResponse,
    GuidanceRequest,
    GuidanceResponse,
    InsightResponse,
    QuorumStateResponse,
    ResolveRequest,
    ResolveResponse,
    StationMessageResponse,
)
from agent_engine import process_a2a_request, process_agent_turn
from document_engine import create_document, detect_oscillation, update_document
from ws_manager import manager

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
# GET /events
# ---------------------------------------------------------------------------
@router.get("/events")
async def list_events():
    """List all events, newest first.

    Returns a flat list of event rows — clients use the slug to navigate to
    /event/{slug}.  No quorum data is embedded here; the event page fetches
    quorums separately.
    """
    db = get_supabase()
    result = db.table("events").select("*").order("created_at", desc=True).execute()
    return result.data or []


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
        "created_by": "local-dev",
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

    # Auto-seed agent documents (non-fatal — quorum is already created)
    try:
        seed_path = (
            pathlib.Path(__file__).resolve().parent.parent.parent
            / "seed"
            / "clinical-trial-documents.json"
        )
        if seed_path.exists():
            with seed_path.open() as fh:
                seed_data = json.load(fh)
            for doc in seed_data.get("documents", []):
                doc_id = str(uuid.uuid4())
                doc_row = {
                    "id": doc_id,
                    "quorum_id": quorum_id,
                    "title": doc["title"],
                    "doc_type": doc["doc_type"],
                    "format": "json",
                    "content": doc["content"],
                    "status": "active",
                    "version": 1,
                    "tags": doc.get("tags", []),
                    "created_by_role_id": None,
                }
                db.table("agent_documents").insert(doc_row).execute()
            logger.info("Auto-seeded %d documents for quorum %s", len(seed_data.get("documents", [])), quorum_id)
    except Exception:
        logger.warning("Auto-seed documents failed for quorum %s (non-fatal)", quorum_id, exc_info=True)

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

    # Submit via coordination backend (supabase or a2a)
    backend = get_coordination_backend()
    contrib_row = await backend.submit_contribution(
        quorum_id=quorum_id,
        role_id=body.role_id,
        user_token=body.user_token,
        content=body.content,
        structured_fields=body.structured_fields,
    )
    contribution_id = contrib_row["id"]

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

    # --- Agent facilitator turn (optional — requires station_id) ---
    facilitator_reply: str | None = None
    facilitator_message_id: str | None = None
    facilitator_tags: list[str] | None = None

    if body.station_id:
        try:
            facilitator_reply, facilitator_message_id, facilitator_tags = (
                await process_agent_turn(
                    quorum_id=quorum_id,
                    role_id=body.role_id,
                    station_id=body.station_id,
                    user_message=body.content,
                    supabase_client=db,
                    llm_provider=llm_provider,
                )
            )
            # Broadcast facilitator reply over WebSocket so the frontend can
            # update the conversation thread in real time.
            await manager.broadcast(quorum_id, {
                "type": "facilitator_reply",
                "data": {
                    "station_id": body.station_id,
                    "role_id": body.role_id,
                    "content": facilitator_reply,
                    "tags": facilitator_tags or [],
                    "message_id": facilitator_message_id,
                },
            })
        except Exception:
            logger.warning(
                "contribute: agent turn failed for quorum=%s role=%s station=%s",
                quorum_id, body.role_id, body.station_id, exc_info=True,
            )
            # Non-fatal — contribution is already stored; facilitator fields
            # remain None.

    return ContributeResponse(
        contribution_id=contribution_id,
        tier_processed=tier,
        facilitator_reply=facilitator_reply,
        facilitator_message_id=facilitator_message_id,
        facilitator_tags=facilitator_tags,
    )


# ---------------------------------------------------------------------------
# GET /quorums/{quorum_id}/roles
# ---------------------------------------------------------------------------
@router.get("/quorums/{quorum_id}/roles")
async def list_roles(quorum_id: str):
    """Return all roles for a quorum.

    Used by clients (including the E2E test script) that need to discover
    role IDs after quorum creation — CreateQuorumResponse does not include
    them since role creation is a side-effect of POST /events/{id}/quorums.
    """
    db = get_supabase()

    quorum = db.table("quorums").select("id").eq("id", quorum_id).single().execute()
    if not quorum.data:
        raise HTTPException(status_code=404, detail="Quorum not found")

    roles = (
        db.table("roles")
        .select("id, name, authority_rank, capacity")
        .eq("quorum_id", quorum_id)
        .order("authority_rank", desc=True)
        .execute()
    )
    return roles.data or []


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

    # Write compressed state snapshot
    _write_state_snapshot(
        db, quorum_id, roles_data.data, contributions.data, sections_json,
    )

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
# State snapshot helpers
# ---------------------------------------------------------------------------

def _write_state_snapshot(
    db, quorum_id: str, roles: list, contributions: list, sections: list,
) -> None:
    """Write a compressed state snapshot after synthesis."""
    contributing_role_ids = {c["role_id"] for c in contributions}
    all_role_ids = {r["id"] for r in roles}
    blocked_roles = [
        r["name"] for r in roles
        if r["id"] not in contributing_role_ids
        and r.get("capacity") != "unlimited"
        and str(r.get("capacity", "")) == "1"
    ]

    role_health = {}
    for r in roles:
        rid = r["id"]
        count = sum(1 for c in contributions if c["role_id"] == rid)
        role_health[r["name"]] = {"contributions": count, "active": rid in contributing_role_ids}

    last_excerpt = ""
    if sections:
        last_excerpt = (sections[-1].get("content") or "")[:200]

    # Detect key tensions from conflicts (simplified: roles with competing contributions)
    key_tensions: list[str] = []

    snapshot = {
        "role_health": role_health,
        "key_tensions": key_tensions,
        "contributions_count": len(contributions),
        "last_synthesis_excerpt": last_excerpt,
        "blocked_roles": blocked_roles,
    }

    try:
        db.table("quorum_state_snapshots").insert({
            "quorum_id": quorum_id,
            "snapshot": snapshot,
        }).execute()
    except Exception:
        logger.warning("Failed to write state snapshot for quorum %s", quorum_id, exc_info=True)


# ---------------------------------------------------------------------------
# GET /api/quorums/{quorum_id}/state-snapshot
# ---------------------------------------------------------------------------
@router.get("/api/quorums/{quorum_id}/state-snapshot")
async def get_state_snapshot(quorum_id: str):
    """Return the latest compressed state snapshot for a quorum."""
    db = get_supabase()
    result = (
        db.table("quorum_state_snapshots")
        .select("*")
        .eq("quorum_id", quorum_id)
        .order("updated_at", desc=True)
        .limit(1)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="No snapshot found")
    return result.data[0]


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
# GET /quorums/{quorum_id}/stations/{station_id}/messages
# ---------------------------------------------------------------------------
@router.get(
    "/quorums/{quorum_id}/stations/{station_id}/messages",
    response_model=list[StationMessageResponse],
)
async def get_station_messages(
    quorum_id: str,
    station_id: str,
    limit: int = 50,
    before: str | None = None,
):
    """Return conversation history for a given station (newest-first)."""
    db = get_supabase()

    query = (
        db.table("station_messages")
        .select("*")
        .eq("quorum_id", quorum_id)
        .eq("station_id", station_id)
        .order("created_at", desc=False)
        .limit(limit)
    )
    if before:
        query = query.lt("created_at", before)

    result = query.execute()
    return result.data or []


# ---------------------------------------------------------------------------
# POST /quorums/{quorum_id}/stations/{station_id}/ask
# ---------------------------------------------------------------------------
@router.post(
    "/quorums/{quorum_id}/stations/{station_id}/ask",
    response_model=AskResponse,
)
async def ask_facilitator(quorum_id: str, station_id: str, body: AskRequest):
    """Ask the AI facilitator a freeform question at a specific station.

    This is a direct question-and-answer call — it fires the full agent turn
    pipeline and returns the reply.  The exchange is persisted in
    station_messages for context continuity.
    """
    db = get_supabase()

    # Verify quorum exists
    quorum = db.table("quorums").select("id").eq("id", quorum_id).single().execute()
    if not quorum.data:
        raise HTTPException(status_code=404, detail="Quorum not found")
    try:
        reply, message_id, tags = await process_agent_turn(
            quorum_id=quorum_id,
            role_id=body.role_id,
            station_id=station_id,
            user_message=body.content,
            supabase_client=db,
            llm_provider=llm_provider,
        )
    except Exception:
        logger.error(
            "ask_facilitator: agent turn failed quorum=%s station=%s",
            quorum_id, station_id, exc_info=True,
        )
        raise HTTPException(status_code=500, detail="Agent turn failed")

    # Broadcast so other listeners see the exchange
    await manager.broadcast(quorum_id, {
        "type": "facilitator_reply",
        "data": {
            "station_id": station_id,
            "role_id": body.role_id,
            "content": reply,
            "tags": tags,
            "message_id": message_id,
        },
    })

    return AskResponse(reply=reply, message_id=message_id, tags=tags)


# ---------------------------------------------------------------------------
# GET /quorums/{quorum_id}/documents
# ---------------------------------------------------------------------------
@router.get(
    "/quorums/{quorum_id}/documents",
    response_model=list[DocumentResponse],
)
async def list_documents(
    quorum_id: str,
    status: str = "active",
    doc_type: str | None = None,
):
    """List agent documents for a quorum.

    status must be one of: active, superseded, canceled.
    Returns 400 for an invalid status value (avoids passing arbitrary strings
    to Supabase which may cause DB-level enum errors).
    """
    db = get_supabase()

    _VALID_DOC_STATUSES = {"active", "superseded", "canceled"}
    if status not in _VALID_DOC_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status '{status}'. Must be one of: {sorted(_VALID_DOC_STATUSES)}",
        )

    query = (
        db.table("agent_documents")
        .select("*")
        .eq("quorum_id", quorum_id)
        .eq("status", status)
        .order("updated_at", desc=True)
    )
    if doc_type:
        query = query.eq("doc_type", doc_type)

    result = query.execute()
    return result.data or []


# ---------------------------------------------------------------------------
# POST /quorums/{quorum_id}/documents
# ---------------------------------------------------------------------------
@router.post(
    "/quorums/{quorum_id}/documents",
    response_model=DocumentResponse,
    status_code=201,
)
async def create_document_endpoint(quorum_id: str, body: DocumentCreateRequest):
    """Create a new agent document for a quorum."""
    db = get_supabase()

    quorum = db.table("quorums").select("id").eq("id", quorum_id).single().execute()
    if not quorum.data:
        raise HTTPException(status_code=404, detail="Quorum not found")

    try:
        doc = await create_document(
            quorum_id=quorum_id,
            doc_data=body.model_dump(),
            supabase=db,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    # Broadcast document creation
    await manager.broadcast(quorum_id, {
        "type": "document_update",
        "data": {
            "document_id": doc["id"],
            "version": 1,
            "change_type": "create",
            "changed_by": body.created_by_role_id,
        },
    })

    return doc


# ---------------------------------------------------------------------------
# PUT /quorums/{quorum_id}/documents/{doc_id}
# ---------------------------------------------------------------------------
@router.put(
    "/quorums/{quorum_id}/documents/{doc_id}",
    response_model=DocumentUpdateResponse,
)
async def update_document_endpoint(
    quorum_id: str, doc_id: str, body: DocumentUpdateRequest
):
    """CAS-update an agent document.

    Returns 409 when the expected_version does not match — the client should
    re-fetch and retry.  When the update merges (i.e., another agent edited
    concurrently), ``merged=True`` is returned with the current version.
    """
    db = get_supabase()

    # Verify the document belongs to this quorum before attempting any write.
    # This prevents cross-quorum document mutations via a crafted quorum_id.
    doc_check = (
        db.table("agent_documents")
        .select("id, quorum_id")
        .eq("id", doc_id)
        .single()
        .execute()
    )
    if not doc_check.data:
        raise HTTPException(status_code=404, detail="Document not found")
    if doc_check.data["quorum_id"] != quorum_id:
        raise HTTPException(
            status_code=403,
            detail="Document does not belong to this quorum",
        )

    try:
        result = await update_document(
            doc_id=doc_id,
            changes=body.model_dump(),
            role_id=body.changed_by_role,
            rationale=body.rationale,
            supabase=db,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if result["merged"]:
        # Return 409 so clients know the write did not land
        raise HTTPException(
            status_code=409,
            detail=f"Version conflict — current version is {result['version']}. Re-fetch and retry.",
        )

    # Broadcast document edit
    await manager.broadcast(quorum_id, {
        "type": "document_update",
        "data": {
            "document_id": doc_id,
            "version": result["version"],
            "change_type": "edit",
            "changed_by": body.changed_by_role,
        },
    })

    return DocumentUpdateResponse(version=result["version"], merged=False)


# ---------------------------------------------------------------------------
# GET /quorums/{quorum_id}/insights
# ---------------------------------------------------------------------------
@router.get(
    "/quorums/{quorum_id}/insights",
    response_model=list[InsightResponse],
)
async def list_insights(
    quorum_id: str,
    role_id: str | None = None,
    insight_type: str | None = None,
    limit: int = 20,
):
    """Return cross-station agent insights for a quorum.

    insight_type, when provided, must be a valid InsightType enum value.
    limit is capped at 100 to prevent runaway queries.
    """
    db = get_supabase()

    _VALID_INSIGHT_TYPES = {"summary", "conflict", "suggestion", "question", "decision", "escalation"}
    if insight_type is not None and insight_type not in _VALID_INSIGHT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid insight_type '{insight_type}'. Must be one of: {sorted(_VALID_INSIGHT_TYPES)}",
        )

    # Cap limit to prevent accidentally fetching unbounded rows
    limit = min(limit, 100)

    query = (
        db.table("agent_insights")
        .select("*")
        .eq("quorum_id", quorum_id)
        .order("created_at", desc=True)
        .limit(limit)
    )
    if role_id:
        query = query.eq("source_role_id", role_id)
    if insight_type:
        query = query.eq("insight_type", insight_type)

    result = query.execute()
    return result.data or []


# ---------------------------------------------------------------------------
# POST /quorums/{quorum_id}/a2a/request
# ---------------------------------------------------------------------------
@router.post(
    "/quorums/{quorum_id}/a2a/request",
    response_model=A2ARequestResponse,
    status_code=201,
)
async def create_a2a_request(quorum_id: str, body: A2ARequestCreate):
    """Create an agent-to-agent request and wake the target agent.

    The target agent automatically processes the request and its response
    is included in the return payload as ``target_response``.
    """
    db = get_supabase()

    # Verify quorum exists
    quorum = db.table("quorums").select("id").eq("id", quorum_id).single().execute()
    if not quorum.data:
        raise HTTPException(status_code=404, detail="Quorum not found")

    # Verify both roles exist
    for label, rid in [("from_role_id", body.from_role_id), ("to_role_id", body.to_role_id)]:
        role = db.table("roles").select("id").eq("id", rid).single().execute()
        if not role.data:
            raise HTTPException(status_code=404, detail=f"Role not found: {label}={rid}")

    request_id = str(uuid.uuid4())
    now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    row = {
        "id": request_id,
        "quorum_id": quorum_id,
        "from_role_id": body.from_role_id,
        "to_role_id": body.to_role_id,
        "request_type": body.request_type.value,
        "content": body.content,
        "tags": body.tags,
        "document_id": body.document_id,
        "status": "pending",
        "priority": body.priority,
        "created_at": now,
    }
    db.table("agent_requests").insert(row).execute()

    # Wake the target agent immediately
    target_response: str | None = None
    try:
        target_response = await process_a2a_request(
            request_id=request_id,
            supabase_client=db,
            llm_provider=llm_provider,
        )
        # Broadcast A2A reply
        await manager.broadcast(quorum_id, {
            "type": "agent_request",
            "data": {
                "request_id": request_id,
                "from_role_id": body.from_role_id,
                "to_role_id": body.to_role_id,
                "request_type": body.request_type.value,
                "response": target_response,
            },
        })
    except Exception:
        logger.warning(
            "create_a2a_request: agent wake failed for request %s",
            request_id, exc_info=True,
        )

    return A2ARequestResponse(
        id=request_id,
        quorum_id=quorum_id,
        from_role_id=body.from_role_id,
        to_role_id=body.to_role_id,
        request_type=body.request_type,
        content=body.content,
        tags=body.tags,
        document_id=body.document_id,
        status="acknowledged" if target_response else "pending",
        response=target_response,
        priority=body.priority,
        created_at=now,
        target_response=target_response,
    )


# ---------------------------------------------------------------------------
# POST /events/{event_id}/quorums/{quorum_id}/seed-documents
# ---------------------------------------------------------------------------
@router.post(
    "/events/{event_id}/quorums/{quorum_id}/seed-documents",
    status_code=201,
)
async def seed_documents(event_id: str, quorum_id: str):
    """Load pre-seeded agent documents from seed/clinical-trial-documents.json.

    Idempotent — documents whose title already exists for this quorum are
    skipped.  Returns counts of inserted and skipped documents.

    This endpoint is intended for development and demo setup only.  In
    production, use scripts/seed-agent-documents.py with the service role key.
    """
    db = get_supabase()

    # Verify event + quorum exist and are related
    quorum = (
        db.table("quorums")
        .select("id, title, event_id")
        .eq("id", quorum_id)
        .eq("event_id", event_id)
        .single()
        .execute()
    )
    if not quorum.data:
        raise HTTPException(
            status_code=404,
            detail="Quorum not found or does not belong to this event",
        )

    # Locate the seed file relative to repo root (two levels above apps/api/)
    seed_path = (
        pathlib.Path(__file__).resolve().parent.parent.parent
        / "seed"
        / "clinical-trial-documents.json"
    )
    if not seed_path.exists():
        raise HTTPException(
            status_code=500,
            detail=f"Seed file not found at {seed_path}",
        )

    with seed_path.open() as fh:
        seed_data = json.load(fh)

    # Fetch existing document titles so we can skip duplicates
    existing = (
        db.table("agent_documents")
        .select("title")
        .eq("quorum_id", quorum_id)
        .eq("status", "active")
        .execute()
    )
    existing_titles = {row["title"] for row in existing.data}

    inserted: list[dict] = []
    skipped: list[str] = []

    for doc in seed_data.get("documents", []):
        title = doc["title"]

        if title in existing_titles:
            skipped.append(title)
            continue

        doc_id = str(uuid.uuid4())
        row = {
            "id": doc_id,
            "quorum_id": quorum_id,
            "title": title,
            "doc_type": doc["doc_type"],
            # All seed documents use the json format envelope even when their
            # logical representation is tabular (e.g., budget CSV).
            "format": "json",
            "content": doc["content"],
            "status": "active",
            "version": 1,
            "tags": doc.get("tags", []),
            "created_by_role_id": None,
        }

        result = db.table("agent_documents").insert(row).execute()
        if result.data:
            inserted.append({"id": doc_id, "title": title, "doc_type": doc["doc_type"]})
            # Broadcast new document over WebSocket
            await manager.broadcast(quorum_id, {
                "type": "document_update",
                "data": {
                    "document_id": doc_id,
                    "version": 1,
                    "change_type": "create",
                    "changed_by": None,
                },
            })
        else:
            logger.warning("seed_documents: insert failed for '%s'", title)

    logger.info(
        "seed_documents: quorum=%s inserted=%d skipped=%d",
        quorum_id, len(inserted), len(skipped),
    )

    return {
        "quorum_id": quorum_id,
        "inserted": inserted,
        "skipped": skipped,
        "total_problems_seeded": sum(
            len(doc["content"].get("metadata", {}).get("problems", []))
            for doc in seed_data.get("documents", [])
            if doc["title"] not in skipped
        ),
    }


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
