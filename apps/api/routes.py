"""All API routes from CONTRACT.md — wired to quorum_llm pipeline."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import pathlib
import uuid
from datetime import datetime, timezone

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
from quorum_llm.contribution_analyzer import (
    ContributionAnalysis,
    analyze_contribution,
)
from quorum_llm.position_analyzer import (
    PositionSnapshot,
    synthesize_position,
)
from quorum_llm.metric_deltas import (
    append_rationale,
    apply_deltas_to_running_total,
    extract_score_deltas,
)

# TODO: migrate to DatabaseProvider from db/factory.py
from coordination.factory import get_coordination_backend
from database import get_supabase
from health import calculate_health_score, fetch_activity_count
from llm import llm_provider
from architect_agent import (
    RoleSuggestion,
    generate_roles_with_title,
    persist_agent_configs,
    send_guidance,
)
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
    CreateParticipantRequest,
    CreateParticipantResponse,
    CreateQuorumRequest,
    CreateQuorumResponse,
    HeartbeatRequest,
    DocumentCreateRequest,
    DocumentResponse,
    DocumentUpdateRequest,
    DocumentUpdateResponse,
    GenerateRolesRequest,
    GenerateRolesResponse,
    GuidanceRequest,
    GuidanceResponse,
    InsightResponse,
    QuorumBlackboardResponse,
    QuorumStateResponse,
    ResolveRequest,
    ResolveResponse,
    StationMessageResponse,
)
import quorum_state as quorum_state_module
from agent_engine import (
    is_paused_reply,
    process_a2a_request,
    process_agent_turn,
)
from document_engine import create_document, detect_oscillation, update_document
from ws_manager import manager

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers: safe Supabase single-row fetch
# ---------------------------------------------------------------------------

def _fetch_single(db, table: str, column: str, value: str, *, select: str = "*", label: str = "Record"):
    """Fetch a single row or raise a clean 404.

    Supabase's .single() throws APIError when no row matches, which surfaces
    as an opaque 500.  This helper uses .maybe_single() and converts a miss
    into a proper HTTPException(404).
    """
    result = db.table(table).select(select).eq(column, value).maybe_single().execute()
    if not result or not result.data:
        raise HTTPException(status_code=404, detail=f"{label} not found")
    return result


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


async def _persist_position_snapshot(
    quorum_id: str,
    stage: str,  # "initial" | "final"
) -> None:
    """Fire-and-forget Before/After snapshot generator.

    Runs the Tier-2 position synthesizer and persists the result onto the
    artifacts row's ``initial_position`` or ``final_position`` column.  This
    is called asynchronously from /contribute (after contribution #3 lands)
    and synchronously from /resolve (after Tier-3 synthesis).  All errors
    are swallowed and logged — a snapshot failure must never block the
    request that triggered it.

    For ``stage="initial"`` the column is only written when it's still NULL,
    so retries don't overwrite the first captured framing.  For
    ``stage="final"`` we always write — the resolved state is canonical.
    """
    column = "initial_position" if stage == "initial" else "final_position"
    try:
        db = get_supabase()
        # Fetch quorum + roles + contributions + station chats for the prompt.
        quorum_row = (
            db.table("quorums")
            .select("id, status")
            .eq("id", quorum_id)
            .maybe_single()
            .execute()
        )
        if not quorum_row or not quorum_row.data:
            logger.info(
                "position_snapshot: quorum %s not found; skipping", quorum_id,
            )
            return

        roles_resp = (
            db.table("roles").select("*").eq("quorum_id", quorum_id).execute()
        )
        contribs_resp = (
            db.table("contributions")
            .select("*")
            .eq("quorum_id", quorum_id)
            .order("created_at")
            .execute()
        )
        try:
            chats_resp = (
                db.table("station_messages")
                .select("id, role_id, station_id, role, content")
                .eq("quorum_id", quorum_id)
                .order("created_at")
                .limit(50)
                .execute()
            )
            chats = chats_resp.data or []
        except Exception:
            # station_messages is best-effort context; absence is fine.
            chats = []

        llm_roles = _db_roles_to_llm(roles_resp.data or [])
        llm_contribs = _db_contribs_to_llm(contribs_resp.data or [])

        snapshot = await synthesize_position(
            role_definitions=llm_roles,
            contributions=llm_contribs,
            chats=chats,
            stage=stage,  # type: ignore[arg-type]
            llm_provider=llm_provider,
        )

        # Find or create the artifacts row for this quorum.  Position
        # snapshots can land before /resolve (initial stage), in which case
        # no artifact row exists yet — insert a minimal placeholder.
        existing = (
            db.table("artifacts")
            .select("id, initial_position")
            .eq("quorum_id", quorum_id)
            .execute()
        )
        snapshot_json = snapshot.model_dump(mode="json")

        if existing.data:
            artifact_id = existing.data[0]["id"]
            if stage == "initial" and existing.data[0].get("initial_position"):
                # Already captured — leave it alone.  The "initial" framing
                # is the first 3-contribution moment and must not be
                # overwritten by retries.
                return
            db.table("artifacts").update(
                {column: snapshot_json}
            ).eq("id", artifact_id).execute()
        else:
            # No artifact row yet (initial-stage path).  Insert a draft
            # placeholder so we have somewhere to persist initial_position.
            db.table("artifacts").insert({
                "id": str(uuid.uuid4()),
                "quorum_id": quorum_id,
                "version": 0,
                "content_hash": "",
                "sections": [],
                "status": "draft",
                column: snapshot_json,
            }).execute()

        logger.info(
            "position_snapshot: persisted %s for quorum=%s",
            stage, quorum_id,
        )
    except Exception:
        logger.warning(
            "position_snapshot: failed to generate %s snapshot for quorum=%s",
            stage, quorum_id, exc_info=True,
        )


# ---------------------------------------------------------------------------
# GET /events
# ---------------------------------------------------------------------------
@router.get("/events")
async def list_events(include_archived: bool = False):
    """List all events, newest first.

    Archived events are hidden by default — pass include_archived=true to surface
    them (used by the architect's 'Show archived' toggle).  Clients use the slug
    to navigate to /event/{slug}.  No quorum data is embedded here.
    """
    db = get_supabase()
    query = db.table("events").select("*").order("created_at", desc=True)
    if not include_archived:
        query = query.is_("archived_at", "null")
    result = query.execute()
    return result.data or []


# ---------------------------------------------------------------------------
# PATCH /events/{event_id}  — archive / unarchive
# ---------------------------------------------------------------------------
@router.patch("/events/{event_id}")
async def update_event(event_id: str, body: dict):
    """Update an event's archive state.

    Body: {"archived": true}  → sets archived_at = now()
          {"archived": false} → clears archived_at
    """
    db = get_supabase()
    if "archived" not in body:
        raise HTTPException(status_code=400, detail="Missing 'archived' field")
    archived = bool(body["archived"])
    patch = {"archived_at": datetime.now(timezone.utc).isoformat() if archived else None}
    result = db.table("events").update(patch).eq("id", event_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found")
    return result.data[0]


# ---------------------------------------------------------------------------
# DELETE /events/{event_id}  — hard delete (cascades through quorums, etc.)
# ---------------------------------------------------------------------------
@router.delete("/events/{event_id}", status_code=204)
async def delete_event(event_id: str):
    """Hard-delete an event.  All quorums, roles, contributions, and related
    rows cascade-delete via FK constraints.  Use archive (PATCH) for soft delete.
    """
    db = get_supabase()
    existing = db.table("events").select("id").eq("id", event_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found")
    db.table("events").delete().eq("id", event_id).execute()
    return None


# ---------------------------------------------------------------------------
# GET /events/{slug}/quorum-ids  — used by display page to get live quorum IDs
# ---------------------------------------------------------------------------
@router.get("/events/{slug}/quorum-ids", response_model=list[str])
async def get_event_quorum_ids(slug: str, status_filter: str = "all"):
    """Return quorum IDs for an event, filtered by status.

    ``status_filter`` (query param, default ``"all"``):
      - ``"active"`` → only ``open`` + ``active`` quorums (the legacy default)
      - ``"resolved"`` → only ``resolved`` quorums
      - ``"all"`` → both buckets (so the event-landing UI can show resolved
        quorums alongside running ones with a toggle).  Archived rows are
        always excluded.

    Unrecognised values fall back to ``"all"`` rather than 400-ing — the
    URL is user-visible via the architect toggle and a typo shouldn't blow
    up the page.
    """
    db = get_supabase()
    event = db.table("events").select("id").eq("slug", slug).maybe_single().execute()
    if not event or not event.data:
        return []
    event_id = event.data["id"]

    if status_filter == "active":
        statuses = ["open", "active"]
    elif status_filter == "resolved":
        statuses = ["resolved"]
    else:
        statuses = ["open", "active", "resolved"]

    result = (
        db.table("quorums")
        .select("id")
        .eq("event_id", event_id)
        .in_("status", statuses)
        .order("created_at", desc=True)
        .execute()
    )
    return [r["id"] for r in (result.data or [])]


# ---------------------------------------------------------------------------
# POST /events
# ---------------------------------------------------------------------------
@router.post("/events", response_model=CreateEventResponse)
async def create_event(body: CreateEventRequest):
    db = get_supabase()

    # Check for duplicate slug
    existing = db.table("events").select("id").eq("slug", body.slug).maybe_single().execute()
    if existing and existing.data:
        raise HTTPException(status_code=409, detail=f"An event with slug '{body.slug}' already exists")

    event_id = str(uuid.uuid4())
    row = {
        "id": event_id,
        "name": body.name,
        "slug": body.slug,
        "access_code": body.access_code or "",
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
    event = _fetch_single(db, "events", "id", event_id, select="id, slug", label="Event")

    quorum_id = str(uuid.uuid4())
    quorum_row = {
        "id": quorum_id,
        "event_id": event_id,
        "title": body.title,
        "description": body.description,
        "status": "open",
        "carousel_mode": body.carousel_mode.value,
        "autonomy_level": body.autonomy_level,
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

        # Register the role's A2A endpoint in agent_endpoints so other agents
        # (and external A2A peers) can discover and POST tasks to this role.
        # Never fatal — failures are logged inside register_endpoint.
        try:
            from quorum_a2a.a2a_server import register_endpoint

            register_endpoint(
                role_ids[idx],
                capabilities={
                    "name": role_def.name,
                    "authority_rank": role_def.authority_rank,
                },
                db=db,
            )
        except Exception:
            logger.warning(
                "create_quorum: failed to register A2A endpoint for role %s",
                role_ids[idx], exc_info=True,
            )

    share_url = f"/event/{event.data['slug']}/quorum/{quorum_id}"

    # Auto-seed agent documents only in test mode (non-fatal)
    if os.environ.get("QUORUM_TEST_MODE", "").lower() in ("true", "1", "yes"):
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

    # Start autonomy loop if autonomy_level > 0
    if body.autonomy_level > 0:
        from autonomy_loop import start_autonomy_loop
        asyncio.create_task(start_autonomy_loop(quorum_id, body.autonomy_level))

    return CreateQuorumResponse(id=quorum_id, status="open", share_url=share_url)


# ---------------------------------------------------------------------------
# DELETE /quorums/{quorum_id}  — hard delete (cascades through roles,
# contributions, artifacts, insights, agent_requests, etc. via FK constraints)
# ---------------------------------------------------------------------------
@router.delete("/quorums/{quorum_id}", status_code=204)
async def delete_quorum(quorum_id: str):
    """Hard-delete a quorum and all child rows (roles, contributions, artifacts,
    insights, agent_requests, conversations, participants, sync state).  All
    children cascade via the ON DELETE CASCADE FK constraints defined in the
    schema migrations.  Returns 204 on success, 404 if the quorum doesn't exist.
    """
    db = get_supabase()
    existing = db.table("quorums").select("id").eq("id", quorum_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail=f"Quorum {quorum_id} not found")
    db.table("quorums").delete().eq("id", quorum_id).execute()
    return None


# ---------------------------------------------------------------------------
# POST /quorums/{quorum_id}/contribute
# ---------------------------------------------------------------------------
@router.post("/quorums/{quorum_id}/contribute", response_model=ContributeResponse)
async def contribute(quorum_id: str, body: ContributeRequest):
    db = get_supabase()

    # Verify quorum exists and is not resolved/archived
    quorum = _fetch_single(db, "quorums", "id", quorum_id, select="id, status", label="Quorum")
    if quorum.data["status"] in ("resolved", "archived"):
        raise HTTPException(status_code=409, detail="Quorum is no longer accepting contributions")

    # Verify role_id belongs to this quorum — prevents cross-quorum writes
    # (an attendee at the expo could otherwise pass a foreign role_id and
    # land contributions into another live quorum's artifact). Uses the
    # same supabase-py pattern as elsewhere in this file (maybe_single).
    # We also pull name + authority_rank here so the Tier-2 analyzer doesn't
    # have to re-query — saves one round trip per contribution.
    role_check = (
        db.table("roles")
        .select("quorum_id, name, authority_rank")
        .eq("id", body.role_id)
        .maybe_single()
        .execute()
    )
    if not role_check or not role_check.data or role_check.data.get("quorum_id") != quorum_id:
        raise HTTPException(
            status_code=422,
            detail="role_id does not belong to this quorum",
        )
    role_name = role_check.data.get("name") or ""
    role_authority_rank = int(role_check.data.get("authority_rank") or 0)

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
        participant_id=body.participant_id,
    )
    contribution_id = contrib_row["id"]

    # Broadcast contribution
    await manager.broadcast(quorum_id, {
        "type": "contribution",
        "data": contrib_row,
    })

    # --- Tier-2 contribution analyzer (LLM-scored tags + per-metric deltas) ---
    # One structured-output call per contribution.  Replaces the stopword
    # tag extractor for the chart-pill / chart-line path specifically.  If
    # the LLM call fails (network, parse, budget) we log + fall through —
    # the contribution is already persisted and the deterministic baseline
    # health-score path below still runs.
    contrib_analysis: ContributionAnalysis | None = None
    try:
        contrib_analysis = await analyze_contribution(
            content=body.content or "",
            role_name=role_name,
            role_authority_rank=role_authority_rank,
            llm_provider=llm_provider,
        )
        # Persist analysis on the contribution row so it surfaces in chart
        # hover popovers and survives reloads.
        try:
            db.table("contributions").update({
                "analysis_tags": list(contrib_analysis.tags),
                "analysis_deltas": dict(contrib_analysis.score_deltas),
                "analysis_rationale": contrib_analysis.rationale,
            }).eq("id", contribution_id).execute()
        except Exception:
            logger.warning(
                "contribute: failed to persist analysis for contribution=%s",
                contribution_id,
                exc_info=True,
            )
    except Exception:
        logger.warning(
            "contribute: contribution analyzer failed for quorum=%s role=%s; "
            "falling through to deterministic baseline",
            quorum_id,
            body.role_id,
            exc_info=True,
        )
        contrib_analysis = None

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
                # Persist the LLM-detected conflicts as a synthesis_snapshot row
                # so downstream debugging / dashboards can audit the outcome.
                # Previously the result was logged-and-dropped, which made it
                # impossible to tell "detector never ran" from "detector ran,
                # found nothing" after the fact.  We write tier='conflict' to
                # match the schema check constraint.
                try:
                    backend = get_coordination_backend()
                    store = getattr(backend, "store_synthesis", None)
                    if store is not None:
                        contribution_ids: list[str] = []
                        for c in conflicts:
                            ids = getattr(c, "contribution_ids", None) or []
                            for cid in ids:
                                if cid and cid not in contribution_ids:
                                    contribution_ids.append(str(cid))
                        snapshot_payload = {
                            "conflicts": [
                                {
                                    "contribution_ids": list(
                                        getattr(c, "contribution_ids", []) or []
                                    ),
                                    "field_name": getattr(c, "field_name", None),
                                    "description": getattr(c, "description", "") or "",
                                    "severity": getattr(c, "severity", "medium"),
                                }
                                for c in conflicts
                            ],
                            "overlap_fields": sorted(overlaps.keys()),
                            "detected_at": datetime.now(timezone.utc).isoformat(),
                        }
                        await store(
                            quorum_id,
                            {
                                "tier": "conflict",
                                "content": snapshot_payload,
                                "contribution_ids": contribution_ids,
                            },
                        )
                except Exception:
                    logger.warning(
                        "Tier 2: failed to persist conflict snapshot for quorum %s",
                        quorum_id,
                        exc_info=True,
                    )
        except Exception:
            logger.warning("Tier 2 conflict detection failed for quorum %s", quorum_id, exc_info=True)

        # Update contribution tier
        db.table("contributions").update({"tier_processed": tier}).eq("id", contribution_id).execute()

    # --- Recalculate health score ---
    artifact_result = db.table("artifacts").select("*").eq("quorum_id", quorum_id).execute()
    artifact = artifact_result.data[0] if artifact_result.data else None

    health_score, metrics = calculate_health_score(
        roles_data.data,
        all_contribs.data,
        artifact,
        activity_count=fetch_activity_count(db, quorum_id),
    )

    # --- Parse human contribution text for [scores: ...] block too ---
    # Rare in practice (most humans won't write the block), but lets a
    # facilitator manually annotate "this contribution introduced a blocker"
    # without firing an agent turn.  Mirrors the agent path: load → decay →
    # add → clamp → persist.
    #
    # The Tier-2 analyzer above ALSO produces deltas (LLM-scored) — these
    # are the primary signal now.  We merge the two: analyzer first, then
    # any explicit `[scores: ...]` block in the user content overrides
    # on a per-metric basis.  This way the chart always moves on every
    # contribution (analyzer), but a facilitator can still hand-annotate.
    user_deltas, user_why = extract_score_deltas(body.content or "")
    analyzer_deltas: dict[str, float] = (
        dict(contrib_analysis.score_deltas) if contrib_analysis else {}
    )
    analyzer_why: str | None = contrib_analysis.rationale if contrib_analysis else None
    merged_deltas: dict[str, float] = dict(analyzer_deltas)
    merged_deltas.update(user_deltas)  # explicit block wins per-key
    # Rationale: prefer the user's explicit `[scores-why: ...]` if present,
    # otherwise the analyzer's rationale.
    merged_why: str | None = user_why or analyzer_why
    llm_deltas_running: dict[str, float] = {}
    llm_rationales: list[dict] = []
    try:
        delta_row = (
            db.table("quorums")
            .select("llm_metric_deltas, llm_metric_rationales")
            .eq("id", quorum_id)
            .maybe_single()
            .execute()
        )
        delta_data = (delta_row.data if delta_row else None) or {}
        existing_running = delta_data.get("llm_metric_deltas") or {}
        existing_rationales = delta_data.get("llm_metric_rationales") or []
        if merged_deltas:
            llm_deltas_running = apply_deltas_to_running_total(
                existing_running, merged_deltas
            )
            llm_rationales = append_rationale(
                existing_rationales,
                ts=datetime.now(timezone.utc).isoformat(),
                deltas=merged_deltas,
                why=merged_why,
            )
        else:
            # No new deltas — preserve the existing accumulator so the
            # broadcast still carries the latest cumulative reading.
            llm_deltas_running = dict(existing_running)
            llm_rationales = list(existing_rationales)
    except Exception:
        logger.debug(
            "contribute: could not read llm_metric_deltas for quorum=%s",
            quorum_id, exc_info=True,
        )

    # Save health score + per-metric breakdown to quorum.  The `metrics`
    # column feeds the frontend's Postgres realtime subscription so the
    # secondary lines on the Quorum Health Chart update live too.  When the
    # analyzer or a user-emitted [scores: ...] block produced deltas, also
    # persist the updated llm deltas + rationales in the same UPDATE.
    update_payload: dict = {"heat_score": health_score, "metrics": metrics}
    if merged_deltas:
        update_payload["llm_metric_deltas"] = llm_deltas_running
        update_payload["llm_metric_rationales"] = llm_rationales
    db.table("quorums").update(update_payload).eq("id", quorum_id).execute()

    # Broadcast health update
    await manager.broadcast(quorum_id, {
        "type": "health_update",
        "data": {
            "score": health_score,
            "metrics": metrics,
            "llm_deltas": llm_deltas_running,
            "llm_rationales": llm_rationales[-5:],
        },
    })

    # --- Agent facilitator turn (optional — requires station_id) ---
    facilitator_reply: str | None = None
    facilitator_message_id: str | None = None
    facilitator_tags: list[str] | None = None
    facilitator_paused = False
    facilitator_paused_reason: str | None = None

    if body.station_id:
        try:
            turn_reply, turn_msg_id, turn_tags = await process_agent_turn(
                quorum_id=quorum_id,
                role_id=body.role_id,
                station_id=body.station_id,
                user_message=body.content,
                supabase_client=db,
                llm_provider=llm_provider,
                participant_id=body.participant_id,
            )
            if is_paused_reply(turn_reply, turn_tags):
                # Facilitator paused (LLM unavailable). Do NOT broadcast a
                # reply — the avatar must stay silent — but signal the paused
                # state to listeners so the UI can show the pill.
                facilitator_paused = True
                facilitator_paused_reason = "llm_unavailable"
                logger.warning(
                    "contribute: facilitator paused",
                    extra={
                        "quorum_id": quorum_id,
                        "role_id": body.role_id,
                        "station_id": body.station_id,
                        "reason": "llm_unavailable",
                    },
                )
                await manager.broadcast(quorum_id, {
                    "type": "facilitator_paused",
                    "data": {
                        "station_id": body.station_id,
                        "role_id": body.role_id,
                        "reason": "llm_unavailable",
                    },
                })
            else:
                facilitator_reply = turn_reply
                facilitator_message_id = turn_msg_id
                facilitator_tags = turn_tags
                # Broadcast facilitator reply over WebSocket so the frontend
                # can update the conversation thread in real time.
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

    # --- Before/After: capture initial-position snapshot after #3 ---
    # Once the quorum has its first 3 contributions, fire the Tier-2 position
    # synthesizer in the background to capture an "initial framing" snapshot.
    # The helper itself checks whether initial_position is already set on the
    # artifact row and no-ops if so, so this can race-fire harmlessly.  All
    # errors swallowed inside _persist_position_snapshot — never blocks the
    # /contribute response.
    try:
        contribution_count = len(all_contribs.data or [])
        if contribution_count >= 3:
            artifact_existing = (
                db.table("artifacts")
                .select("initial_position")
                .eq("quorum_id", quorum_id)
                .execute()
            )
            has_initial = bool(
                artifact_existing.data
                and artifact_existing.data[0].get("initial_position")
            )
            if not has_initial:
                asyncio.create_task(
                    _persist_position_snapshot(quorum_id, "initial")
                )
    except Exception:
        logger.debug(
            "contribute: failed to schedule initial position snapshot for "
            "quorum=%s",
            quorum_id, exc_info=True,
        )

    return ContributeResponse(
        contribution_id=contribution_id,
        tier_processed=tier,
        facilitator_reply=facilitator_reply,
        facilitator_message_id=facilitator_message_id,
        facilitator_tags=facilitator_tags,
        facilitator_paused=facilitator_paused,
        facilitator_paused_reason=facilitator_paused_reason,
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

    _fetch_single(db, "quorums", "id", quorum_id, select="id", label="Quorum")

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
async def get_quorum_state(quorum_id: str, slim: bool = False, limit: int | None = None):
    """Full quorum state snapshot.

    Query params:
        slim:  When true, ``contributions`` is returned as an empty list and
               ``health_score`` falls back to the persisted ``heat_score``
               column. Used by the event-landing card grid which only needs
               quorum metadata + roles, not the contribution history.
               Cuts payload from ~3MB to ~1KB on a busy quorum.
        limit: When set (and slim is false), only the most recent N
               contributions are returned (still ordered oldest -> newest
               in the response). Lets the quorum page bound the initial
               render even on quorums with thousands of contributions —
               older rows can be paged in later if/when needed.
    """
    db = get_supabase()

    quorum = _fetch_single(db, "quorums", "id", quorum_id, label="Quorum")

    if slim:
        # Skip heavy joins entirely.  Roles are still needed so the consumer
        # can render role pills on the event-landing card.
        artifact_result = (
            db.table("artifacts").select("id").eq("quorum_id", quorum_id).execute()
        )
        artifact = artifact_result.data[0] if artifact_result.data else None
        roles = db.table("roles").select("id").eq("quorum_id", quorum_id).execute()
        active_roles = [
            {"role_id": r["id"], "participant_count": 0} for r in (roles.data or [])
        ]
        return QuorumStateResponse(
            quorum=quorum.data,
            contributions=[],
            artifact=artifact,
            health_score=float(quorum.data.get("heat_score") or 0),
            active_roles=active_roles,
        )

    contribs_query = (
        db.table("contributions")
        .select("*")
        .eq("quorum_id", quorum_id)
    )
    if limit and limit > 0:
        # Newest-first + limit, then reverse client-perceived order back to
        # ascending so downstream code (which expects oldest -> newest) works
        # unchanged.
        contribs_query = contribs_query.order("created_at", desc=True).limit(limit)
        contributions_data = list(reversed((contribs_query.execute()).data or []))
    else:
        contribs_query = contribs_query.order("created_at")
        contributions_data = (contribs_query.execute()).data or []

    artifact_result = (
        db.table("artifacts").select("*").eq("quorum_id", quorum_id).execute()
    )
    artifact = artifact_result.data[0] if artifact_result.data else None

    roles = db.table("roles").select("*").eq("quorum_id", quorum_id).execute()

    # Compute active roles (distinct user_tokens per role)
    role_participants: dict[str, set[str]] = {}
    for c in contributions_data:
        role_participants.setdefault(c["role_id"], set()).add(c["user_token"])

    active_roles = [
        {"role_id": r["id"], "participant_count": len(role_participants.get(r["id"], set()))}
        for r in roles.data
    ]

    health_score, _ = calculate_health_score(
        roles.data, contributions_data, artifact,
    )

    return QuorumStateResponse(
        quorum=quorum.data,
        contributions=contributions_data,
        artifact=artifact,
        health_score=health_score,
        active_roles=active_roles,
    )


# ---------------------------------------------------------------------------
# GET /quorums/{quorum_id}/blackboard
# ---------------------------------------------------------------------------
# Orchestrator blackboard surface (checklist item 11.6).  Read-only here —
# agents mutate the blackboard via apps/api/quorum_state.py helpers, not via
# HTTP, so this route exists solely to power the projector dashboard and
# realtime subscriptions.  Returns the canonical default snapshot (all empty
# lists, version=1) when no row exists yet so the projector can render a
# brand-new quorum without a separate "no data" branch.
@router.get(
    "/quorums/{quorum_id}/blackboard",
    response_model=QuorumBlackboardResponse,
)
async def get_quorum_blackboard(quorum_id: str):
    db = get_supabase()
    state = await quorum_state_module.get_state(db, quorum_id)
    return QuorumBlackboardResponse(**state)


# ---------------------------------------------------------------------------
# GET /quorums/{quorum_id}/before-after  — Before/After snapshots
# ---------------------------------------------------------------------------
@router.get("/quorums/{quorum_id}/before-after")
async def get_before_after(quorum_id: str):
    """Return initial + final position snapshots for the Before/After view.

    Response shape:

        {
            "initial":      PositionSnapshot | null,
            "final":        PositionSnapshot | null,
            "has_initial":  bool,
            "has_final":    bool,
        }

    A 200 with both nulls means the quorum exists but no snapshots have
    been captured yet — frontend renders "Still gathering data…".  Initial
    is set after contribution #3 lands; final is set during /resolve.
    """
    db = get_supabase()
    # 404 if the quorum doesn't exist at all.
    _fetch_single(db, "quorums", "id", quorum_id, select="id", label="Quorum")

    artifact_result = (
        db.table("artifacts")
        .select("initial_position, final_position")
        .eq("quorum_id", quorum_id)
        .execute()
    )

    initial: dict | None = None
    final: dict | None = None
    if artifact_result.data:
        row = artifact_result.data[0]
        initial = row.get("initial_position")
        final = row.get("final_position")

    return {
        "initial": initial,
        "final": final,
        "has_initial": initial is not None,
        "has_final": final is not None,
    }


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

    # Fetch agent_configs so we can return each role's domain_tags + authority
    # rank — the affinity views need domain_tags to compute meaningful
    # similarity even before any contributions have arrived.
    agent_configs = (
        db.table("agent_configs")
        .select("role_id, domain_tags")
        .eq("quorum_id", quorum_id)
        .execute()
    )
    tags_by_role: dict[str, list[str]] = {
        cfg["role_id"]: cfg.get("domain_tags") or []
        for cfg in (agent_configs.data or [])
    }

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
            "authority_rank": role.get("authority_rank", 1),
            "domain_tags": tags_by_role.get(role["id"], []),
        })

    return result


# ---------------------------------------------------------------------------
# GET /quorums/{quorum_id}/affinity-graph
# ---------------------------------------------------------------------------
# Computes the agent-affinity graph on-fetch from agent_configs.domain_tags.
# There is no separate writer maintaining a cached affinity_edges table —
# the graph is cheap to derive (<=20 roles, O(n^2) Jaccard) so we compute
# it lazily here from the same source the role-status view reads.
@router.get("/quorums/{quorum_id}/affinity-graph")
async def get_affinity_graph(quorum_id: str):
    # Use compute_tag_relevance (word-level overlap) rather than the strict
    # exact-string Jaccard that build_affinity_graph hard-codes.  On the live
    # 4-role data-strategy quorum, strict Jaccard surfaces only 1 edge above
    # 0.1 because architect-generated compound tags
    # (e.g. "stakeholder_engagement" vs "stakeholder_feedback") rarely
    # exact-match even when they're semantically equivalent — the same
    # vocabulary mismatch that motivated compute_tag_relevance in the first
    # place (see affinity.py for the design note).  Word-level overlap
    # surfaces those edges and matches the metric find_relevant_agents
    # already uses for A2A fan-out, so the dashboard and the autonomy loop
    # speak the same affinity language.
    from quorum_llm.affinity import compute_tag_relevance

    db = get_supabase()
    _fetch_single(db, "quorums", "id", quorum_id, select="id", label="Quorum")

    roles_resp = (
        db.table("roles")
        .select("id, name, color, status")
        .eq("quorum_id", quorum_id)
        .execute()
    )
    roles = roles_resp.data or []
    if not roles:
        return {"nodes": [], "edges": []}

    cfg_resp = (
        db.table("agent_configs")
        .select("role_id, domain_tags")
        .eq("quorum_id", quorum_id)
        .execute()
    )
    tags_by_role: dict[str, list[str]] = {
        cfg["role_id"]: cfg.get("domain_tags") or []
        for cfg in (cfg_resp.data or [])
    }

    contrib_resp = (
        db.table("contributions")
        .select("role_id")
        .eq("quorum_id", quorum_id)
        .execute()
    )
    contrib_counts: dict[str, int] = {}
    for c in contrib_resp.data or []:
        rid = c.get("role_id")
        if rid:
            contrib_counts[rid] = contrib_counts.get(rid, 0) + 1

    # Most-recent agent_requests row per (from, to) pair drives
    # interactionType.  Pull the latest 200 rows (descending); the first row
    # seen for a pair is the freshest.
    requests_resp = (
        db.table("agent_requests")
        .select("from_role_id, to_role_id, request_type, created_at")
        .eq("quorum_id", quorum_id)
        .order("created_at", desc=True)
        .limit(200)
        .execute()
    )
    pair_interaction: dict[tuple[str, str], str] = {}
    for row in requests_resp.data or []:
        f = row.get("from_role_id")
        t = row.get("to_role_id")
        if not f or not t or f == t:
            continue
        key = tuple(sorted((f, t)))
        if key in pair_interaction:
            continue
        pair_interaction[key] = row.get("request_type") or ""

    def _interaction_type(role_a: str, role_b: str) -> str:
        key = tuple(sorted((role_a, role_b)))
        rt = pair_interaction.get(key)
        if rt in ("conflict_flag", "negotiation", "escalation"):
            return "conflicting"
        if rt in ("input_request", "review_request"):
            return "requesting"
        if rt == "doc_edit_notify":
            return "collaborative"
        return "none"

    nodes = []
    role_ids: list[str] = []
    for role in roles:
        rid = role["id"]
        role_ids.append(rid)
        nodes.append({
            "id": rid,
            "label": role.get("name") or "(unnamed)",
            "activityCount": contrib_counts.get(rid, 0),
            "active": (role.get("status") or "active") == "active",
            "color": role.get("color") or "#94a3b8",
            "tags": tags_by_role.get(rid, []),
        })

    # Pairwise edge construction.  Threshold matches find_relevant_agents'
    # default (0.1 here, slightly looser than the 0.2 used for A2A fan-out
    # because the dashboard wants to show *some* connection between roles
    # that share at least one significant word — the fan-out path is
    # stricter because each edge there triggers an LLM call).
    _EDGE_THRESHOLD = 0.1
    edges = []
    for i, source_id in enumerate(role_ids):
        for target_id in role_ids[i + 1:]:
            weight = compute_tag_relevance(
                tags_by_role.get(source_id, []),
                tags_by_role.get(target_id, []),
            )
            if weight <= _EDGE_THRESHOLD:
                continue
            edges.append({
                "source": source_id,
                "target": target_id,
                "weight": float(weight),
                "interactionType": _interaction_type(source_id, target_id),
            })

    edges.sort(key=lambda e: e["weight"], reverse=True)

    return {"nodes": nodes, "edges": edges}


# ---------------------------------------------------------------------------
# GET /quorums/{quorum_id}/a2a-debug
# ---------------------------------------------------------------------------
# Debug-only endpoint to count agent_requests rows for a quorum.  Helps
# diagnose "A2A tab shows 0" issues by confirming whether rows actually
# exist server-side (and how recent) vs a frontend/realtime problem.
@router.get("/quorums/{quorum_id}/a2a-debug")
async def a2a_debug(quorum_id: str):
    db = get_supabase()
    result = (
        db.table("agent_requests")
        .select("id, from_role_id, to_role_id, request_type, created_at, status")
        .eq("quorum_id", quorum_id)
        .order("created_at", desc=True)
        .limit(20)
        .execute()
    )
    rows = result.data or []
    return {
        "total_returned": len(rows),
        "newest": rows[0].get("created_at") if rows else None,
        "by_type": {
            t: sum(1 for r in rows if r.get("request_type") == t)
            for t in {r.get("request_type") for r in rows}
        },
        "rows": rows[:5],
    }


# ---------------------------------------------------------------------------
# POST /quorums/{quorum_id}/refresh-snapshot
# ---------------------------------------------------------------------------
# Re-runs ONLY the position-snapshot synthesis (initial + final) without
# touching the artifact.  Used to backfill snapshots when the original
# /resolve call's snapshot step failed silently (the LLM occasionally
# produces output the validator drops, leaving both columns NULL while
# the artifact itself wrote successfully).
@router.post("/quorums/{quorum_id}/refresh-snapshot")
async def refresh_position_snapshot(quorum_id: str):
    db = get_supabase()
    _fetch_single(db, "quorums", "id", quorum_id, select="id, status", label="Quorum")

    # Force-rerun initial first (writes only if NULL), then final (always writes).
    initial_ok = False
    final_ok = False
    try:
        await _persist_position_snapshot(quorum_id, "initial")
        initial_ok = True
    except Exception:
        logger.warning(
            "refresh-snapshot: initial synthesis failed for %s", quorum_id, exc_info=True,
        )
    try:
        await _persist_position_snapshot(quorum_id, "final")
        final_ok = True
    except Exception:
        logger.warning(
            "refresh-snapshot: final synthesis failed for %s", quorum_id, exc_info=True,
        )

    # Read back to confirm what landed (the snapshot helper writes the artifact
    # row directly; we report what's on disk so the frontend can warn if a
    # snapshot still didn't materialize after the retry).
    artifact_row = (
        db.table("artifacts")
        .select("initial_position, final_position")
        .eq("quorum_id", quorum_id)
        .order("version", desc=True)
        .limit(1)
        .execute()
    )
    has_initial = False
    has_final = False
    if artifact_row.data:
        has_initial = artifact_row.data[0].get("initial_position") is not None
        has_final = artifact_row.data[0].get("final_position") is not None
    return {
        "initial_attempt_ok": initial_ok,
        "final_attempt_ok": final_ok,
        "has_initial": has_initial,
        "has_final": has_final,
    }


# ---------------------------------------------------------------------------
# POST /quorums/{quorum_id}/resolve
# ---------------------------------------------------------------------------
@router.post("/quorums/{quorum_id}/resolve", response_model=ResolveResponse)
async def resolve_quorum(quorum_id: str, body: ResolveRequest):
    db = get_supabase()

    quorum_result = _fetch_single(db, "quorums", "id", quorum_id, label="Quorum")
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

    # --- Before/After: capture final-position snapshot ---
    # Tier-3 synthesis has landed; capture a typed PositionSnapshot of where
    # the group ended up.  Awaited (not fire-and-forget) so the snapshot is
    # guaranteed to be present when the frontend re-reads the artifact after
    # /resolve returns — the Before/After view is the key expo visual and
    # mustn't show "still gathering data" right after resolve.  Wrapped in
    # try/except so a snapshot failure doesn't fail an already-successful
    # resolve.
    try:
        await _persist_position_snapshot(quorum_id, "final")
    except Exception:
        logger.warning(
            "resolve: final position snapshot failed for quorum=%s",
            quorum_id, exc_info=True,
        )

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
    _fetch_single(db, "events", "id", event_id, select="id", label="Event")

    try:
        roles, short_title = await generate_roles_with_title(body.problem)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Role generation failed: {type(e).__name__}: {e}")
    problem_summary = _smart_title_from_problem(body.problem)
    return GenerateRolesResponse(
        roles=[r.model_dump() for r in roles],
        problem_summary=problem_summary,
        # If the LLM gave us a real short_title use it; otherwise fall back
        # to the deterministic first-sentence summary so the UI is never
        # blank.  Mock-mode and the legacy JSON-parse path both yield "".
        short_title=short_title or problem_summary,
    )


def _smart_title_from_problem(problem: str) -> str:
    """Default quorum title: first sentence of the problem, or first 100 chars at a word
    boundary. Avoids the prior `[:100]` which sliced mid-word.
    """
    import re
    text = problem.strip()
    if not text:
        return text
    m = re.match(r"^([^?.!]+[?.!])", text)
    candidate = m.group(1) if m else text
    if len(candidate) > 110:
        cut = candidate[:107].rsplit(" ", 1)[0]
        candidate = f"{cut}..."
    return candidate


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
    event = _fetch_single(db, "events", "id", event_id, select="id, slug", label="Event")

    quorum_id = str(uuid.uuid4())
    quorum_row = {
        "id": quorum_id,
        "event_id": event_id,
        "title": body.quorum_title,
        "description": body.problem[:500],
        "status": "open",
        "carousel_mode": "multi-view",
        "autonomy_level": body.autonomy_level,
    }
    db.table("quorums").insert(quorum_row).execute()

    # Insert roles from AI suggestions AND author one agent_configs row per
    # role.  Without the agent_configs write, every role falls back to the
    # generic prompt in agents/__init__.py and all agents sound identical
    # (bug fixed by checklist item 10.1).
    role_assignments: list[tuple[str, RoleSuggestion]] = []
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
        # RoleSuggestionResponse → RoleSuggestion (same shape; explicit
        # construction keeps the dataclass boundary clear for tests).
        role_assignments.append(
            (
                role_id,
                RoleSuggestion(
                    name=role_def.name,
                    description=role_def.description,
                    authority_rank=role_def.authority_rank,
                    capacity=role_def.capacity,
                    suggested_prompt_focus=role_def.suggested_prompt_focus,
                    system_prompt=role_def.system_prompt,
                    domain_tags=role_def.domain_tags,
                    temperature=role_def.temperature,
                    model=role_def.model,
                ),
            )
        )

        # Register the role's A2A endpoint so other agents and external A2A
        # peers can discover this role's /a2a/agents/{role_id} URL.  This
        # replaces the v0 process-local _agent_registry dict — once the row
        # is in agent_endpoints, any worker can route to this agent.
        try:
            from quorum_a2a.a2a_server import register_endpoint

            register_endpoint(
                role_id,
                capabilities={
                    "name": role_def.name,
                    "authority_rank": role_def.authority_rank,
                    "suggested_prompt_focus": getattr(
                        role_def, "suggested_prompt_focus", None
                    ),
                },
                db=db,
            )
        except Exception:
            logger.warning(
                "architect_ai_start: failed to register A2A endpoint for role %s",
                role_id, exc_info=True,
            )

    # Persist persona configs (failures are logged but non-fatal).
    persist_agent_configs(db, quorum_id, role_assignments)

    # Auto-activate if mode is "auto"
    if body.mode == "auto":
        db.table("quorums").update({"status": "active"}).eq("id", quorum_id).execute()

    # Start autonomy loop if autonomy_level > 0 — mirrors the manual create-quorum path
    if body.autonomy_level > 0:
        from autonomy_loop import start_autonomy_loop
        asyncio.create_task(start_autonomy_loop(quorum_id, body.autonomy_level))

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
    _fetch_single(db, "quorums", "id", quorum_id, select="id", label="Quorum")

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
    _fetch_single(db, "quorums", "id", quorum_id, select="id", label="Quorum")
    try:
        reply, message_id, tags = await process_agent_turn(
            quorum_id=quorum_id,
            role_id=body.role_id,
            station_id=station_id,
            user_message=body.content,
            supabase_client=db,
            llm_provider=llm_provider,
            participant_id=body.participant_id,
        )
    except Exception:
        logger.error(
            "ask_facilitator: agent turn failed quorum=%s station=%s",
            quorum_id, station_id, exc_info=True,
        )
        raise HTTPException(status_code=500, detail="Agent turn failed")

    # Paused sentinel: the LLM call failed inside process_agent_turn. Do NOT
    # broadcast a reply (it would be spoken on the projector) and do NOT
    # write an assistant message — return a structured paused response so the
    # frontend can render a quiet "reconnecting" pill.
    if is_paused_reply(reply, tags):
        logger.warning(
            "ask_facilitator: facilitator paused",
            extra={
                "quorum_id": quorum_id,
                "station_id": station_id,
                "role_id": body.role_id,
                "reason": "llm_unavailable",
            },
        )
        await manager.broadcast(quorum_id, {
            "type": "facilitator_paused",
            "data": {
                "station_id": station_id,
                "role_id": body.role_id,
                "reason": "llm_unavailable",
            },
        })
        return AskResponse(
            reply=None,
            message_id=None,
            tags=[],
            paused=True,
            reason="llm_unavailable",
        )

    # Recompute health score so the dashboard chart moves on every chat turn
    # too — not just on structured-fields /contribute calls.  Without this,
    # human-driven conversation never UPDATEs the quorums row, useQuorumLive
    # never appends a new history point, and the line stays flat unless
    # autonomy mode happens to bump some other column on the same row.
    try:
        roles_data = db.table("roles").select("*").eq("quorum_id", quorum_id).execute()
        contribs_data = db.table("contributions").select("*").eq("quorum_id", quorum_id).execute()
        artifact_result = db.table("artifacts").select("*").eq("quorum_id", quorum_id).execute()
        artifact = artifact_result.data[0] if artifact_result.data else None
        health_score, metrics = calculate_health_score(
            roles_data.data,
            contribs_data.data,
            artifact,
            activity_count=fetch_activity_count(db, quorum_id),
        )
        db.table("quorums").update(
            {"heat_score": health_score, "metrics": metrics}
        ).eq("id", quorum_id).execute()
        # The agent reply itself was processed by ``_apply_llm_metric_deltas``
        # inside process_agent_turn (above), which has already persisted any
        # new deltas + rationales.  Reload them here so the broadcast carries
        # the current cumulative reading alongside the recomputed health
        # score — same shape as the contribute() broadcast.
        try:
            delta_row = (
                db.table("quorums")
                .select("llm_metric_deltas, llm_metric_rationales")
                .eq("id", quorum_id)
                .maybe_single()
                .execute()
            )
            delta_data = (delta_row.data if delta_row else None) or {}
            llm_deltas_running = delta_data.get("llm_metric_deltas") or {}
            llm_rationales = delta_data.get("llm_metric_rationales") or []
        except Exception:
            llm_deltas_running = {}
            llm_rationales = []
        await manager.broadcast(quorum_id, {
            "type": "health_update",
            "data": {
                "score": health_score,
                "metrics": metrics,
                "llm_deltas": llm_deltas_running,
                "llm_rationales": llm_rationales[-5:],
            },
        })
    except Exception:
        logger.warning(
            "ask_facilitator: health recompute failed quorum=%s",
            quorum_id, exc_info=True,
        )

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

    _fetch_single(db, "quorums", "id", quorum_id, select="id", label="Quorum")

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
    doc_check = _fetch_single(db, "agent_documents", "id", doc_id, select="id, quorum_id", label="Document")
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
    _fetch_single(db, "quorums", "id", quorum_id, select="id", label="Quorum")

    # Verify both roles exist
    for label, rid in [("from_role_id", body.from_role_id), ("to_role_id", body.to_role_id)]:
        _fetch_single(db, "roles", "id", rid, select="id", label=f"Role ({label})")

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

    Only available when QUORUM_TEST_MODE=true.  In production, use
    scripts/seed-agent-documents.py with the service role key.
    """
    if os.environ.get("QUORUM_TEST_MODE", "").lower() not in ("true", "1", "yes"):
        raise HTTPException(
            status_code=403,
            detail="seed-documents is only available when QUORUM_TEST_MODE=true",
        )
    db = get_supabase()

    # Verify event + quorum exist and are related
    result = db.table("quorums").select("id, title, event_id").eq("id", quorum_id).eq("event_id", event_id).maybe_single().execute()
    if not result or not result.data:
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
# PATCH /quorums/{quorum_id}/autonomy
# ---------------------------------------------------------------------------
@router.patch("/quorums/{quorum_id}/autonomy")
async def update_autonomy(quorum_id: str, body: dict):
    """Update autonomy_level for a quorum (architect control)."""
    autonomy_level = body.get("autonomy_level", 0.0)
    if not 0.0 <= autonomy_level <= 1.0:
        raise HTTPException(status_code=422, detail="autonomy_level must be 0.0-1.0")

    db = get_supabase()
    db.table("quorums").update({"autonomy_level": autonomy_level}).eq("id", quorum_id).execute()

    # Start or stop the autonomy loop
    from autonomy_loop import start_autonomy_loop, stop_autonomy_loop
    if autonomy_level > 0:
        await start_autonomy_loop(quorum_id, autonomy_level)
    else:
        await stop_autonomy_loop(quorum_id)

    return {"quorum_id": quorum_id, "autonomy_level": autonomy_level}


# ---------------------------------------------------------------------------
# PATCH /quorums/{quorum_id}/auto-promote-chat
# ---------------------------------------------------------------------------
@router.patch("/quorums/{quorum_id}/auto-promote-chat")
async def update_auto_promote_chat(quorum_id: str, body: dict):
    """Toggle whether agent chat replies auto-promote into ``contributions``.

    When enabled (the column default), ``process_agent_turn`` runs the Tier-2
    analyzer on every agent reply; replies that score above the
    contribution-worthy threshold land as new contribution rows so the chart
    moves on its own during conversation.  See
    ``agent_engine._maybe_auto_promote_contribution``.
    """
    raw = body.get("auto_promote_chat")
    if not isinstance(raw, bool):
        raise HTTPException(
            status_code=422,
            detail="auto_promote_chat must be a boolean",
        )

    db = get_supabase()
    # Verify the quorum exists so we don't silently no-op on a typo'd id.
    _fetch_single(db, "quorums", "id", quorum_id, select="id", label="Quorum")
    db.table("quorums").update(
        {"auto_promote_chat": raw}
    ).eq("id", quorum_id).execute()

    return {"quorum_id": quorum_id, "auto_promote_chat": raw}


# ---------------------------------------------------------------------------
# POST /sessions/participant — mint a participant on QR scan / laptop load
# ---------------------------------------------------------------------------
@router.post(
    "/sessions/participant",
    response_model=CreateParticipantResponse,
    status_code=201,
)
async def create_participant(body: CreateParticipantRequest):
    """Mint a participant row for a QR scan or station first-load.

    No JWT, no token exchange — just a UUID.  The caller stores the returned
    ``participant_id`` in sessionStorage and includes it on every subsequent
    contribute/heartbeat call so the system knows WHICH human said what.

    ``display_name`` is auto-assigned by counting existing rows for the same
    (quorum_id, station_label) and incrementing: "Visitor 1", "Visitor 2", ...
    """
    if body.device_kind not in ("laptop", "phone"):
        raise HTTPException(
            status_code=422,
            detail="device_kind must be 'laptop' or 'phone'",
        )

    db = get_supabase()

    # Verify quorum exists — 404 if not.
    _fetch_single(db, "quorums", "id", body.quorum_id, select="id", label="Quorum")

    # Verify role exists when provided.
    if body.role_id is not None:
        _fetch_single(db, "roles", "id", body.role_id, select="id", label="Role")

    # Count existing visitors at this station to assign the next display_name.
    existing_query = (
        db.table("participants")
        .select("id")
        .eq("quorum_id", body.quorum_id)
    )
    if body.station_label is not None:
        existing_query = existing_query.eq("station_label", body.station_label)
    existing = existing_query.execute()
    visitor_number = len(existing.data or []) + 1
    display_name = f"Visitor {visitor_number}"

    participant_id = str(uuid.uuid4())
    row = {
        "id": participant_id,
        "quorum_id": body.quorum_id,
        "role_id": body.role_id,
        "station_label": body.station_label,
        "display_name": display_name,
        "device_kind": body.device_kind,
    }
    db.table("participants").insert(row).execute()

    return CreateParticipantResponse(
        participant_id=participant_id,
        display_name=display_name,
    )


# ---------------------------------------------------------------------------
# POST /sessions/heartbeat — refresh last_heartbeat_at for presence
# ---------------------------------------------------------------------------
@router.post("/sessions/heartbeat", status_code=204)
async def heartbeat(body: HeartbeatRequest):
    """Refresh the participant's last_heartbeat_at timestamp.

    Used by the station page to advertise presence (every 30s).  Returns
    204 No Content on success, 404 when the participant_id is unknown.
    """
    db = get_supabase()

    # Verify participant exists — 404 if not.
    _fetch_single(
        db, "participants", "id", body.participant_id,
        select="id", label="Participant",
    )

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    db.table("participants").update(
        {"last_heartbeat_at": now}
    ).eq("id", body.participant_id).execute()

    # FastAPI infers 204 from the route decorator; returning None is correct.
    return None


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
