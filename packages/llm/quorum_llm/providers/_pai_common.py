"""Shared helpers for the Pydantic AI provider adapters.

The four cloud providers (azure, openai, anthropic, local) all share the
same pattern:

1.  Build a Pydantic AI ``Agent`` lazily per tier.
2.  Translate the ``LLMProvider`` ABC methods (``complete``, ``chat``,
    ``respond``) into ``agent.run(user_prompt, message_history=..., model_settings=...)``.
3.  Convert the provider-agnostic ``messages: list[dict[str, str]]`` shape
    used by callers into Pydantic AI's typed ``ModelMessage`` sequence.

This module centralises (2) and (3) so each provider file stays thin.

Why a shared helper instead of duplicating per provider:  the message
conversion and tier→ModelSettings logic is identical across all
providers — only the ``Agent`` construction differs.  Keeping the
translation in one place means a single fix propagates to all of them
if Pydantic AI's message API evolves in a minor release.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable

from pydantic_ai import Agent, ModelSettings
from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    UserPromptPart,
)

from quorum_llm.models import LLMTier

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# ChatResult — return type for chat()/respond() when MessageHistory is wanted
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ChatResult:
    """Bundle of (text, new_messages) returned from a multi-turn call.

    ``text`` is the assistant's reply (already coerced to a string).

    ``new_messages`` is the *delta* — only the messages produced during this
    run, not the full history.  Callers persist this via the conversation
    store so the next run can resume from where this one left off.

    The conversation store serialises and deserialises these messages via
    ``pydantic_ai.messages.ModelMessagesTypeAdapter`` — see
    ``apps/api/conversation_store.py``.
    """

    text: str
    new_messages: list[ModelMessage]

    # Convenience accessors that mirror the Pydantic AI AgentRunResult shape
    # so callers that already use ``result.new_messages()`` keep working when
    # we hand them a ChatResult instead.
    def new_messages_method(self) -> list[ModelMessage]:
        return list(self.new_messages)


# ---------------------------------------------------------------------------
# Tier → ModelSettings
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TierSettings:
    """Per-tier defaults for temperature and max_tokens.

    Pydantic AI's ``ModelSettings`` is provider-agnostic — it maps to
    ``max_tokens`` for Anthropic, ``max_completion_tokens`` for OpenAI/Azure,
    and the appropriate field on every other supported backend.  That lets us
    delete all the hand-rolled param-quirk branching from the legacy adapters.
    """

    temperature: float
    max_tokens: int


# Defaults that match the legacy adapter behaviour so callers see no behavioural
# change.  See `azure.py` / `openai.py` git history for the original values.
_TIER_DEFAULTS: dict[LLMTier, TierSettings] = {
    LLMTier.CONFLICT: TierSettings(temperature=0.3, max_tokens=2048),
    LLMTier.SYNTHESIS: TierSettings(temperature=0.7, max_tokens=4096),
    # AGENT_CHAT and AGENT_RESPOND bumped to 4096 (was 1024 / 2048): long
    # agent persona responses (300-500+ words with a trailing `[tags: ...]`
    # block) were being truncated mid-sentence, dropping the tag block and
    # falling through to keyword extraction that emitted junk tags.
    LLMTier.AGENT_CHAT: TierSettings(temperature=0.4, max_tokens=4096),
    LLMTier.AGENT_REASON: TierSettings(temperature=0.7, max_tokens=4096),
    # AGENT_RESPOND is GPT-5/reasoning: temperature is ignored, but we still
    # carry a value for parity with `chat()` callers.
    LLMTier.AGENT_RESPOND: TierSettings(temperature=0.4, max_tokens=4096),
}


def tier_settings(
    tier: LLMTier,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> ModelSettings:
    """Build a ``ModelSettings`` for a tier, with optional caller overrides.

    Reasoning models (GPT-5, o-series, Claude reasoning models) reject
    ``temperature`` — Pydantic AI's per-model profile drops the field
    automatically when the target model doesn't accept it, so we don't have
    to branch on the model name any more.
    """
    defaults = _TIER_DEFAULTS.get(tier)
    if defaults is None:
        # Unknown tier (e.g. KEYWORD which never calls an LLM) — return a
        # conservative blank settings so the caller can still inject overrides.
        return ModelSettings(
            temperature=temperature if temperature is not None else 0.4,
            max_tokens=max_tokens if max_tokens is not None else 1024,
        )
    return ModelSettings(
        temperature=temperature if temperature is not None else defaults.temperature,
        max_tokens=max_tokens if max_tokens is not None else defaults.max_tokens,
    )


# ---------------------------------------------------------------------------
# JSON serialisation helpers for the conversations table
# ---------------------------------------------------------------------------


def serialise_messages(messages: list[ModelMessage]) -> list[dict]:
    """Convert a list of ``ModelMessage`` into a JSON-safe Python list.

    Uses ``ModelMessagesTypeAdapter.dump_python(messages, mode='json')`` so
    the output is compatible with ``psycopg``'s default JSONB encoder and
    can be round-tripped via ``deserialise_messages`` without information
    loss (including tool-call records and timestamps).
    """
    if not messages:
        return []
    return ModelMessagesTypeAdapter.dump_python(messages, mode="json")


def deserialise_messages(raw: list[dict] | None) -> list[ModelMessage]:
    """Inverse of ``serialise_messages``.

    Returns an empty list when ``raw`` is None / empty so callers can blindly
    pass the result as ``message_history`` to ``Agent.run``.
    """
    if not raw:
        return []
    return ModelMessagesTypeAdapter.validate_python(raw)


# ---------------------------------------------------------------------------
# dict-message ↔ Pydantic AI message conversion
# ---------------------------------------------------------------------------


def to_pai_messages(messages: Iterable[dict[str, str]]) -> list[ModelMessage]:
    """Convert ``[{"role": ..., "content": ...}, ...]`` to ``list[ModelMessage]``.

    Mapping:
    - ``system`` -> ``ModelRequest`` containing a ``SystemPromptPart``
    - ``user``   -> ``ModelRequest`` containing a ``UserPromptPart``
    - ``assistant`` -> ``ModelResponse`` containing a ``TextPart``

    Adjacent same-role-bucket messages are NOT merged — Pydantic AI accepts
    a sequence of alternating request/response messages and we don't want
    to silently drop any role boundary information.
    """
    result: list[ModelMessage] = []
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content", "")
        if role == "system":
            result.append(ModelRequest(parts=[SystemPromptPart(content=content)]))
        elif role == "user":
            result.append(ModelRequest(parts=[UserPromptPart(content=content)]))
        elif role == "assistant":
            result.append(ModelResponse(parts=[TextPart(content=content)]))
        else:
            # Unknown role — treat as user input so we don't lose the content.
            logger.warning("to_pai_messages: unknown role %r, treating as user", role)
            result.append(ModelRequest(parts=[UserPromptPart(content=content)]))
    return result


def split_history_and_prompt(
    messages: list[dict[str, str]],
) -> tuple[str | None, list[ModelMessage], str]:
    """Split a flat OpenAI-style messages array into Pydantic AI ``Agent.run`` args.

    Pydantic AI's ``Agent.run`` takes:
    - ``user_prompt``: the current user turn (string)
    - ``message_history``: prior turns (system + alternating user/assistant)
    - ``instructions``: system-level prompt, kept stable across turns

    We extract the trailing user message as the ``user_prompt`` and pull any
    system messages into a single ``instructions`` string.  Everything in
    between becomes the ``message_history``.

    Returns:
        (instructions, message_history, user_prompt)

    If there is no trailing user message (e.g. caller passed only a system
    message), the user prompt is an empty string — Pydantic AI handles that
    gracefully.
    """
    if not messages:
        return None, [], ""

    # Pull all system messages out and combine into instructions (preserves
    # multi-system-message setups that the legacy adapters supported).
    system_contents = [m["content"] for m in messages if m.get("role") == "system"]
    instructions = "\n\n".join(c for c in system_contents if c) or None

    non_system = [m for m in messages if m.get("role") != "system"]

    # Trailing user message becomes the user_prompt — everything before is
    # history.  If the last message is not from the user (e.g. an assistant
    # turn that we want the model to continue from), we still treat it as
    # history and pass an empty prompt.
    if non_system and non_system[-1].get("role") == "user":
        user_prompt = non_system[-1].get("content", "")
        history_dicts = non_system[:-1]
    else:
        user_prompt = ""
        history_dicts = non_system

    history = to_pai_messages(history_dicts)
    return instructions, history, user_prompt


# ---------------------------------------------------------------------------
# Lazy per-tier Agent cache
# ---------------------------------------------------------------------------


class AgentCache:
    """Cache of Pydantic AI ``Agent`` instances keyed by tier.

    Constructed lazily on first use so unused tiers never instantiate a
    network-touching SDK client.  The factory callable receives the tier
    and returns a fully-wired ``Agent`` (model + provider + settings).
    """

    def __init__(self, factory):
        self._factory = factory
        self._agents: dict[LLMTier, Agent] = {}

    def get(self, tier: LLMTier) -> Agent:
        if tier not in self._agents:
            self._agents[tier] = self._factory(tier)
        return self._agents[tier]


# ---------------------------------------------------------------------------
# Run helpers — used by every provider
# ---------------------------------------------------------------------------


async def run_complete(
    agent: Agent,
    prompt: str,
    settings: ModelSettings,
) -> str:
    """Run a single-prompt completion through an Agent and return the text.

    Token usage is logged at DEBUG so callers don't have to wire that up
    themselves; Pydantic AI exposes it on ``result.usage()``.
    """
    result = await agent.run(prompt, model_settings=settings)
    _log_usage(agent, result)
    return _coerce_output(result.output)


async def run_chat(
    agent: Agent,
    messages: list[dict[str, str]],
    settings: ModelSettings,
    *,
    message_history: list[ModelMessage] | None = None,
) -> str:
    """Run a multi-turn chat through an Agent and return the assistant reply.

    The ``message_history`` keyword argument lets callers prepend a previously
    persisted Pydantic AI history (as returned by ``ChatResult.new_messages``
    on prior calls).  When supplied, it is concatenated with the in-prompt
    history extracted from ``messages``.  The combined sequence is passed to
    ``Agent.run(message_history=...)``.

    Backward compatible: callers that don't pass ``message_history`` get the
    same behaviour as before — only the dict-style messages are threaded.
    """
    instructions, in_prompt_history, user_prompt = split_history_and_prompt(messages)
    combined_history: list[ModelMessage] = []
    if message_history:
        combined_history.extend(message_history)
    combined_history.extend(in_prompt_history)

    kwargs: dict = {"message_history": combined_history, "model_settings": settings}
    if instructions is not None:
        kwargs["instructions"] = instructions
    result = await agent.run(user_prompt, **kwargs)
    _log_usage(agent, result)
    return _coerce_output(result.output)


async def run_chat_with_history(
    agent: Agent,
    messages: list[dict[str, str]],
    settings: ModelSettings,
    *,
    message_history: list[ModelMessage] | None = None,
) -> ChatResult:
    """Like ``run_chat`` but returns a ``ChatResult`` bundling text + delta.

    The ``new_messages`` field of the returned ChatResult contains ONLY the
    messages produced during this run (the new user turn + the assistant
    response, plus any tool exchanges).  This is the delta callers persist to
    the ``conversations`` table — the on-disk row keeps growing turn-by-turn.

    Why a separate helper instead of returning ChatResult from ``run_chat``:
    the existing callers in every provider expect a bare ``str`` and we don't
    want to touch their signatures.  The new helper exists alongside them.
    """
    instructions, in_prompt_history, user_prompt = split_history_and_prompt(messages)
    combined_history: list[ModelMessage] = []
    if message_history:
        combined_history.extend(message_history)
    combined_history.extend(in_prompt_history)

    kwargs: dict = {"message_history": combined_history, "model_settings": settings}
    if instructions is not None:
        kwargs["instructions"] = instructions
    result = await agent.run(user_prompt, **kwargs)
    _log_usage(agent, result)
    return ChatResult(
        text=_coerce_output(result.output),
        new_messages=list(result.new_messages()),
    )


async def run_respond(
    agent: Agent,
    instructions: str,
    input_text: str,
    settings: ModelSettings,
) -> str:
    """Run a Responses-style call (system + single user turn).

    Pydantic AI auto-routes GPT-5 deployments to the Responses API based on
    the model profile — callers don't need to branch on the model name.
    """
    result = await agent.run(
        input_text,
        instructions=instructions,
        model_settings=settings,
    )
    _log_usage(agent, result)
    return _coerce_output(result.output)


async def run_typed(
    agent: Agent,
    prompt: str,
    settings: ModelSettings,
    *,
    output_type: type,
    instructions: str | None = None,
):
    """Run an Agent with a typed ``output_type`` and return the validated object.

    Pydantic AI's ``Agent.run(prompt, output_type=Model, ...)`` performs JSON
    Schema generation, function-call/tool-mode dispatch, and validation —
    including automatic retries on validation errors — so callers get a
    fully-typed instance back (no manual ``json.loads`` glue).

    Used by item 9.3 to swap three call sites off manual JSON parsing:
    - ``apps/api/architect_agent.generate_roles`` (RoleSuggestionList)
    - ``packages/llm/quorum_llm/pipeline.detect_conflicts`` (ConflictDetectionOutput)
    - ``packages/llm/quorum_llm/pipeline.generate_artifact`` (ArtifactContentOutput)

    ``instructions`` is optional and follows the same semantics as
    ``run_respond`` / ``run_chat`` — Pydantic AI keeps it stable across runs
    when ``message_history`` is threaded.
    """
    kwargs: dict = {
        "output_type": output_type,
        "model_settings": settings,
    }
    if instructions is not None:
        kwargs["instructions"] = instructions
    result = await agent.run(prompt, **kwargs)
    _log_usage(agent, result)
    return result.output


# ---------------------------------------------------------------------------
# Internal utilities
# ---------------------------------------------------------------------------


def _coerce_output(output) -> str:
    """Coerce Pydantic AI's possibly-typed output into a string.

    We always run with the default ``output_type=str``, so this is mostly a
    belt-and-braces guard for the case where Pydantic AI hands us back a
    structured object (which would mean a caller asked for it via the typed
    Agent API — out of scope for this swap).
    """
    if isinstance(output, str):
        return output
    return str(output) if output is not None else ""


def _log_usage(agent: Agent, result) -> None:
    """Emit a DEBUG log line with token usage for cost accounting.

    Pydantic AI exposes ``result.usage()`` (a ``RunUsage`` with input_tokens
    and output_tokens).  We don't try to compute dollar cost here — the
    existing budget tracker in ``packages/llm/quorum_llm/budget.py`` consumes
    raw token counts.
    """
    try:
        usage = result.usage()
        logger.debug(
            "pydantic-ai run: model=%s input_tokens=%s output_tokens=%s",
            getattr(agent, "model", "?"),
            getattr(usage, "input_tokens", None),
            getattr(usage, "output_tokens", None),
        )
    except Exception:  # noqa: BLE001 — usage logging must never break runs
        pass
