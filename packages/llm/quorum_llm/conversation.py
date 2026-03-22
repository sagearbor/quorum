"""Conversation utilities for AI facilitator agent turns.

This module provides three public functions consumed by the agent pipeline:

    build_agent_prompt   — constructs the full messages array for a facilitator turn
    extract_tags_from_response — pulls metadata tags out of an agent's response
    summarize_history    — compresses old conversation history to free context budget

Design notes:
- The system message is kept stable across all turns for a given role+quorum
  so that Azure OpenAI prompt caching activates after the first call.
- The context block (documents, insights, pending requests) is assembled from
  the most recent state and placed in a USER message that precedes the history.
- Tag extraction is deterministic (no LLM call) — it combines keyword extraction
  with pattern matching on the [tags: ...] convention agents are prompted to use.
- History summarization calls the LLM at AGENT_CHAT tier; callers should guard
  against unnecessary summarization calls (only run when history > threshold).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

from quorum_llm.interface import LLMProvider
from quorum_llm.models import LLMTier
from quorum_llm.tier1 import extract_keywords

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Context window budget constants (in approximate tokens)
# A token is roughly 4 characters for English prose.
# ---------------------------------------------------------------------------

# Maximum tokens reserved for the context block (documents + insights + requests).
# Total context window is 128K; we reserve 8K here leaving plenty for output.
MAX_CONTEXT_TOKENS = 8_000

# Characters-per-token approximation used for budget estimation.
# This is intentionally conservative (actual ratio is ~4) to avoid overruns.
_CHARS_PER_TOKEN = 3

# Maximum raw conversation messages to include before we summarize.
MAX_HISTORY_MESSAGES = 10

# History length (total message count) at which we start summarizing older turns.
SUMMARIZE_THRESHOLD = 15


# ---------------------------------------------------------------------------
# Lightweight dataclasses for prompt inputs
# These mirror the Supabase table shapes but are decoupled from any DB client
# so the conversation module is independently testable.
# ---------------------------------------------------------------------------


@dataclass
class AgentDocumentContext:
    """Minimal document view for prompt assembly."""

    document_id: str
    title: str
    doc_type: str
    version: int
    content: Any  # dict / str — displayed as formatted string in prompt
    tags: list[str] = field(default_factory=list)
    last_editor_name: str = ""


@dataclass
class AgentInsightContext:
    """Minimal insight view for prompt assembly."""

    insight_id: str
    source_role_name: str
    insight_type: str
    content: str
    tags: list[str] = field(default_factory=list)
    created_at: str = ""


@dataclass
class AgentRequestContext:
    """Minimal A2A request view for prompt assembly."""

    request_id: str
    from_role_name: str
    request_type: str
    content: str
    tags: list[str] = field(default_factory=list)
    priority: int = 0


@dataclass
class RoleContext:
    """Role information used in prompt construction."""

    role_id: str
    role_name: str
    authority_rank: int
    domain_tags: list[str] = field(default_factory=list)


@dataclass
class QuorumContext:
    """Quorum information used in prompt construction."""

    quorum_id: str
    title: str
    description: str
    max_authority_rank: int = 5


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_agent_prompt(
    agent_instructions: str,
    role: RoleContext,
    quorum: QuorumContext,
    contributions: list[dict[str, str]],
    insights: list[AgentInsightContext],
    documents: list[AgentDocumentContext],
    history: list[dict[str, str]],
    pending_requests: list[AgentRequestContext] | None = None,
    latest_message: str = "",
) -> list[dict[str, str]]:
    """Build the full messages array for a facilitator agent turn.

    Produces a messages array structured for maximum Azure prompt caching:

        [0] SYSTEM   — stable identity + instructions (cached after first call)
        [1] USER     — context block (documents, insights, requests) — changes slowly
        [2..N-1]     — conversation history (alternating user/assistant)
        [N]  USER    — the latest incoming message

    The context block is assembled in priority order:
      1. Pending A2A requests (always included, ~200 tokens each)
      2. Relevant documents (high-overlap tags first, truncated to budget)
      3. Cross-station insights (top by relevance, newest first)

    Args:
        agent_instructions: The agent's static system prompt / instructions
                            (from AgentDefinition.instructions or agent_configs.system_prompt).
        role:               Role identity for this station.
        quorum:             Quorum context.
        contributions:      Recent human contributions at this station, as
                            {"role": ..., "content": ...} dicts.  Included in
                            the context block if non-empty.
        insights:           Cross-station insights filtered to this agent's tags.
        documents:          Documents with tag overlap >= threshold.
        history:            Prior conversation messages (already truncated/summarized
                            by the caller using summarize_history if needed).
        pending_requests:   A2A requests pending response from this agent.
        latest_message:     The new human input or A2A request content triggering
                            this turn.  Appended as the final USER message.

    Returns:
        List of ``{"role": ..., "content": ...}`` dicts ready for the LLM API.
    """
    pending_requests = pending_requests or []

    # --- [0] System message: stable identity (benefits from prefix caching) ---
    system_content = _build_system_message(agent_instructions, role, quorum)

    # --- [1] Context block: documents + insights + requests ---
    context_content = _build_context_block(
        documents=documents,
        insights=insights,
        pending_requests=pending_requests,
        contributions=contributions,
    )

    messages: list[dict[str, str]] = [
        {"role": "system", "content": system_content},
    ]

    if context_content.strip():
        messages.append({"role": "user", "content": context_content})

    # --- [2..N-1] Conversation history ---
    messages.extend(history)

    # --- [N] Latest user message ---
    if latest_message.strip():
        messages.append({"role": "user", "content": latest_message.strip()})

    return messages


def extract_tags_from_response(
    response: str,
    existing_tags: list[str],
    max_new_tags: int = 5,
) -> list[str]:
    """Extract metadata tags from an agent response string.

    Two extraction passes are run and their results merged:

    1. **Explicit tag block** — the agent is instructed to include a
       ``[tags: tag1, tag2, ...]`` block in responses.  This is parsed first
       because it reflects the agent's deliberate categorisation.

    2. **Keyword extraction** — the tier-1 deterministic extractor runs on
       the full response text to catch important terms the agent did not
       explicitly tag.  Results are canonicalized and deduplicated.

    Tags from ``existing_tags`` are preserved as-is; new tags from the
    response are appended (up to ``max_new_tags`` new tags per call).

    All tags are lowercased and spaces replaced with underscores (canonical
    form matches the tag vocabulary convention from the PRP).

    Args:
        response:      Full text of the agent's LLM response.
        existing_tags: Tags already associated with the message/insight being
                       tagged (from prior extraction or domain_tags seeding).
        max_new_tags:  Maximum number of new tags to add from this response.

    Returns:
        Deduplicated, canonicalized list of tags (existing + extracted).
    """
    collected: list[str] = []

    # Pass 1: explicit [tags: ...] blocks in the response
    # Agents are instructed to use this format in the system prompt.
    tag_block_pattern = re.compile(r'\[tags?:\s*([^\]]+)\]', re.IGNORECASE)
    for match in tag_block_pattern.finditer(response):
        raw_tags = match.group(1).split(",")
        for t in raw_tags:
            canonical = _canonicalize_tag(t)
            if canonical:
                collected.append(canonical)

    # Pass 2: keyword extraction on the full response
    # Supplements explicit tags with important terms the agent didn't flag.
    keywords = extract_keywords(response, max_keywords=15)
    for kw in keywords:
        canonical = _canonicalize_tag(kw)
        if canonical:
            collected.append(canonical)

    # Merge with existing, dedup while preserving insertion order.
    existing_set = {_canonicalize_tag(t) for t in existing_tags}
    merged = list(existing_tags)  # start with existing (preserve originals)
    new_count = 0
    for tag in collected:
        if tag not in existing_set and new_count < max_new_tags:
            merged.append(tag)
            existing_set.add(tag)
            new_count += 1

    return merged


async def summarize_history(
    messages: list[dict[str, str]],
    provider: LLMProvider,
    max_tokens: int = 500,
    keep_last_n: int = 5,
) -> list[dict[str, str]]:
    """Compress old conversation history to stay within context budget.

    Summarizes the older portion of the history (everything except the last
    ``keep_last_n`` messages) into a single system message, then appends the
    raw recent messages.  The summary is produced by the LLM at AGENT_CHAT tier.

    This is called by the agent pipeline when the total message count exceeds
    ``SUMMARIZE_THRESHOLD``.  It is NOT called for every turn — only when
    context pressure requires it.

    The returned list is a drop-in replacement for the ``history`` parameter
    of ``build_agent_prompt``.

    Args:
        messages:    Full history list (``{"role": ..., "content": ...}`` dicts).
                     Should NOT include the system prompt — only conversational turns.
        provider:    LLM provider used to generate the summary.
        max_tokens:  Target length of the generated summary in tokens (approximate).
        keep_last_n: Number of recent raw messages to preserve verbatim after
                     the summary.  Keeping the last few turns verbatim prevents
                     the model from losing immediate context.

    Returns:
        Compressed history: ``[summary_system_msg, *recent_raw_messages]``.
        If ``messages`` is shorter than ``keep_last_n + 1``, returns the input
        unchanged (no summarization needed).
    """
    if len(messages) <= keep_last_n:
        return messages

    older = messages[:-keep_last_n]
    recent = messages[-keep_last_n:]

    # Build a compact representation of older turns for the summarizer.
    history_text = "\n".join(
        f"[{m['role']}]: {m['content'][:400]}"  # truncate very long turns
        for m in older
    )

    summary_prompt = (
        f"You are summarizing a conversation for an AI facilitator agent. "
        f"Produce a concise factual summary (max ~{max_tokens} tokens) of the "
        f"key decisions, conflicts, requests, and information exchanged. "
        f"Preserve specific numbers, names, and document references. "
        f"Do not editorialize.\n\n"
        f"CONVERSATION TO SUMMARIZE:\n{history_text}"
    )

    try:
        summary_text = await provider.complete(summary_prompt, LLMTier.AGENT_CHAT)
    except Exception:
        # If summarization fails, fall back to keeping the most recent messages
        # only — losing older context is better than crashing the agent turn.
        logger.warning(
            "summarize_history: LLM call failed, keeping last %d messages only",
            keep_last_n,
        )
        return recent

    summary_message: dict[str, str] = {
        "role": "system",
        "content": f"[Summary of earlier conversation]: {summary_text}",
    }

    return [summary_message, *recent]


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _build_system_message(
    agent_instructions: str,
    role: RoleContext,
    quorum: QuorumContext,
) -> str:
    """Build the stable system message content.

    This content is identical across all turns for a given role+quorum session,
    which is the prerequisite for Azure OpenAI prompt prefix caching.
    """
    domain_tags_str = ", ".join(role.domain_tags) if role.domain_tags else "general"

    lines = [
        f'You are the AI facilitator for the "{role.role_name}" role '
        f'in quorum "{quorum.title}".',
        f"Quorum description: {quorum.description}",
        f"Your authority rank: {role.authority_rank} out of {quorum.max_authority_rank}. "
        "Higher rank overrides lower on conflicts.",
        f"Your domain tags: {domain_tags_str}",
        "",
        agent_instructions,
        "",
        "RESPONSE GUIDELINES:",
        "- Be concise. Maximum 200 words per response unless asked for detail.",
        "- Tag your key points: [tags: tag1, tag2, tag3]",
        "- If you want to edit a document, output a JSON block:",
        "  ```edit",
        '  {"document_id": "...", "field_path": "...", "new_value": ..., "rationale": "..."}',
        "  ```",
        "- If you want to create a document, output:",
        "  ```create_doc",
        '  {"title": "...", "doc_type": "...", "content": {...}, "tags": [...]}',
        "  ```",
        "- If you detect a conflict with another agent's work, flag it explicitly.",
        '- If you need input from another role, request it: [request: Role Name, "your question"]',
    ]

    return "\n".join(lines)


def _build_context_block(
    documents: list[AgentDocumentContext],
    insights: list[AgentInsightContext],
    pending_requests: list[AgentRequestContext],
    contributions: list[dict[str, str]],
) -> str:
    """Build the context block USER message.

    Priority order (highest first):
    1. Pending A2A requests — always shown, agent must respond to these
    2. Active documents — shown with truncation if over budget
    3. Cross-station insights — newest first, truncated to budget
    4. Recent human contributions at this station
    """
    parts: list[str] = []
    budget = MAX_CONTEXT_TOKENS * _CHARS_PER_TOKEN  # character budget

    # --- Pending A2A requests ---
    if pending_requests:
        req_lines = ["== PENDING REQUESTS FOR YOU =="]
        for req in sorted(pending_requests, key=lambda r: -r.priority):
            line = (
                f"- From {req.from_role_name} [{req.request_type}, "
                f"priority={req.priority}]: {req.content}"
            )
            if req.tags:
                line += f"\n  [tags: {', '.join(req.tags)}]"
            req_lines.append(line)
            budget -= len(line)
        parts.append("\n".join(req_lines))

    # --- Active documents ---
    if documents and budget > 0:
        doc_lines = ["== ACTIVE DOCUMENTS =="]
        for doc in documents:
            editor_info = f", last edited by {doc.last_editor_name}" if doc.last_editor_name else ""
            header = f"Document: {doc.title} (v{doc.version}, type={doc.doc_type}{editor_info})"
            if doc.tags:
                header += f"\n  [tags: {', '.join(doc.tags)}]"
            content_str = _format_document_content(doc.content, max_chars=800)
            entry = f"{header}\n{content_str}"
            if len(entry) > budget:
                # Truncate to remaining budget
                entry = entry[: max(100, budget)] + "\n  [... truncated ...]"
            doc_lines.append(entry)
            budget -= len(entry)
            if budget <= 0:
                doc_lines.append("  [... additional documents omitted due to context limit ...]")
                break
        parts.append("\n".join(doc_lines))

    # --- Cross-station insights ---
    if insights and budget > 0:
        insight_lines = ["== RECENT CROSS-STATION INSIGHTS =="]
        for ins in insights:
            ts = f" @ {ins.created_at}" if ins.created_at else ""
            line = f"- [{ins.source_role_name}{ts}] ({ins.insight_type}): {ins.content}"
            if ins.tags:
                line += f"\n  [tags: {', '.join(ins.tags)}]"
            if len(line) > budget:
                break
            insight_lines.append(line)
            budget -= len(line)
        parts.append("\n".join(insight_lines))

    # --- Recent human contributions at this station ---
    if contributions and budget > 0:
        contrib_lines = ["== RECENT CONTRIBUTIONS AT THIS STATION =="]
        for c in contributions[-5:]:  # show at most 5 recent
            line = f"- [{c.get('role', 'unknown')}]: {c.get('content', '')}"
            if len(line) > budget:
                break
            contrib_lines.append(line)
            budget -= len(line)
        if len(contrib_lines) > 1:
            parts.append("\n".join(contrib_lines))

    return "\n\n".join(parts)


def _format_document_content(content: Any, max_chars: int = 800) -> str:
    """Format document content for display in the prompt.

    JSONB documents are pretty-printed up to max_chars.  Other types are
    converted via str().
    """
    if isinstance(content, dict):
        import json
        try:
            formatted = json.dumps(content, indent=2)
        except (TypeError, ValueError):
            formatted = str(content)
    elif isinstance(content, str):
        formatted = content
    else:
        formatted = str(content)

    if len(formatted) > max_chars:
        return formatted[:max_chars] + "\n  [... truncated ...]"
    return formatted


def _canonicalize_tag(raw: str) -> str:
    """Normalize a raw tag string to canonical form.

    Canonical form: lowercase, spaces→underscores, alphanumeric+underscore only,
    max 30 characters.  Returns an empty string if nothing meaningful remains.
    """
    tag = raw.strip().lower()
    # Replace spaces and hyphens with underscores
    tag = re.sub(r'[\s\-]+', '_', tag)
    # Remove characters outside the allowed set
    tag = re.sub(r'[^a-z0-9_]', '', tag)
    # Remove leading/trailing underscores
    tag = tag.strip('_')
    # Truncate to 30 characters
    tag = tag[:30]
    return tag
