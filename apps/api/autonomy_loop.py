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
import random
import uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

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
    from agent_engine import process_a2a_request, process_agent_turn
    from ws_manager import manager

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
        try:
            await process_a2a_request(req["id"], db, llm_provider)
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

    # Pick a random role to take a proactive turn
    role = random.choice(active_roles)
    station_id = f"auto-{role['id'][:8]}"

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

    try:
        reply, msg_id, tags = await process_agent_turn(
            quorum_id=quorum_id,
            role_id=role["id"],
            station_id=station_id,
            user_message=proactive_prompt,
            supabase_client=db,
            llm_provider=llm_provider,
        )
        logger.info(
            "Proactive turn: role=%s round=%d tags=%s",
            role["name"],
            round_num,
            tags[:3],
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
            },
        )
    except Exception:
        logger.warning(
            "Proactive turn failed for role %s", role["id"], exc_info=True
        )

    # --- Phase 3: Auto-contribute at high autonomy ---
    if autonomy_level >= 0.7 and round_num >= 3:
        # At high autonomy after a few rounds, agents can submit contributions
        # to move toward resolution
        try:
            _maybe_auto_contribute(db, quorum_id, role, autonomy_level, round_num)
        except Exception:
            logger.warning(
                "Auto-contribute failed for role %s", role["id"], exc_info=True
            )


def _maybe_auto_contribute(db, quorum_id, role, autonomy_level, round_num):
    """At high autonomy, agents can submit contributions toward resolution.

    Only contributes if:
    - autonomy_level >= 0.7
    - This role hasn't contributed yet
    - We've had enough rounds to have context
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

    # Synthesize a contribution from the agent's messages
    combined = " ".join(m["content"] for m in reversed(messages.data))
    if len(combined) < 50:
        return

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
        "Auto-contributed for role %s in quorum %s", role["name"], quorum_id
    )
