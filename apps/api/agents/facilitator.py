"""FacilitatorAgent — meta-narrator that sits above the OrchestratorAgent.

Where ``agents/orchestrator.py`` picks the *next speaker* and emits a
per-turn narration ("Asking the biostatistician to weigh in on sample
size."), the FacilitatorAgent runs **less frequently** (every Nth
orchestrator round) and produces a higher-level **observation** about the
deliberation as a whole — the thing the audience would want a thoughtful
narrator to point out.

Examples of observations the agent might emit:

  * "Three roles have raised the same enrollment risk; the IRB hasn't
    responded yet." (severity: ``action_needed``)
  * "The discussion has converged on a 2-arm RCT — the open question now
    is endpoint choice." (severity: ``notable``)
  * "Quiet so far — only the PI has spoken in the last two rounds."
    (severity: ``info``)

These get broadcast as ``facilitator_observation`` WS frames (distinct
from PR #14's per-turn ``facilitator_narration`` frame) so the projection
view, dashboard, or an ``ObservationStrip`` component below the avatar
can surface ambient meta-narration without overwriting the speaker
narration.

Tooling
-------
The facilitator's signals come from the four MCP servers built in
checklist item 11.2 (``apps/api/mcp_servers/``):

  * ``mcp_state``        — quorum blackboard state, open questions
  * ``mcp_authority``    — role roster + authority ranks
  * ``mcp_search``       — tag/text search over messages + insights
  * ``mcp_broadcast``    — emit the resulting observation as a WS frame

We invoke tools via FastMCP's in-process ``call_tool()`` surface — no
stdio plumbing needed — and use a thin **adapter** layer rather than
hooking the tools into Pydantic AI's ``Agent(tools=...)`` parameter
directly. Two reasons:

1. The repo's hard rule (CLAUDE.md): every LLM call must go through the
   ``LLMProvider`` interface so the factory can swap to MockLLMProvider
   in ``QUORUM_TEST_MODE``. Pydantic AI ``Agent(tools=[...])`` couples
   the tool runtime to the agent's Model/Provider — bypassing our
   factory means tests can't mock the LLM cheaply.
2. The facilitator's tool use is **deterministic**, not LLM-driven: it
   always pulls roster + state + recent search hits up front, hands
   them to the LLM as context, parses a typed observation back out, and
   optionally broadcasts. There's no need for the LLM to choose which
   tool to call.

The adapter (`MCPToolAdapter`) lets a unit test pass in a mock servers
dict and watch which tools were called with which args — see
``apps/api/tests/test_facilitator_agent.py``.

Output schema
-------------
``FacilitatorObservation``:

  * ``summary`` — one sentence, audience-facing (≤200 chars)
  * ``severity`` — ``"info" | "notable" | "action_needed"``
  * ``suggested_tool_calls`` — tool names the agent suggests for
    follow-up (transparency in logs only — we do NOT auto-execute them)
  * ``referenced_role_ids`` — role IDs the observation talks about (for
    avatar/UI highlighting)

Failure mode
------------
Like the orchestrator: ``observe()`` never raises. On any LLM / parse /
DB failure it logs a warning and returns ``None``. The autonomy_loop
hook treats ``None`` as "skip this round" — no observation broadcast.

See checklist item 9.4 in ``docs/audit/2026-05-12-overnight-plan.html``.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Output schema
# ---------------------------------------------------------------------------


Severity = Literal["info", "notable", "action_needed"]


class FacilitatorObservation(BaseModel):
    """Typed observation the facilitator produces per scheduled run.

    Fields:
        summary: One sentence, audience-facing. No robot-speak, no
            imperatives, no telling people what to do — just narrate
            what the deliberation is currently showing. Max ~200 chars.
        severity: Three-level escalation cue for the UI:
            - ``info``           : ambient, may be dimmed
            - ``notable``        : highlighted, normal weight
            - ``action_needed``  : surfaced prominently; e.g. a stale
              question that has gone unanswered.
        suggested_tool_calls: Tool names the agent thinks the
            facilitator (or a human operator) might want to take. We
            log these for transparency / future automation but do NOT
            execute them automatically.
        referenced_role_ids: Role IDs the observation mentions, so the
            UI can highlight the corresponding avatar / panel.
    """

    summary: str = Field(min_length=1, max_length=400)
    severity: Severity = "info"
    suggested_tool_calls: list[str] = Field(default_factory=list)
    referenced_role_ids: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------


FACILITATOR_INSTRUCTIONS = (
    "You are the FACILITATOR-NARRATOR for a real-time, multi-role deliberation. "
    "Picture an audience watching a live problem-solving session on a screen: your "
    "job is to be the calm, thoughtful voice that points out what is HAPPENING in "
    "the deliberation as a whole — not the play-by-play (that's the per-turn "
    "narrator) but the meta-observations a good moderator would make to help the "
    "audience understand where things stand.\n"
    "\n"
    "What you will receive on each call:\n"
    "  * The quorum title and short description.\n"
    "  * The list of active roles (id, name, authority rank).\n"
    "  * The current state summary (open proposals, open questions, recent "
    "contributions, etc.).\n"
    "  * The most recent search hits for messages and insights.\n"
    "\n"
    "Rules of voice (treat these as load-bearing):\n"
    "  1. CALM. One sentence. No exclamation marks. No 'Important:' prefixes.\n"
    "  2. NARRATIVE, NOT DIRECTIVE. Describe what the deliberation is showing — "
    "don't tell people what to do. 'Three roles flagged enrollment risk; the IRB "
    "hasn't weighed in yet.' Not 'The IRB needs to respond now.'\n"
    "  3. NEVER DUPLICATE the per-turn narrator. The orchestrator already says "
    "'Asking the biostatistician to weigh in.' Don't repeat that. Look at "
    "PATTERNS across multiple turns instead.\n"
    "  4. PICK ONE thing to surface. If three things are interesting, pick the "
    "most audience-relevant one (usually: a stale open question, a convergence, "
    "or a quiet-role pattern).\n"
    "  5. NO ROBOT-SPEAK. Avoid 'I notice', 'It appears', 'Based on the data'. "
    "Just describe.\n"
    "\n"
    "Severity guide:\n"
    "  * 'info'          — ambient. Things are progressing normally.\n"
    "  * 'notable'       — a real pattern worth surfacing (convergence, "
    "disagreement, a roughly equal split).\n"
    "  * 'action_needed' — something is stuck or being ignored that the "
    "audience should notice. Use sparingly.\n"
    "\n"
    "Output ONLY a valid JSON object (no markdown fences, no commentary) with "
    "these fields:\n"
    "  summary:               string (one sentence, ≤200 chars)\n"
    "  severity:              'info' | 'notable' | 'action_needed'\n"
    "  suggested_tool_calls:  array of strings (tool names you'd suggest — for "
    "transparency only; empty array is fine)\n"
    "  referenced_role_ids:   array of role-id strings the observation talks "
    "about (empty array is fine)\n"
)


# ---------------------------------------------------------------------------
# MCP tool adapter
# ---------------------------------------------------------------------------


# The facilitator never auto-broadcasts via the MCP tool — autonomy_loop
# does the broadcast so the WS frame keeps its existing shape and the
# caller can still log/inspect the result. But the broadcast tool name is
# kept in the registered surface so ``suggested_tool_calls`` can reference
# it and so a future operator UI can wire it up directly.
_FACILITATOR_TOOL_REGISTRY: dict[str, tuple[str, str]] = {
    # (server_key, tool_name)
    "get_quorum_state":      ("state",     "get_quorum_state"),
    "raise_question":        ("state",     "raise_question"),
    "list_roles_by_quorum":  ("authority", "list_roles_by_quorum"),
    "compare_authority":     ("authority", "compare_authority"),
    "search_messages":       ("search",    "search_messages"),
    "search_insights":       ("search",    "search_insights"),
    "broadcast":             ("broadcast", "broadcast"),
}


def facilitator_tool_names() -> list[str]:
    """Public tool surface the facilitator exposes.

    This is the canonical list of MCP tools the facilitator agent
    can route through. Tests assert against this. The list is a
    deliberate SUBSET of 11.2's 11-tool full surface — the facilitator
    is read-mostly (it observes, it doesn't propose/support/block).
    """
    return list(_FACILITATOR_TOOL_REGISTRY.keys())


class MCPToolAdapter:
    """Thin bridge from a friendly tool name to the right FastMCP server.

    Use::

        servers = build_all_servers(db, ws_manager)
        tools = MCPToolAdapter(servers)
        state = await tools.call("get_quorum_state", {"quorum_id": "q1"})

    The adapter:
      * Looks the tool up in ``_FACILITATOR_TOOL_REGISTRY`` to find the
        right server.
      * Calls ``server.call_tool(name, args)`` via FastMCP's in-process
        protocol path — same one the unit tests in PR #21 exercise.
      * Normalises FastMCP's return (a tuple of ``(content_blocks,
        structured_data)`` for tools with output schemas, or just
        ``list[ContentBlock]`` otherwise) into a plain Python dict/list.

    Returns ``None`` on any failure (missing tool, server raised, no
    parseable output) so the caller can decide how to degrade.
    """

    def __init__(self, servers: dict[str, Any]) -> None:
        self._servers = servers
        self.calls: list[tuple[str, dict[str, Any]]] = []  # for tests/logging

    async def call(self, tool_name: str, args: dict[str, Any]) -> Any:
        entry = _FACILITATOR_TOOL_REGISTRY.get(tool_name)
        if entry is None:
            logger.debug("facilitator: unknown tool %r", tool_name)
            return None
        server_key, mcp_name = entry
        server = self._servers.get(server_key)
        if server is None:
            logger.debug("facilitator: server %r not available", server_key)
            return None

        self.calls.append((tool_name, dict(args)))
        try:
            result = await server.call_tool(mcp_name, args)
        except Exception:
            logger.warning(
                "facilitator: tool %r raised", tool_name, exc_info=True
            )
            return None
        return _normalise_fastmcp_result(result)


def _normalise_fastmcp_result(result: Any) -> Any:
    """Flatten FastMCP's call_tool return into a plain Python value.

    FastMCP returns one of:
      * ``tuple[list[ContentBlock], dict|list]`` — content + structured.
      * ``list[ContentBlock]`` — text-only result, JSON is in
        ``content[0].text``.
      * ``dict`` / ``list`` / plain value — direct return (rare).

    We always prefer the structured payload when it's present.

    Edge case: FastMCP's structured-output envelope wraps a top-level
    ``list`` in ``{"result": [...]}`` because JSON schemas require a
    root object. We unwrap that here so callers get the list they
    expected (e.g. ``list_roles_by_quorum`` returning ``list[dict]``).
    """
    # Tuple form: (content, structured)
    if isinstance(result, tuple) and len(result) == 2:
        payload = result[1]
        # Unwrap the {"result": [...]} envelope FastMCP wraps top-level
        # arrays in (JSON schemas can't be naked arrays).
        if (
            isinstance(payload, dict)
            and set(payload.keys()) == {"result"}
            and isinstance(payload["result"], list)
        ):
            return payload["result"]
        return payload
    # List-of-content form
    if isinstance(result, list) and result and hasattr(result[0], "text"):
        try:
            return json.loads(result[0].text)
        except (TypeError, ValueError):
            return None
    return result


# ---------------------------------------------------------------------------
# Context bundling
# ---------------------------------------------------------------------------


_PER_FIELD_TRUNCATE = 240
_MAX_RECENT_MESSAGES = 8
_MAX_RECENT_INSIGHTS = 5


def _truncate(s: Any, n: int = _PER_FIELD_TRUNCATE) -> str:
    text = "" if s is None else str(s)
    return text if len(text) <= n else text[:n] + "…"


async def _gather_signals(
    tools: MCPToolAdapter,
    quorum_id: str,
) -> dict[str, Any]:
    """Collect the read-only signals the facilitator needs as context.

    Returns a dict with::

        {
          "state":    <get_quorum_state result>,
          "roles":    <list_roles_by_quorum result>,
          "messages": <search_messages — broad "*" query, top_k=N>,
          "insights": <search_insights — broad "*" query, top_k=N>,
        }

    Any individual tool failure degrades to an empty list / dict; the
    caller still gets a usable context so the LLM can produce SOME
    observation (e.g., 'discussion is just getting started').
    """
    # Broad query — the search MCP scores by Jaccard tag overlap +
    # substring; an empty string matches nothing, so we use a stop-word
    # the seed data uses to surface recent activity. If nothing comes
    # back, that's fine — context shows "(no recent search hits)".
    state = await tools.call("get_quorum_state", {"quorum_id": quorum_id}) or {}
    roles = await tools.call("list_roles_by_quorum", {"quorum_id": quorum_id}) or []

    # Use a couple of broad-domain probes; the LLM only sees the merged
    # set so duplicates aren't a problem. Pull "the" and "what" — both
    # tokenise out by the search server (length>1 filter) — so this is
    # effectively "anything that mentions either common token". Worst
    # case: empty list, handled below.
    msgs_a = await tools.call(
        "search_messages",
        {"quorum_id": quorum_id, "query": "question concern issue risk",
         "top_k": _MAX_RECENT_MESSAGES},
    ) or []
    msgs_b = await tools.call(
        "search_messages",
        {"quorum_id": quorum_id, "query": "proposal endpoint design plan",
         "top_k": _MAX_RECENT_MESSAGES},
    ) or []
    # Dedupe by message_id preserving order.
    seen: set[str] = set()
    messages: list[dict[str, Any]] = []
    for m in (list(msgs_a) + list(msgs_b)):
        mid = m.get("message_id") if isinstance(m, dict) else None
        if mid and mid not in seen:
            seen.add(mid)
            messages.append(m)
        if len(messages) >= _MAX_RECENT_MESSAGES:
            break

    insights = await tools.call(
        "search_insights",
        {"quorum_id": quorum_id, "query": "question concern proposal",
         "top_k": _MAX_RECENT_INSIGHTS},
    ) or []

    return {
        "state": state if isinstance(state, dict) else {},
        "roles": list(roles) if isinstance(roles, list) else [],
        "messages": messages,
        "insights": list(insights) if isinstance(insights, list) else [],
    }


def _build_user_content(*, quorum_id: str, signals: dict[str, Any]) -> str:
    """Format the facilitator's input as a single user-message string."""
    state = signals.get("state") or {}
    quorum = state.get("quorum") or {}
    title = quorum.get("title") or "(untitled quorum)"
    desc = _truncate(quorum.get("description") or "")

    role_lines: list[str] = []
    for r in signals.get("roles") or []:
        role_lines.append(
            f"  - id={r.get('role_id')} name={r.get('name')} "
            f"authority={r.get('authority_rank')} "
            f"status={r.get('status', 'active')}"
        )

    # Open questions / proposals come from the state shim (11.6 will
    # replace this with structured fields). Be defensive — the shim
    # surface is a list of envelopes or empty lists.
    open_questions = state.get("questions") or []
    open_proposals = state.get("proposals") or []

    contribs = state.get("contributions") or []
    contrib_summary: list[str] = []
    for c in contribs[-6:]:  # last 6
        rid = c.get("role_id") or "?"
        content = _truncate(c.get("content") or "")
        contrib_summary.append(f"  - role_id={rid}: {content}")

    msg_lines: list[str] = []
    for m in signals.get("messages") or []:
        if not isinstance(m, dict):
            continue
        content = _truncate(m.get("content") or "")
        msg_lines.append(f"  - {content}")

    insight_lines: list[str] = []
    for i in signals.get("insights") or []:
        if not isinstance(i, dict):
            continue
        content = _truncate(i.get("content") or "")
        insight_lines.append(f"  - {content}")

    parts: list[str] = [
        f"Quorum: {title}",
        f"Description: {desc}" if desc else "",
        f"Quorum ID: {quorum_id}",
        "",
        "Active roles:",
        *(role_lines or ["  (no roles loaded)"]),
        "",
        f"Open questions ({len(open_questions)}):",
        *([f"  - {_truncate(q.get('body', q))}" for q in open_questions[:5]]
          or ["  (none)"]),
        "",
        f"Open proposals ({len(open_proposals)}):",
        *([f"  - {_truncate(p.get('body', p))}" for p in open_proposals[:5]]
          or ["  (none)"]),
        "",
        "Recent contributions:",
        *(contrib_summary or ["  (none)"]),
        "",
        "Recent messages (search-ranked):",
        *(msg_lines or ["  (none)"]),
        "",
        "Recent insights:",
        *(insight_lines or ["  (none)"]),
        "",
        "Produce ONE FacilitatorObservation now. Return JSON only.",
    ]
    return "\n".join(p for p in parts if p is not None)


# ---------------------------------------------------------------------------
# LLM call + parser (mirror the orchestrator's pattern)
# ---------------------------------------------------------------------------


async def _call_llm(llm_provider: Any, user_content: str) -> str:
    """Drive the LLM through the project's ``LLMProvider`` interface.

    Prefers ``chat()`` (system/user split benefits from prefix caching),
    falls back to ``complete()`` on adapters without it. Mirrors the
    routing in ``agents/orchestrator.py:_call_llm``.
    """
    # Lazy import — the test conftest installs a stub quorum_llm late.
    from quorum_llm.models import LLMTier

    messages = [
        {"role": "system", "content": FACILITATOR_INSTRUCTIONS},
        {"role": "user", "content": user_content},
    ]

    if hasattr(llm_provider, "chat"):
        try:
            return await llm_provider.chat(messages, LLMTier.AGENT_CHAT)
        except Exception:
            logger.warning(
                "facilitator: chat() failed, falling back to complete()",
                exc_info=True,
            )

    flat = "\n".join(f"[{m['role']}]: {m['content']}" for m in messages)
    return await llm_provider.complete(flat, LLMTier.AGENT_CHAT)


def _parse_observation(raw: str) -> FacilitatorObservation | None:
    """Extract a JSON object from the LLM response and validate it.

    Tolerates markdown fences and surrounding prose (same as the
    orchestrator) because GPT deployments occasionally wrap JSON in
    ```json fences despite the no-fences instruction.
    """
    if not raw or not raw.strip():
        return None

    text = raw.strip()
    # Strip markdown code fences if present
    text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
    text = re.sub(r"\n?```$", "", text)
    text = text.strip()

    # Pull the first {...} object out — tolerate leading prose.
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        text = match.group(0)

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("facilitator: unparseable JSON: %s", text[:200])
        return None

    try:
        return FacilitatorObservation(**data)
    except ValidationError as exc:
        logger.warning("facilitator: observation validation failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def observe(
    quorum_id: str,
    servers: dict[str, Any],
    llm_provider: Any,
) -> FacilitatorObservation | None:
    """Run one facilitator observation and return a typed result.

    Args:
        quorum_id: ID of the quorum we're observing.
        servers: A dict of MCP servers keyed by ``"state"``,
            ``"broadcast"``, ``"authority"``, ``"search"`` — i.e., the
            output of ``apps.api.mcp_servers.build_all_servers``.
        llm_provider: An ``LLMProvider`` (azure / openai / mock / ...).

    Returns:
        A validated ``FacilitatorObservation`` on success, or ``None``
        on any failure (DB read, LLM error, JSON parse, validation).
        The caller is expected to treat ``None`` as 'skip this round'.

    Never raises.
    """
    try:
        tools = MCPToolAdapter(servers)
        signals = await _gather_signals(tools, quorum_id)

        # If we have literally no roles, there's nothing to observe.
        if not signals.get("roles"):
            logger.debug(
                "facilitator: no roles loaded for quorum %s — skipping", quorum_id
            )
            return None

        user_content = _build_user_content(quorum_id=quorum_id, signals=signals)
        raw = await _call_llm(llm_provider, user_content)
        observation = _parse_observation(raw)
        if observation is None:
            return None

        # Defensive: drop referenced_role_ids that aren't in the active roster
        # so the UI doesn't try to highlight a hallucinated role.
        valid_role_ids = {
            r.get("role_id") for r in signals["roles"] if isinstance(r, dict)
        }
        observation.referenced_role_ids = [
            rid for rid in observation.referenced_role_ids if rid in valid_role_ids
        ]
        return observation
    except Exception:
        logger.warning("facilitator: observe() failed", exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Convenience: build + observe + broadcast in one call
# ---------------------------------------------------------------------------


async def run_and_broadcast(
    quorum_id: str,
    db: Any,
    ws_manager: Any,
    llm_provider: Any,
    round_num: int | None = None,
) -> FacilitatorObservation | None:
    """End-to-end: build the MCP servers, observe, broadcast, return.

    This is the entry point the autonomy_loop calls. We build the
    servers fresh each time (cheap — they hold no state beyond their db
    + ws_manager refs) so that swapping the db (e.g., in tests) doesn't
    leak across loop iterations.

    On success, broadcasts a ``facilitator_observation`` WS frame and
    returns the typed observation. On any failure or ``None`` from
    ``observe()``, returns ``None`` without broadcasting.

    Args:
        quorum_id: ID of the quorum we're observing.
        db: Supabase / SQLite client.
        ws_manager: ConnectionManager from ``apps/api/ws_manager.py``.
        llm_provider: An ``LLMProvider``.
        round_num: Optional orchestrator round number, included in the
            broadcast frame for downstream filtering / debug.

    Returns:
        The validated ``FacilitatorObservation`` or ``None``.

    Never raises.
    """
    try:
        # Local import — avoid pulling the MCP SDK at module load time so
        # the agent module remains importable in environments without
        # ``mcp`` installed (the orchestrator already faces this in CI).
        from apps.api.mcp_servers import build_all_servers
    except Exception:
        try:
            from mcp_servers import build_all_servers  # type: ignore[no-redef]
        except Exception:
            logger.warning(
                "facilitator: MCP servers not importable — skipping observation",
                exc_info=True,
            )
            return None

    try:
        servers = build_all_servers(db, ws_manager)
    except Exception:
        logger.warning(
            "facilitator: build_all_servers failed — skipping observation",
            exc_info=True,
        )
        return None

    observation = await observe(quorum_id, servers, llm_provider)
    if observation is None:
        return None

    # Broadcast via the WS manager directly rather than the broadcast MCP
    # tool. The frame shape is documented in docs/CONTRACT.md (under
    # WS /quorums/{id}/live).
    try:
        frame = {
            "type": "facilitator_observation",
            "summary": observation.summary,
            "severity": observation.severity,
            "referenced_role_ids": observation.referenced_role_ids,
            "suggested_tool_calls": observation.suggested_tool_calls,
        }
        if round_num is not None:
            frame["round"] = round_num
        await ws_manager.broadcast(quorum_id, frame)
    except Exception:
        logger.warning(
            "facilitator: failed to broadcast observation", exc_info=True
        )
        # Still return the observation so callers can persist / log it.
    return observation


# ---------------------------------------------------------------------------
# Cadence helper — keep the every-Nth-round logic out of autonomy_loop
# so tests can exercise it without spinning up the full loop.
# ---------------------------------------------------------------------------


# Default cadence: every 3rd orchestrator round. Picked so a 30-minute
# demo (~30 orchestrator rounds at 1-min cadence) emits ~10 observations
# — frequent enough to feel ambient, infrequent enough that the audience
# doesn't tune it out.
DEFAULT_OBSERVATION_EVERY_N_ROUNDS = 3


def should_observe_this_round(
    round_num: int,
    every_n: int = DEFAULT_OBSERVATION_EVERY_N_ROUNDS,
) -> bool:
    """Return True if the facilitator should run on ``round_num``.

    Cadence rule: fire on round 1 (so the audience gets an immediate
    framing observation) and every Nth round after that. Round 0 is
    never matched because the autonomy_loop starts at 1.
    """
    if round_num <= 0:
        return False
    if every_n <= 1:
        return True
    return round_num == 1 or round_num % every_n == 0
