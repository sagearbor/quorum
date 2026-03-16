"""Agent turn engine — orchestrates LLM calls for station conversations.

Each invocation is stateless from the caller's perspective: all state lives in
Supabase (station_messages, agent_insights, agent_requests, agent_configs).
The engine loads context, calls the LLM, persists the result, and returns the
agent's reply string.

Design notes:
- Uses `llm_provider.chat()` when available (Track A adds it to LLMProvider).
  Falls back to `llm_provider.complete()` with flattened messages so the code
  runs correctly even before Track A ships.
- Never raises — on error it returns a graceful fallback string and logs the
  exception.  The caller (routes.py) decides whether to surface it.
- Agent definitions are loaded from agents/definitions/ by matching the role
  name (case-insensitive, spaces → underscores).
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from quorum_llm.affinity import (
    compute_tag_affinity,
    extract_tags_from_text,
    find_relevant_agents,
)
from .tag_vocabulary import get_vocabulary, update_vocabulary

logger = logging.getLogger(__name__)

# Maximum conversation messages to load per station turn.
_MAX_HISTORY = 10
# Maximum insights to inject as cross-station context.
_MAX_INSIGHTS = 5
# Maximum agent documents to include in context.
_MAX_DOCS = 3
# Relevance threshold (Jaccard on tags) above which an insight is included.
_INSIGHT_RELEVANCE_THRESHOLD = 0.2


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _slugify(name: str) -> str:
    """Convert a role name to the agent definition slug format."""
    return name.lower().replace(" ", "_").replace("-", "_")


def _jaccard(a: set[str], b: set[str]) -> float:
    """Thin wrapper kept for any callers that reference the private name directly.

    Prefer ``compute_tag_affinity`` from ``quorum_llm.affinity`` for new code.
    """
    return compute_tag_affinity(list(a), list(b))


def _flatten_messages(messages: list[dict]) -> str:
    """Flatten a message list to a single string for providers lacking chat()."""
    return "\n".join(f"[{m['role']}]: {m['content']}" for m in messages)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_gpt5_model(model: str) -> bool:
    """Return True if the model name indicates a GPT-5 variant.

    GPT-5 models require the Responses API rather than Chat Completions.
    We check by prefix so that gpt-5-nano, gpt-5-turbo, etc. all match.
    """
    return model.startswith("gpt-5")


async def _call_llm(llm_provider, messages: list[dict], agent_def=None) -> str:
    """Call LLM using the appropriate API based on the agent's model.

    Routing logic:
    1. If the agent definition specifies a gpt-5-* model AND the provider
       exposes ``respond()``, use the Responses API (stateless call — no
       previous_response_id since we don't persist it yet at this level).
    2. If the provider exposes ``chat()``, use it for full message history.
    3. Otherwise flatten to a single string and call ``complete()``.

    The agent_def parameter is optional; when absent the logic falls through
    to chat() or complete() as before (safe for callers that don't have the
    definition readily available).
    """
    from quorum_llm.models import LLMTier

    # Route gpt-5 agents through the Responses API when available
    if agent_def is not None and _is_gpt5_model(getattr(agent_def, "model", "")):
        if hasattr(llm_provider, "respond"):
            try:
                # Extract the system message as instructions and the last
                # user message as input_text for the Responses API format.
                instructions = next(
                    (m["content"] for m in messages if m["role"] == "system"),
                    "",
                )
                user_messages = [m for m in messages if m["role"] == "user"]
                input_text = user_messages[-1]["content"] if user_messages else ""

                reply, _ = await llm_provider.respond(
                    instructions=instructions,
                    input_text=input_text,
                    tier=LLMTier.AGENT_RESPOND,
                )
                return reply
            except Exception:
                logger.warning(
                    "agent_engine: respond() failed for gpt-5 agent '%s', "
                    "falling back to chat()",
                    getattr(agent_def, "name", "unknown"),
                    exc_info=True,
                )

    # Standard path: use chat() for full message-list context
    if hasattr(llm_provider, "chat"):
        try:
            return await llm_provider.chat(messages, LLMTier.AGENT_CHAT)
        except Exception:
            logger.warning(
                "agent_engine: chat() failed, falling back to complete()",
                exc_info=True,
            )

    # Final fallback: flatten to a single prompt and use complete()
    flat = _flatten_messages(messages)
    return await llm_provider.complete(flat, LLMTier.AGENT_CHAT)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def process_agent_turn(
    quorum_id: str,
    role_id: str,
    station_id: str,
    user_message: str,
    supabase_client,
    llm_provider,
    model_override: str | None = None,
) -> tuple[str, str, list[str]]:
    """Run one agent turn for a station.

    Steps:
    1. Load agent definition from agents/ based on role name.
    2. Load conversation history from station_messages.
    3. Load relevant cross-station insights (filtered by tag affinity).
    4. Load relevant agent documents.
    5. Build prompt.
    6. Call LLM.
    7. Store user message + agent reply in station_messages.
    8. Extract tags and publish insight if substantive.
    9. Return (agent_reply, message_id, tags).

    Returns a 3-tuple: (reply_text, reply_message_id, reply_tags).
    Never raises — returns a fallback string on error.
    """
    db = supabase_client

    # --- 1. Resolve role name and load agent definition ---
    try:
        role_row = db.table("roles").select("name, authority_rank").eq("id", role_id).single().execute()
        role_name: str = role_row.data["name"] if role_row.data else "unknown"
        authority_rank: int = (role_row.data or {}).get("authority_rank", 0)
    except Exception:
        logger.warning("agent_engine: could not load role %s", role_id, exc_info=True)
        role_name = "unknown"
        authority_rank = 0

    agent_def = _load_agent_definition(role_name)

    # --- 2. Load conversation history ---
    history = _load_conversation_history(db, quorum_id, role_id, station_id)

    # --- 3. Load quorum context ---
    quorum_context = _load_quorum_context(db, quorum_id)

    # --- 4. Load cross-station insights ---
    agent_tags: set[str] = set(agent_def.domain_tags) if agent_def else set()
    insights = _load_relevant_insights(db, quorum_id, role_id, agent_tags)

    # --- 5. Load relevant documents ---
    documents = _load_relevant_documents(db, quorum_id, agent_tags)

    # --- 6. Load pending A2A requests for this role ---
    pending_requests = _load_pending_requests(db, quorum_id, role_id)

    # --- 7. Build messages list ---
    messages = _build_prompt(
        role_name=role_name,
        authority_rank=authority_rank,
        agent_def=agent_def,
        quorum_context=quorum_context,
        history=history,
        insights=insights,
        documents=documents,
        pending_requests=pending_requests,
        user_message=user_message,
    )

    # --- 8. Call LLM (routing: gpt-5 → Responses API, others → chat()) ---
    # When a model_override is provided, temporarily shadow the agent_def model
    # so _call_llm routes correctly (e.g. a gpt-5-nano override triggers the
    # Responses API path without permanently mutating the agent definition).
    effective_agent_def = agent_def
    if model_override and agent_def is not None:
        import copy
        effective_agent_def = copy.copy(agent_def)
        effective_agent_def.model = model_override
    elif model_override:
        # No agent_def loaded — create a minimal stand-in so the override is honoured
        class _ModelStub:
            model = model_override
            domain_tags: list[str] = []
            instructions: str = ""
            name: str = role_name
        effective_agent_def = _ModelStub()

    try:
        reply = await _call_llm(llm_provider, messages, agent_def=effective_agent_def)
    except Exception:
        logger.error(
            "agent_engine: LLM call failed for role=%s station=%s",
            role_id, station_id, exc_info=True,
        )
        reply = "I encountered an issue processing your message. Please try again."

    # --- 9. Persist user message ---
    user_msg_id = str(uuid.uuid4())
    try:
        db.table("station_messages").insert({
            "id": user_msg_id,
            "quorum_id": quorum_id,
            "role_id": role_id,
            "station_id": station_id,
            "role": "user",
            "content": user_message,
            "tags": [],
            "metadata": None,
            "created_at": _now_iso(),
        }).execute()
    except Exception:
        logger.warning("agent_engine: failed to persist user message", exc_info=True)

    # --- 10. Extract tags from reply using vocabulary-aware extraction ---
    vocab = get_vocabulary(quorum_id)
    reply_tags = extract_tags_from_text(reply, existing_vocabulary=vocab)
    # Grow the quorum vocabulary with any new tags discovered in this turn
    update_vocabulary(quorum_id, reply_tags)

    # --- 11. Persist agent reply ---
    reply_msg_id = str(uuid.uuid4())
    try:
        db.table("station_messages").insert({
            "id": reply_msg_id,
            "quorum_id": quorum_id,
            "role_id": role_id,
            "station_id": station_id,
            "role": "assistant",
            "content": reply,
            "tags": reply_tags,
            "metadata": None,
            "created_at": _now_iso(),
        }).execute()
    except Exception:
        logger.warning("agent_engine: failed to persist agent reply", exc_info=True)

    # --- 12. Publish insight if reply is substantive (>50 chars) ---
    if len(reply.strip()) > 50:
        _publish_insight(
            db=db,
            quorum_id=quorum_id,
            role_id=role_id,
            content=reply[:1000],  # cap insight content length
            tags=reply_tags,
            insight_type="summary",
        )
        # Notify any agents with high tag affinity to this insight so they can
        # incorporate it in their next turn without waiting for a human action.
        _notify_relevant_agents(
            db=db,
            quorum_id=quorum_id,
            from_role_id=role_id,
            insight_tags=reply_tags,
            insight_content=reply[:500],
        )

    return reply, reply_msg_id, reply_tags


async def process_a2a_request(
    request_id: str,
    supabase_client,
    llm_provider,
) -> str:
    """Handle an incoming A2A request and generate the target agent's response.

    Steps:
    1. Load request from agent_requests.
    2. Load target agent definition.
    3. Build context with request content.
    4. Call LLM for response.
    5. Update request status to acknowledged.
    6. Return response text.

    Never raises — returns a fallback string on error.
    """
    db = supabase_client

    # --- 1. Load request ---
    try:
        req_result = db.table("agent_requests").select("*").eq("id", request_id).single().execute()
        if not req_result.data:
            logger.warning("process_a2a_request: request %s not found", request_id)
            return "Request not found."
        req = req_result.data
    except Exception:
        logger.error("process_a2a_request: DB error loading request %s", request_id, exc_info=True)
        return "Error loading request."

    to_role_id: str = req["to_role_id"]
    from_role_id: str = req["from_role_id"]
    request_type: str = req["request_type"]
    content: str = req["content"]

    # --- 2. Load target role name + agent definition ---
    try:
        role_row = db.table("roles").select("name, authority_rank").eq("id", to_role_id).single().execute()
        target_role_name = role_row.data["name"] if role_row.data else "unknown"
        authority_rank = (role_row.data or {}).get("authority_rank", 0)
    except Exception:
        target_role_name = "unknown"
        authority_rank = 0

    # Load sender name for context
    try:
        sender_row = db.table("roles").select("name").eq("id", from_role_id).single().execute()
        sender_name = sender_row.data["name"] if sender_row.data else "another agent"
    except Exception:
        sender_name = "another agent"

    agent_def = _load_agent_definition(target_role_name)

    # --- 3. Build minimal prompt for A2A response ---
    system_content = _build_system_prompt(
        role_name=target_role_name,
        authority_rank=authority_rank,
        agent_def=agent_def,
        quorum_context=None,
    )

    a2a_user_content = (
        f"You have received an {request_type} from {sender_name}:\n\n"
        f"{content}\n\n"
        "Please respond directly and concisely. If this is a conflict flag, "
        "acknowledge it and state your position. If it is an input request, "
        "provide the requested information. If it is an escalation, assess "
        "the situation and make a ruling."
    )

    messages = [
        {"role": "system", "content": system_content},
        {"role": "user", "content": a2a_user_content},
    ]

    # --- 4. Call LLM (routing: gpt-5 → Responses API, others → chat()) ---
    try:
        response_text = await _call_llm(llm_provider, messages, agent_def=agent_def)
    except Exception:
        logger.error(
            "process_a2a_request: LLM failed for request %s", request_id, exc_info=True
        )
        response_text = "I acknowledge your request and will respond shortly."

    # --- 5. Update request status to acknowledged ---
    # Load vocabulary for the quorum if available (best-effort; req row has quorum_id)
    a2a_quorum_id: str = req.get("quorum_id", "")
    a2a_vocab = get_vocabulary(a2a_quorum_id) if a2a_quorum_id else set()
    response_tags = extract_tags_from_text(response_text, existing_vocabulary=a2a_vocab)
    if a2a_quorum_id:
        update_vocabulary(a2a_quorum_id, response_tags)
    try:
        db.table("agent_requests").update({
            "status": "acknowledged",
            "response": response_text,
            "response_tags": response_tags,
            "resolved_at": _now_iso(),
        }).eq("id", request_id).execute()
    except Exception:
        logger.warning("process_a2a_request: failed to update request status", exc_info=True)

    return response_text


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _load_agent_definition(role_name: str):
    """Load agent definition; return None if not found (graceful degradation)."""
    try:
        from agents import load_agent
        slug = _slugify(role_name)
        return load_agent(slug)
    except FileNotFoundError:
        logger.debug("agent_engine: no definition found for role '%s' (slug '%s')", role_name, _slugify(role_name))
        return None
    except Exception:
        logger.warning("agent_engine: error loading agent definition for '%s'", role_name, exc_info=True)
        return None


def _load_conversation_history(db, quorum_id: str, role_id: str, station_id: str) -> list[dict]:
    """Load the last N messages for this station."""
    try:
        result = (
            db.table("station_messages")
            .select("role, content, tags")
            .eq("quorum_id", quorum_id)
            .eq("station_id", station_id)
            .order("created_at", desc=False)
            .limit(_MAX_HISTORY)
            .execute()
        )
        return [{"role": r["role"], "content": r["content"]} for r in (result.data or [])]
    except Exception:
        logger.warning("agent_engine: failed to load conversation history", exc_info=True)
        return []


def _load_quorum_context(db, quorum_id: str) -> dict | None:
    """Load basic quorum metadata for prompt context."""
    try:
        result = db.table("quorums").select("title, description").eq("id", quorum_id).single().execute()
        return result.data
    except Exception:
        return None


def _load_relevant_insights(
    db, quorum_id: str, role_id: str, agent_tags: set[str]
) -> list[dict]:
    """Load recent insights from other stations that share tag affinity.

    Uses ``find_relevant_agents`` semantics: each insight is treated as a
    mini-agent with its own tag set and scored against this agent's tags.
    Insights below ``_INSIGHT_RELEVANCE_THRESHOLD`` are excluded unless this
    agent has no domain tags (new/unconfigured agents receive all insights).
    """
    try:
        result = (
            db.table("agent_insights")
            .select("source_role_id, insight_type, content, tags, created_at")
            .eq("quorum_id", quorum_id)
            .neq("source_role_id", role_id)  # skip own insights
            .order("created_at", desc=True)
            .limit(20)
            .execute()
        )
        rows = result.data or []
    except Exception:
        logger.warning("agent_engine: failed to load insights", exc_info=True)
        return []

    agent_tags_list = list(agent_tags)

    # When the agent has no domain tags, return all insights (unconfigured agent).
    if not agent_tags_list:
        return rows[:_MAX_INSIGHTS]

    # Use find_relevant_agents to score each insight by tag overlap.
    # We adapt the insight rows into the [{role_id, domain_tags}] shape expected
    # by find_relevant_agents, then map back to the original rows.
    insight_agent_proxies = [
        {"role_id": str(i), "domain_tags": row.get("tags") or []}
        for i, row in enumerate(rows)
    ]
    relevant = find_relevant_agents(
        source_tags=agent_tags_list,
        all_agents=insight_agent_proxies,
        threshold=_INSIGHT_RELEVANCE_THRESHOLD,
    )
    # Map proxy role_ids (which are str indices) back to original rows
    selected = [rows[int(proxy["role_id"])] for proxy in relevant[:_MAX_INSIGHTS]]
    return selected


def _load_relevant_documents(db, quorum_id: str, agent_tags: set[str]) -> list[dict]:
    """Load active agent documents with tag affinity to this agent.

    Documents with no tags are given a small baseline score (0.1) so that
    untagged documents are still surfaced when no better matches exist.
    """
    try:
        result = (
            db.table("agent_documents")
            .select("id, title, doc_type, content, tags, version")
            .eq("quorum_id", quorum_id)
            .eq("status", "active")
            .order("updated_at", desc=True)
            .limit(10)
            .execute()
        )
        rows = result.data or []
    except Exception:
        logger.warning("agent_engine: failed to load documents", exc_info=True)
        return []

    agent_tags_list = list(agent_tags)

    if not agent_tags_list:
        # No domain tags — return most recent documents (recency order preserved)
        return rows[:_MAX_DOCS]

    # Score each document: use compute_tag_affinity for tagged docs, baseline for untagged.
    scored: list[tuple[float, dict]] = []
    for row in rows:
        doc_tags: list[str] = row.get("tags") or []
        score = (
            compute_tag_affinity(agent_tags_list, doc_tags)
            if doc_tags
            else 0.1  # baseline: include untagged docs with low priority
        )
        scored.append((score, row))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in scored[:_MAX_DOCS]]


def _load_pending_requests(db, quorum_id: str, role_id: str) -> list[dict]:
    """Load pending A2A requests addressed to this role."""
    try:
        result = (
            db.table("agent_requests")
            .select("id, from_role_id, request_type, content, priority, created_at")
            .eq("quorum_id", quorum_id)
            .eq("to_role_id", role_id)
            .eq("status", "pending")
            .order("priority", desc=True)
            .limit(5)
            .execute()
        )
        return result.data or []
    except Exception:
        logger.warning("agent_engine: failed to load pending requests", exc_info=True)
        return []


def _build_system_prompt(
    role_name: str,
    authority_rank: int,
    agent_def,
    quorum_context: dict | None,
) -> str:
    """Build the stable system prompt (benefits from Azure prefix caching)."""
    quorum_title = (quorum_context or {}).get("title", "this quorum")
    quorum_desc = (quorum_context or {}).get("description", "")

    if agent_def:
        instructions = agent_def.instructions
        domain_tags_str = ", ".join(agent_def.domain_tags) if agent_def.domain_tags else "general"
    else:
        instructions = f"You are the AI facilitator for the {role_name} role."
        domain_tags_str = "general"

    return (
        f"You are the AI facilitator for the \"{role_name}\" role "
        f"in quorum \"{quorum_title}\".\n"
        f"Quorum: {quorum_desc}\n"
        f"Your authority rank: {authority_rank}. Higher rank overrides lower on conflicts.\n"
        f"Your domain tags: {domain_tags_str}\n\n"
        f"{instructions}\n\n"
        "Rules:\n"
        "- Be concise. Max 200 words per response.\n"
        "- Tag your key points using [tags: tag1, tag2] notation.\n"
        "- If you detect a conflict with another agent, flag it explicitly.\n"
        "- If you want to edit a document, output a JSON block fenced with ```edit.\n"
        "- If you need input from another role, request it explicitly."
    )


def _build_prompt(
    role_name: str,
    authority_rank: int,
    agent_def,
    quorum_context: dict | None,
    history: list[dict],
    insights: list[dict],
    documents: list[dict],
    pending_requests: list[dict],
    user_message: str,
) -> list[dict]:
    """Assemble the full message list for the LLM call."""
    messages: list[dict] = []

    # System block (stable — benefits from Azure prefix caching)
    system_content = _build_system_prompt(
        role_name=role_name,
        authority_rank=authority_rank,
        agent_def=agent_def,
        quorum_context=quorum_context,
    )
    messages.append({"role": "system", "content": system_content})

    # Context block: documents + insights + pending requests
    # Injected as a single "user" message before history so it stays in the
    # cached prefix region on models that support prefix caching.
    context_parts: list[str] = []

    if documents:
        context_parts.append("== ACTIVE DOCUMENTS ==")
        for doc in documents:
            doc_summary = json.dumps(doc.get("content", {}))
            if len(doc_summary) > 500:
                doc_summary = doc_summary[:500] + "..."
            context_parts.append(
                f"Document: {doc['title']} (v{doc['version']}, type={doc['doc_type']})\n"
                f"{doc_summary}"
            )

    if insights:
        context_parts.append("\n== RECENT CROSS-STATION INSIGHTS ==")
        for ins in insights:
            tags_str = ", ".join(ins.get("tags") or [])
            context_parts.append(
                f"- [{ins.get('insight_type', 'summary')}] "
                f"{ins['content'][:200]}"
                + (f" [tags: {tags_str}]" if tags_str else "")
            )

    if pending_requests:
        context_parts.append("\n== PENDING REQUESTS FOR YOU ==")
        for req in pending_requests:
            context_parts.append(
                f"- ({req['request_type']}) {req['content'][:200]}"
            )

    if context_parts:
        messages.append({
            "role": "user",
            "content": "\n".join(context_parts),
        })
        # Acknowledge context receipt so conversation flow makes sense
        messages.append({
            "role": "assistant",
            "content": "Understood. I've reviewed the current documents and insights.",
        })

    # Conversation history (last N turns)
    messages.extend(history)

    # Latest user message
    messages.append({"role": "user", "content": user_message})

    return messages


def _publish_insight(
    db,
    quorum_id: str,
    role_id: str,
    content: str,
    tags: list[str],
    insight_type: str = "summary",
) -> None:
    """Write a new agent insight row. Errors are swallowed to avoid breaking the turn."""
    try:
        db.table("agent_insights").insert({
            "id": str(uuid.uuid4()),
            "quorum_id": quorum_id,
            "source_role_id": role_id,
            "insight_type": insight_type,
            "content": content,
            "tags": tags,
            "self_relevance": 0.6,
            "version": 1,
            "created_at": _now_iso(),
        }).execute()
    except Exception:
        logger.warning("agent_engine: failed to publish insight", exc_info=True)


def _notify_relevant_agents(
    db,
    quorum_id: str,
    from_role_id: str,
    insight_tags: list[str],
    insight_content: str,
) -> None:
    """Send doc_edit_notify A2A requests to agents with high tag affinity.

    Loads all active roles in the quorum, computes tag affinity against the
    insight tags, and sends a ``doc_edit_notify`` A2A request to any agent
    whose affinity score meets or exceeds the high-priority threshold (0.6,
    per PRP section 5 propagation rules).

    This is fire-and-forget: errors are logged but never re-raised so that
    the calling turn always completes successfully.

    Args:
        db:              Supabase client.
        quorum_id:       Quorum identifier.
        from_role_id:    Role that published the insight (excluded from targets).
        insight_tags:    Tags associated with the published insight.
        insight_content: Truncated insight text for the A2A request body.
    """
    # Threshold for auto-wake: only send A2A for strong affinity matches.
    # Lower-affinity agents will see the insight via context injection instead.
    _A2A_NOTIFY_THRESHOLD = 0.6

    if not insight_tags:
        return

    try:
        # Load all roles in this quorum and their domain tags from agent_configs
        result = (
            db.table("agent_configs")
            .select("role_id, domain_tags")
            .eq("quorum_id", quorum_id)
            .execute()
        )
        role_configs: list[dict] = result.data or []
    except Exception:
        logger.warning("_notify_relevant_agents: failed to load role configs", exc_info=True)
        return

    # Filter out the publishing agent and find high-affinity targets
    other_agents = [r for r in role_configs if r.get("role_id") != from_role_id]
    if not other_agents:
        return

    relevant = find_relevant_agents(
        source_tags=insight_tags,
        all_agents=other_agents,
        threshold=_A2A_NOTIFY_THRESHOLD,
    )

    if not relevant:
        logger.debug(
            "_notify_relevant_agents: no agents above threshold %.1f for quorum=%s",
            _A2A_NOTIFY_THRESHOLD,
            quorum_id,
        )
        return

    # Insert one A2A request per relevant agent
    for agent in relevant:
        target_role_id = agent["role_id"]
        score = agent["affinity_score"]
        try:
            db.table("agent_requests").insert({
                "id": str(uuid.uuid4()),
                "quorum_id": quorum_id,
                "from_role_id": from_role_id,
                "to_role_id": target_role_id,
                "request_type": "doc_edit_notify",
                "content": (
                    f"A cross-station insight with tags [{', '.join(insight_tags)}] "
                    f"(affinity {score:.2f}) was published and may be relevant to "
                    f"your domain:\n\n{insight_content}"
                ),
                "priority": 1,  # Low priority per PRP section 6 table
                "status": "pending",
                "created_at": _now_iso(),
            }).execute()
            logger.debug(
                "_notify_relevant_agents: notified role=%s (affinity=%.2f) in quorum=%s",
                target_role_id,
                score,
                quorum_id,
            )
        except Exception:
            logger.warning(
                "_notify_relevant_agents: failed to insert A2A request for role=%s",
                target_role_id,
                exc_info=True,
            )
