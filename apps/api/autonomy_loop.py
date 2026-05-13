"""Autonomy loop — drives agent-to-agent communication based on autonomy_level.

When autonomy_level > 0, agents proactively:
- Process pending A2A requests
- Generate insights and share with relevant agents
- Start conversations to solve the quorum's problem
- At high autonomy (>0.7), generate contributions toward resolution

The loop runs as a FastAPI background task, polling at intervals
inversely proportional to autonomy_level.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import uuid
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

# How long a row may sit in 'processing' before the reaper treats it as
# abandoned and flips it back to 'pending'. Tuned to be larger than the
# slowest expected LLM round-trip (~10s) plus jitter, but small enough that
# a crashed worker's claims don't permanently block a request.
_STALE_PROCESSING_TIMEOUT_S = 60


def _now_iso() -> str:
    """ISO-8601 UTC timestamp matching the DB default format."""
    return datetime.now(timezone.utc).isoformat()


def _extract_a2a_reply(a2a_response: dict) -> str | None:
    """Pull the reply text out of an A2A SendMessageResponse dict.

    The /message:send handler wraps the agent's reply in a Task whose
    ``history`` contains a single ROLE_AGENT message with a text part, plus
    an artifact with the same text. We look in both places (history first)
    so we tolerate minor server-side schema variations.

    Returns None when no text can be extracted — caller should fall back
    to the direct ``process_agent_turn`` path.
    """
    if not isinstance(a2a_response, dict):
        return None
    task = a2a_response.get("task") or {}
    history = task.get("history") or []
    for msg in history:
        for part in (msg or {}).get("parts", []) or []:
            text = part.get("text") if isinstance(part, dict) else None
            if text:
                return text
    for art in task.get("artifacts") or []:
        for part in (art or {}).get("parts", []) or []:
            text = part.get("text") if isinstance(part, dict) else None
            if text:
                return text
    return None

# Loop is managed by these module-level vars
_active_loops: dict[str, asyncio.Task] = {}  # quorum_id -> task


async def start_autonomy_loop(quorum_id: str, autonomy_level: float):
    """Start the autonomy loop for a quorum. Called when quorum is created or autonomy changes."""
    if autonomy_level <= 0:
        return
    if quorum_id in _active_loops:
        _active_loops[quorum_id].cancel()
    _active_loops[quorum_id] = asyncio.create_task(
        _run_quorum_loop(quorum_id, autonomy_level)
    )


async def stop_autonomy_loop(quorum_id: str):
    """Stop the autonomy loop for a quorum."""
    task = _active_loops.pop(quorum_id, None)
    if task:
        task.cancel()


async def _run_quorum_loop(quorum_id: str, autonomy_level: float):
    """Main loop for a single quorum's autonomous agents."""
    from database import get_supabase
    from llm import llm_provider

    # Poll interval: 30s at autonomy 0.1, 3s at autonomy 1.0
    base_interval = max(3, int(30 * (1.0 - autonomy_level)))

    logger.info(
        "Autonomy loop started for quorum %s (level=%.1f, interval=%ds)",
        quorum_id,
        autonomy_level,
        base_interval,
    )

    try:
        # Initial delay to let quorum setup complete
        await asyncio.sleep(2)

        round_num = 0
        while True:
            round_num += 1
            try:
                await _run_autonomy_round(
                    quorum_id,
                    autonomy_level,
                    round_num,
                    get_supabase(),
                    llm_provider,
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error(
                    "Autonomy round failed for quorum %s",
                    quorum_id,
                    exc_info=True,
                )

            # Add jitter to prevent thundering herd
            jitter = random.uniform(0.5, 1.5)
            await asyncio.sleep(base_interval * jitter)

            # Check if quorum is still active
            try:
                db = get_supabase()
                quorum = (
                    db.table("quorums")
                    .select("status")
                    .eq("id", quorum_id)
                    .maybe_single()
                    .execute()
                )
                if not quorum.data or quorum.data["status"] in ("resolved", "archived"):
                    logger.info(
                        "Quorum %s is %s -- stopping autonomy loop",
                        quorum_id,
                        quorum.data.get("status") if quorum.data else "gone",
                    )
                    break
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error(
                    "Status check failed for quorum %s — continuing loop",
                    quorum_id,
                    exc_info=True,
                )
                continue

    except asyncio.CancelledError:
        logger.info("Autonomy loop cancelled for quorum %s", quorum_id)
    finally:
        _active_loops.pop(quorum_id, None)


async def _run_autonomy_round(
    quorum_id: str,
    autonomy_level: float,
    round_num: int,
    db,
    llm_provider,
):
    """Execute one round of autonomous agent activity.

    Each round:
    1. Process any pending A2A requests (always, if autonomy > 0)
    2. Pick an agent to take a proactive turn (probability scales with autonomy)
    3. At high autonomy (>0.7), consider submitting contributions
    """
    from agent_engine import (
        is_paused_reply,
        process_a2a_request,
        process_agent_turn,
    )
    from ws_manager import manager

    # --- Phase 0: Reap stale 'processing' claims ---
    # If a worker crashed mid-LLM call (uvicorn restart, OOM, etc.), its row
    # stays stuck in 'processing' forever and the CAS-claim guard below will
    # never let any subsequent tick re-dispatch it. Flip any row older than
    # _STALE_PROCESSING_TIMEOUT_S back to 'pending' so the next iteration can
    # pick it up. Best-effort; never raises into the main loop.
    try:
        stale_cutoff = (
            datetime.now(timezone.utc) - timedelta(seconds=_STALE_PROCESSING_TIMEOUT_S)
        ).isoformat()
        reaped = (
            db.table("agent_requests")
            .update({"status": "pending", "claimed_at": None})
            .eq("quorum_id", quorum_id)
            .eq("status", "processing")
            .lt("claimed_at", stale_cutoff)
            .execute()
        )
        if reaped and getattr(reaped, "data", None):
            logger.info(
                "Reaped %d stale 'processing' A2A request(s) for quorum %s",
                len(reaped.data),
                quorum_id,
            )
    except Exception:
        logger.debug(
            "Reaper pass failed for quorum %s (non-fatal)", quorum_id, exc_info=True
        )

    # --- Phase 1: Process pending A2A requests ---
    pending = (
        db.table("agent_requests")
        .select("id, to_role_id, request_type, priority")
        .eq("quorum_id", quorum_id)
        .eq("status", "pending")
        .order("priority", desc=True)
        .limit(5)
        .execute()
    )

    for req in pending.data or []:
        # CAS-claim: atomically flip status pending -> processing. The
        # .eq("status", "pending") clause is the compare-and-swap guard: if
        # another tick (or another worker) already claimed this row, the
        # update affects 0 rows and we skip without calling the LLM. This is
        # the core fix for the duplicate-dispatch race at autonomy_level=1.0
        # where base_interval can drop to ~1.5s with jitter.
        try:
            claim = (
                db.table("agent_requests")
                .update({"status": "processing", "claimed_at": _now_iso()})
                .eq("id", req["id"])
                .eq("status", "pending")
                .execute()
            )
        except Exception:
            logger.warning(
                "CAS-claim of A2A request %s raised; skipping",
                req["id"],
                exc_info=True,
            )
            continue

        if not getattr(claim, "data", None):
            # Another worker won the race — leave it alone.
            logger.debug(
                "A2A request %s already claimed by another tick", req["id"]
            )
            continue

        try:
            from agent_engine import PAUSED_SENTINEL

            a2a_result = await process_a2a_request(req["id"], db, llm_provider)
            if a2a_result == PAUSED_SENTINEL:
                # LLM was unavailable for this turn. Do NOT persist a canned
                # ack reply (mirrors the 10.6 fix on the A2A path). Flip the
                # claim back to ``pending`` with ``claimed_at=NULL`` so the
                # reaper-style behaviour is consistent and the next tick
                # retries the same request.
                try:
                    db.table("agent_requests").update(
                        {"status": "pending", "claimed_at": None}
                    ).eq("id", req["id"]).execute()
                except Exception:
                    logger.warning(
                        "Failed to revert paused A2A request %s back to pending",
                        req["id"],
                        exc_info=True,
                    )
                logger.info(
                    "A2A request %s paused (LLM unavailable); reverted to pending for retry",
                    req["id"],
                )
                continue

            logger.info(
                "Auto-processed A2A request %s -> %s",
                req["id"],
                req["request_type"],
            )
            # Broadcast A2A activity to connected clients
            await manager.broadcast(
                quorum_id,
                {
                    "type": "a2a_activity",
                    "request_id": req["id"],
                    "request_type": req["request_type"],
                    "to_role_id": req["to_role_id"],
                },
            )
        except Exception:
            logger.warning(
                "Failed to auto-process A2A request %s",
                req["id"],
                exc_info=True,
            )

    # --- Phase 2: Proactive agent turns ---
    # Probability of a proactive turn scales with autonomy_level
    if random.random() > autonomy_level:
        return  # Skip proactive turn this round (more likely at low autonomy)

    # Get all active roles in this quorum
    roles = (
        db.table("roles")
        .select("id, name, status")
        .eq("quorum_id", quorum_id)
        .execute()
    )
    active_roles = [r for r in (roles.data or []) if r.get("status") == "active"]

    if not active_roles:
        return

    # --- Speaker election: Magentic-One style orchestrator ---
    # Replaces the legacy ``random.choice(active_roles)`` with a typed-output
    # facilitator that picks the next role based on relevance + anti-monopoly
    # and produces a one-sentence narration the avatar speaks while the
    # role-agent does its work. See ``agents/orchestrator.py`` and
    # docs/audit/2026-05-12-overnight-plan.html item 11.3.
    from agents.orchestrator import (
        antimonopoly_random_pick,
        next_turn as orchestrator_next_turn,
    )

    plan = await orchestrator_next_turn(quorum_id, db, llm_provider)

    # Find the most recent assistant speaker for the random fallback.
    last_speaker_id: str | None = None
    try:
        recent = (
            db.table("station_messages")
            .select("role_id, role, created_at")
            .eq("quorum_id", quorum_id)
            .eq("role", "assistant")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = recent.data or []
        if rows:
            last_speaker_id = rows[0].get("role_id")
    except Exception:
        logger.debug("autonomy: last-speaker lookup failed", exc_info=True)

    if plan is None:
        # Orchestrator unavailable (LLM error, parse fail, validation reject).
        # Fall back to anti-monopoly random pick so the demo keeps moving.
        role = antimonopoly_random_pick(active_roles, last_speaker_id)
        narration = None
        orchestrator_reason: str | None = None
    else:
        role = next(
            (r for r in active_roles if r["id"] == plan.next_speaker_role_id),
            active_roles[0],
        )
        narration = plan.narration
        orchestrator_reason = plan.reason

    station_id = f"auto-{role['id'][:8]}"

    # Broadcast the facilitator narration FIRST — the avatar speaks the
    # one-sentence rationale while the role-agent thinks. This is the
    # synthesisText AvatarPanel was missing (the TODO at lines 62-64).
    if narration:
        try:
            await manager.broadcast(
                quorum_id,
                {
                    "type": "facilitator_narration",
                    "narration": narration,
                    "next_role_id": role["id"],
                    "next_role_name": role.get("name"),
                    "reason": orchestrator_reason,
                },
            )
        except Exception:
            logger.debug("autonomy: facilitator_narration broadcast failed", exc_info=True)

    # Generate a proactive prompt based on the round and context
    quorum_data = (
        db.table("quorums")
        .select("title, description")
        .eq("id", quorum_id)
        .maybe_single()
        .execute()
    )
    quorum_title = (quorum_data.data or {}).get("title", "this problem")
    quorum_desc = (quorum_data.data or {}).get("description", "")

    # Get recent insights to inform the proactive prompt
    recent_insights = (
        db.table("agent_insights")
        .select("content, tags")
        .eq("quorum_id", quorum_id)
        .order("created_at", desc=True)
        .limit(3)
        .execute()
    )

    insight_context = ""
    if recent_insights.data:
        insight_summaries = [i["content"][:100] for i in recent_insights.data]
        insight_context = "\n\nRecent developments:\n" + "\n".join(
            f"- {s}" for s in insight_summaries
        )

    # Different prompt strategies based on round number and autonomy
    if round_num == 1:
        # First round: introduce yourself and assess the problem
        proactive_prompt = (
            f"The quorum '{quorum_title}' has just started. "
            f"Problem description: {quorum_desc}\n\n"
            "As your role in this quorum, introduce your perspective on this problem. "
            "What are the key considerations from your domain? What questions need answering?"
        )
    elif round_num <= 3:
        # Early rounds: build on each other's insights
        proactive_prompt = (
            f"Continue working on '{quorum_title}'. "
            f"{insight_context}\n\n"
            "Based on the current state of discussion, what new insights can you contribute "
            "from your role's perspective? If you see conflicts or gaps, flag them."
        )
    else:
        # Later rounds: drive toward resolution
        proactive_prompt = (
            f"The quorum '{quorum_title}' is progressing. "
            f"{insight_context}\n\n"
            "Assess the current state of progress. Identify any remaining gaps, "
            "propose concrete next steps, and work toward a resolution. "
            "If you need input from another role, request it explicitly."
        )

    # --- Dispatch the role-agent turn ---
    # Preferred path: A2A SDK so it goes through /message:send and we get end-
    # to-end confirmation that the LF A2A 1.0 wire format actually works on
    # our own infrastructure. Fallback to direct process_agent_turn when A2A
    # returns None (no endpoint registered, transport error, HTTP 5xx after
    # retries) — that keeps the demo responsive without a running uvicorn /
    # agent_endpoints table.
    reply: str | None = None
    msg_id: str | None = None
    tags: list[str] = []
    dispatch_path = "direct"
    try:
        from quorum_a2a.a2a_client import A2AClient

        a2a_client = A2AClient()
        a2a_result = await a2a_client.send_message(
            role["id"],
            {
                # Caller-shape: we send the proactive prompt as the text body.
                # The /message:send handler unpacks it into agent_engine and
                # we capture the reply from the SendMessageResponse artifact.
                "message": proactive_prompt,
                "type": "orchestrator_turn",
                "quorum_id": quorum_id,
                "reason": orchestrator_reason or "random fallback",
            },
        )
        if a2a_result is not None:
            # Pull the reply text out of the SendMessageResponse. The server
            # wraps the agent reply in a Task.history Message + an Artifact.
            reply = _extract_a2a_reply(a2a_result)
            dispatch_path = "a2a"
    except Exception:
        logger.debug("autonomy: A2A dispatch raised", exc_info=True)

    if reply is None:
        # Direct fallback — preserves all existing behaviour (persistence,
        # tag extraction, paused-sentinel handling) at the cost of bypassing
        # the A2A wire format.
        try:
            reply, msg_id, tags = await process_agent_turn(
                quorum_id=quorum_id,
                role_id=role["id"],
                station_id=station_id,
                user_message=proactive_prompt,
                supabase_client=db,
                llm_provider=llm_provider,
            )
        except Exception:
            logger.warning(
                "Proactive turn failed for role %s", role["id"], exc_info=True
            )
            return

    try:
        if is_paused_reply(reply, tags):
            # Facilitator paused — skip broadcasting activity for this round.
            # The agent will retry on the next autonomy tick.
            logger.warning(
                "autonomy_loop: proactive turn paused for role=%s round=%d",
                role["name"], round_num,
            )
        else:
            logger.info(
                "Proactive turn: role=%s round=%d tags=%s dispatch=%s",
                role["name"],
                round_num,
                tags[:3],
                dispatch_path,
            )

            # Broadcast activity
            await manager.broadcast(
                quorum_id,
                {
                    "type": "autonomous_activity",
                    "role_id": role["id"],
                    "role_name": role["name"],
                    "round": round_num,
                    "tags": tags[:5],
                    "dispatch": dispatch_path,
                },
            )
    except Exception:
        logger.warning(
            "Proactive-turn broadcast failed for role %s", role["id"], exc_info=True
        )

    # --- Phase 2.5: Authority arbitration sweep ---
    # After the speaker turn fires (and any new proposals it may have raised
    # via the blackboard), sweep open conflicts and resolve them by role
    # authority_rank.  Deterministic — no LLM call — and idempotent: an empty
    # blackboard or all-tied conflicts is a no-op except for log lines.
    # Checklist item 11.7.
    try:
        from agents.arbitrator import arbitrate_conflicts

        arbitration = await arbitrate_conflicts(db, quorum_id)
        if (
            arbitration["decisions_made"]
            or arbitration["dissents_recorded"]
            or arbitration["ties_unresolved"]
        ):
            try:
                await manager.broadcast(
                    quorum_id,
                    {
                        "type": "arbitration",
                        "decisions": arbitration["decisions_made"],
                        "dissents": arbitration["dissents_recorded"],
                        "ties_unresolved": arbitration["ties_unresolved"],
                    },
                )
            except Exception:
                logger.debug(
                    "autonomy: arbitration broadcast failed", exc_info=True
                )
    except Exception:
        logger.warning(
            "Authority arbitration failed for quorum %s (non-fatal)",
            quorum_id,
            exc_info=True,
        )

    # --- Phase 3: Auto-contribute at high autonomy ---
    # AUTONOMY_AUTO_CONTRIBUTE_MODE controls the behaviour:
    #   "off"        — never auto-submit. Humans drive contributions. (Default for
    #                  Duke Tech Expo 2026 — prevents fragment-salad artifacts on the
    #                  projector. See checklist item 10.9.)
    #   "concat"     — legacy behaviour: string-join the agent's last 3 assistant
    #                  messages as a contribution. Produces incoherent input for the
    #                  Tier 3 artifact synthesis.
    #   "synthesize" — pass the concatenated messages through an LLM call asking it
    #                  to combine them into one cohesive contribution stating the
    #                  role's position. Higher quality but adds an LLM call per turn.
    mode = os.environ.get("AUTONOMY_AUTO_CONTRIBUTE_MODE", "off").lower()
    if mode == "off":
        return
    if autonomy_level >= 0.7 and round_num >= 3:
        try:
            _maybe_auto_contribute(
                db, quorum_id, role, autonomy_level, round_num, mode=mode
            )
        except Exception:
            logger.warning(
                "Auto-contribute failed for role %s", role["id"], exc_info=True
            )


def _maybe_auto_contribute(db, quorum_id, role, autonomy_level, round_num, mode="concat"):
    """At high autonomy, agents can submit contributions toward resolution.

    Only contributes if:
    - autonomy_level >= 0.7
    - This role hasn't contributed yet
    - We've had enough rounds to have context

    Mode:
    - "concat":     legacy join-the-messages behaviour
    - "synthesize": LLM-synthesised single-position contribution
    """
    # Check if this role already has a contribution
    existing = (
        db.table("contributions")
        .select("id")
        .eq("quorum_id", quorum_id)
        .eq("role_id", role["id"])
        .limit(1)
        .execute()
    )
    if existing.data:
        return  # Already contributed

    # Get the latest station messages for this role as contribution content
    messages = (
        db.table("station_messages")
        .select("content, tags")
        .eq("quorum_id", quorum_id)
        .eq("role_id", role["id"])
        .eq("role", "assistant")
        .order("created_at", desc=True)
        .limit(3)
        .execute()
    )

    if not messages.data:
        return

    raw = " ".join(m["content"] for m in reversed(messages.data))
    if len(raw) < 50:
        return

    if mode == "synthesize":
        from llm import llm_provider
        from quorum_llm.models import LLMTier

        prompt = (
            f"Combine the following reflections from the '{role['name']}' role "
            f"into one cohesive contribution stating their position. Max 300 words. "
            f"Do not include meta-commentary, role labels, or section headers — "
            f"write it as if the role is speaking directly.\n\n"
            f"Reflections:\n{raw}"
        )
        try:
            combined = asyncio.get_event_loop().run_until_complete(
                llm_provider.complete(prompt, LLMTier.AGENT_CHAT)
            )
        except RuntimeError:
            combined = raw[:2000]
        except Exception:
            logger.warning(
                "Auto-contribute synthesize failed for role %s; falling back to concat",
                role["id"],
                exc_info=True,
            )
            combined = raw[:2000]
    else:
        combined = raw[:2000]

    contribution_id = str(uuid.uuid4())
    db.table("contributions").insert(
        {
            "id": contribution_id,
            "quorum_id": quorum_id,
            "role_id": role["id"],
            "user_token": f"agent-{role['id'][:8]}",
            "content": combined[:2000],  # Cap contribution length
            "structured_fields": {},
            "tier_processed": 1,
        }
    ).execute()

    logger.info(
        "Auto-contributed for role %s in quorum %s (mode=%s)",
        role["name"],
        quorum_id,
        mode,
    )
