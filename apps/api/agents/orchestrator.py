"""OrchestratorAgent — Magentic-One style facilitator over the role agents.

Replaces the legacy ``random.choice(active_roles)`` speaker election in the
autonomy loop with a typed-output Pydantic AI agent that holds the plan and
emits a structured ``OrchestratorPlan`` per round:

  * ``next_speaker_role_id`` — which role should take the next turn
  * ``reason``               — short rationale (for logs / debugging)
  * ``narration``            — one sentence the facilitator avatar will speak

The narration is the load-bearing piece: the avatar finally has a real LLM
voice (previously TODO'd in ``AvatarPanel.tsx``).  Instead of parroting the
last assistant message, the avatar narrates the orchestrator's turn plan —
"Asking the biostatistician to validate the sample size assumption" —
while the actual role-agent does its thinking.

Design notes
------------
* The system prompt explains the anti-monopoly rule (avoid the same speaker
  twice in a row) and the relevance heuristic so the LLM doesn't have to
  rediscover them on every call.
* We DON'T use ``Agent[..., OrchestratorPlan]`` typed output today.  The
  project's ``LLMProvider`` interface is the contract every callsite goes
  through (factory respects ``QUORUM_TEST_MODE``, swaps Mock/Azure/etc.).
  Adding a Pydantic AI ``Agent`` here would bypass that interface.  Instead
  we ask the LLM to return JSON and parse it with ``OrchestratorPlan`` —
  same pattern as ``architect_agent.suggest_roles``.  This keeps the typed
  contract on our side (Pydantic validation, defensive fallback) without
  forking the provider abstraction.
* On any LLM / parse failure, ``next_turn()`` returns ``None``.  The caller
  in ``autonomy_loop`` falls back to anti-monopoly random pick — the demo
  keeps moving regardless of LLM hiccups.

See checklist item 11.3 in ``docs/audit/2026-05-12-overnight-plan.html``.
"""

from __future__ import annotations

import json
import logging
import random
import re
from typing import Any

from pydantic import BaseModel, Field, ValidationError

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Output schema
# ---------------------------------------------------------------------------


class OrchestratorPlan(BaseModel):
    """Typed output the orchestrator produces per round.

    Fields:
        next_speaker_role_id: Role ID that should speak next.  MUST be one
            of the active roles passed in the prompt.  The caller validates
            this defensively in case the LLM hallucinates a UUID.
        reason: Short rationale (≤30 words) used in logs and as the A2A
            request body so the receiving role-agent knows why it was
            picked.
        narration: One sentence (≤25 words) the facilitator avatar will
            speak aloud.  Written in third person, present tense, e.g.
            "Asking the biostatistician to weigh in on sample size."
    """

    next_speaker_role_id: str = Field(min_length=1)
    reason: str = Field(min_length=1, max_length=400)
    narration: str = Field(min_length=1, max_length=400)


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------


ORCHESTRATOR_INSTRUCTIONS = (
    "You are the FACILITATOR of a real-time deliberation between role-agents "
    "(domain experts) working on a single problem. Your job is NOT to answer "
    "the problem — your job is to decide who speaks next, and to narrate that "
    "choice in one sentence so the audience (and the on-screen avatar) "
    "understands the flow.\n\n"
    "On each call you will see:\n"
    "  * the quorum title + description\n"
    "  * the list of active roles, with their names, IDs, and how many "
    "turns each has taken (turn-counter)\n"
    "  * the last few station messages so you can see what was just said\n"
    "  * any open insights / unresolved questions\n\n"
    "Rules for picking the next speaker:\n"
    "  1. ANTI-MONOPOLY. Do NOT pick the role who spoke most recently. "
    "Avoid picking the same role twice in a row.\n"
    "  2. RELEVANCE. Pick the role whose domain best matches the current open "
    "question. If a contribution explicitly named a domain (e.g. 'we need "
    "biostats input'), prefer that role.\n"
    "  3. COVERAGE. Prefer roles with the lowest turn-counter so far — give "
    "everyone a chance to speak.\n"
    "  4. NEVER invent a role_id. Pick one from the active-roles list "
    "verbatim.\n\n"
    "Output ONLY a valid JSON object (no markdown fences, no commentary) with "
    "these fields:\n"
    "  next_speaker_role_id: string (must be one of the active role IDs)\n"
    "  reason: short rationale (≤30 words)\n"
    "  narration: ONE sentence the avatar will speak (≤25 words). Third "
    "person, present tense, e.g. \"Asking the biostatistician to weigh in on "
    "sample size assumptions.\"\n"
)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


# Limits for the input context — keeps the LLM call snappy enough to stay
# under the ~3s demo budget called out in the spec's stop-conditions section.
_MAX_RECENT_MESSAGES = 6
_MAX_RECENT_INSIGHTS = 3
_PER_FIELD_TRUNCATE = 240


async def next_turn(quorum_id: str, db, llm_provider) -> OrchestratorPlan | None:
    """Run one orchestrator decision and return a typed plan.

    Args:
        quorum_id: ID of the quorum we're orchestrating.
        db:        Supabase / SQLite client (used by the project's other modules).
        llm_provider: An ``LLMProvider`` (azure / openai / mock / ...).

    Returns:
        A validated ``OrchestratorPlan`` on success, or ``None`` on any
        failure (DB read, LLM error, JSON parse, validation).  The caller
        MUST handle ``None`` by falling back to anti-monopoly random pick.

    Never raises.
    """
    try:
        active_roles = _load_active_roles(db, quorum_id)
        if not active_roles:
            return None

        quorum = _load_quorum(db, quorum_id)
        recent_messages = _load_recent_messages(db, quorum_id)
        recent_insights = _load_recent_insights(db, quorum_id)
        turn_counts = _compute_turn_counts(recent_messages, active_roles)

        user_content = _build_user_content(
            quorum=quorum,
            active_roles=active_roles,
            turn_counts=turn_counts,
            recent_messages=recent_messages,
            recent_insights=recent_insights,
        )

        raw = await _call_llm(llm_provider, user_content)
        plan = _parse_plan(raw)
        if plan is None:
            return None

        # Defensive: the LLM might hallucinate a role_id. Reject if the chosen
        # role isn't in the active set.
        valid_ids = {r["id"] for r in active_roles}
        if plan.next_speaker_role_id not in valid_ids:
            logger.warning(
                "orchestrator: LLM picked role_id=%s not in active set %s",
                plan.next_speaker_role_id,
                list(valid_ids)[:10],
            )
            return None

        return plan
    except Exception:
        logger.warning("orchestrator: next_turn failed", exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


async def _call_llm(llm_provider, user_content: str) -> str:
    """Drive the LLM through the project's ``LLMProvider`` interface.

    Prefers ``chat()`` (gives us a proper system/user split that benefits from
    prefix caching) and falls back to ``complete()`` on adapters that don't
    expose it. Mirrors the routing in ``agent_engine._call_llm``.
    """
    # LLMTier import is lazy because the test conftest installs a stub
    # quorum_llm.models late.
    from quorum_llm.models import LLMTier

    messages = [
        {"role": "system", "content": ORCHESTRATOR_INSTRUCTIONS},
        {"role": "user", "content": user_content},
    ]

    if hasattr(llm_provider, "chat"):
        try:
            return await llm_provider.chat(messages, LLMTier.AGENT_CHAT)
        except Exception:
            logger.warning(
                "orchestrator: chat() failed, falling back to complete()",
                exc_info=True,
            )

    flat = "\n".join(f"[{m['role']}]: {m['content']}" for m in messages)
    return await llm_provider.complete(flat, LLMTier.AGENT_CHAT)


def _parse_plan(raw: str) -> OrchestratorPlan | None:
    """Extract a JSON object from the LLM response and validate it.

    Tolerates markdown code-fence wrapping and surrounding prose because GPT
    deployments occasionally ignore the "no fences" instruction.
    """
    if not raw or not raw.strip():
        return None

    text = raw.strip()
    # Strip markdown code fences if the model added them
    text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
    text = re.sub(r"\n?```$", "", text)
    text = text.strip()

    # Pull the first {...} object out — the model sometimes prefixes a
    # one-liner explanation before the JSON.
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        text = match.group(0)

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("orchestrator: unparseable JSON: %s", text[:200])
        return None

    try:
        return OrchestratorPlan(**data)
    except ValidationError as exc:
        logger.warning("orchestrator: plan validation failed: %s", exc)
        return None


def _load_active_roles(db, quorum_id: str) -> list[dict]:
    """Load active roles + their architect-authored domain_tags (if any)."""
    try:
        result = (
            db.table("roles")
            .select("id, name, status, authority_rank")
            .eq("quorum_id", quorum_id)
            .execute()
        )
        rows = [r for r in (result.data or []) if r.get("status") == "active"]
    except Exception:
        logger.debug("orchestrator: roles lookup failed", exc_info=True)
        return []

    # Best-effort enrich with domain tags from agent_configs so the LLM can
    # match the current question to the right domain.
    by_role_id = {r["id"]: r for r in rows}
    try:
        cfg = (
            db.table("agent_configs")
            .select("role_id, domain_tags")
            .eq("quorum_id", quorum_id)
            .execute()
        )
        for row in cfg.data or []:
            role_id = row.get("role_id")
            if role_id in by_role_id:
                tags = row.get("domain_tags") or []
                if isinstance(tags, str):
                    try:
                        tags = json.loads(tags)
                    except Exception:
                        tags = []
                by_role_id[role_id]["domain_tags"] = tags or []
    except Exception:
        logger.debug("orchestrator: agent_configs enrich failed", exc_info=True)
        # Non-fatal — proceed without tags.

    return rows


def _load_quorum(db, quorum_id: str) -> dict:
    try:
        result = (
            db.table("quorums")
            .select("title, description")
            .eq("id", quorum_id)
            .maybe_single()
            .execute()
        )
        return result.data or {}
    except Exception:
        return {}


def _load_recent_messages(db, quorum_id: str) -> list[dict]:
    """Most recent station_messages (assistant + user) for orchestrator context."""
    try:
        result = (
            db.table("station_messages")
            .select("role_id, role, content, created_at")
            .eq("quorum_id", quorum_id)
            .order("created_at", desc=True)
            .limit(_MAX_RECENT_MESSAGES)
            .execute()
        )
        rows = result.data or []
    except Exception:
        logger.debug("orchestrator: station_messages lookup failed", exc_info=True)
        return []
    # Return chronologically so the LLM sees the natural reading order.
    return list(reversed(rows))


def _load_recent_insights(db, quorum_id: str) -> list[dict]:
    try:
        result = (
            db.table("agent_insights")
            .select("source_role_id, content, tags")
            .eq("quorum_id", quorum_id)
            .order("created_at", desc=True)
            .limit(_MAX_RECENT_INSIGHTS)
            .execute()
        )
        return result.data or []
    except Exception:
        return []


def _compute_turn_counts(
    recent_messages: list[dict], active_roles: list[dict]
) -> dict[str, int]:
    """Count assistant turns per role in the recent window.

    This is a "last N turns" approximation rather than a lifetime count —
    the spec calls it the "last-turn-counter" and that's what the LLM needs
    to apply the COVERAGE rule. Roles with no assistant message in the
    window get a count of 0.
    """
    counts: dict[str, int] = {r["id"]: 0 for r in active_roles}
    for m in recent_messages:
        if m.get("role") != "assistant":
            continue
        rid = m.get("role_id")
        if rid in counts:
            counts[rid] += 1
    return counts


def _build_user_content(
    *,
    quorum: dict,
    active_roles: list[dict],
    turn_counts: dict[str, int],
    recent_messages: list[dict],
    recent_insights: list[dict],
) -> str:
    """Format the orchestrator's input as a single user-message string."""
    title = (quorum or {}).get("title", "(untitled quorum)")
    desc = (quorum or {}).get("description", "")[:_PER_FIELD_TRUNCATE]

    # Most recent speaker so the LLM can apply anti-monopoly without re-scanning.
    last_speaker_id = ""
    for m in reversed(recent_messages):
        if m.get("role") == "assistant" and m.get("role_id"):
            last_speaker_id = m["role_id"]
            break

    role_lines: list[str] = []
    for r in active_roles:
        tags = r.get("domain_tags") or []
        tags_str = ", ".join(tags[:8]) if tags else "(no tags)"
        role_lines.append(
            f"  - id={r['id']} name={r['name']} "
            f"turn_counter={turn_counts.get(r['id'], 0)} "
            f"tags=[{tags_str}]"
        )

    msg_lines: list[str] = []
    for m in recent_messages:
        rid = m.get("role_id") or "?"
        body = (m.get("content") or "")[:_PER_FIELD_TRUNCATE]
        msg_lines.append(f"  [{m.get('role', '?')}] role_id={rid}: {body}")

    insight_lines: list[str] = []
    for ins in recent_insights:
        body = (ins.get("content") or "")[:_PER_FIELD_TRUNCATE]
        tags = ins.get("tags") or []
        tags_str = ", ".join(tags[:5]) if tags else ""
        suffix = f" [tags: {tags_str}]" if tags_str else ""
        insight_lines.append(f"  - {body}{suffix}")

    parts: list[str] = [
        f"Quorum: {title}",
        f"Description: {desc}" if desc else "",
        f"Last speaker role_id: {last_speaker_id or '(none yet)'}",
        "",
        "Active roles:",
        *role_lines,
        "",
        "Recent station messages (chronological):",
        *(msg_lines or ["  (none)"]),
        "",
        "Open insights:",
        *(insight_lines or ["  (none)"]),
        "",
        "Pick the next speaker now. Return JSON only.",
    ]
    return "\n".join(p for p in parts if p is not None)


# ---------------------------------------------------------------------------
# Fallback helper used by the autonomy loop on plan==None
# ---------------------------------------------------------------------------


def antimonopoly_random_pick(
    active_roles: list[dict],
    last_speaker_id: str | None,
    rng: random.Random | None = None,
) -> dict:
    """Pick a random role, preferring to avoid ``last_speaker_id``.

    Used by the autonomy loop when the orchestrator returns ``None``. We
    expose it here (rather than inlining in autonomy_loop) so tests can
    exercise the anti-monopoly behaviour without spinning up the loop.
    """
    if not active_roles:
        raise ValueError("antimonopoly_random_pick called with no active roles")
    if rng is None:
        rng = random
    if last_speaker_id and len(active_roles) > 1:
        candidates = [r for r in active_roles if r["id"] != last_speaker_id]
        if candidates:
            return rng.choice(candidates)
    return rng.choice(active_roles)
