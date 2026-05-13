"""Plain OpenAI provider — thin wrapper around ``pydantic_ai.Agent``.

Default for open-source users.  Uses the standard OpenAI API (not Azure).
Requires only ``OPENAI_API_KEY``.

Uses env vars:
    OPENAI_API_KEY
    OPENAI_MODEL_T2          (default: gpt-4o-mini)
    OPENAI_MODEL_T3          (default: gpt-4o)
    OPENAI_EMBEDDING_MODEL   (default: text-embedding-3-small)

Reasoning models (``o1*``, ``o3*``, ``o4*``, ``gpt-5*``) are handled by
Pydantic AI's per-model profile — the SDK auto-drops ``temperature`` for
models that don't accept it, so we no longer need a ``_is_reasoning_model``
branch here.
"""

from __future__ import annotations

import os

from openai import AsyncOpenAI, RateLimitError
from pydantic_ai import Agent
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.providers.openai import OpenAIProvider as PaiOpenAIProvider

from quorum_llm.interface import LLMProvider
from quorum_llm.models import BudgetExhaustedError, LLMTier
from quorum_llm.providers._pai_common import (
    AgentCache,
    ChatResult,
    run_chat,
    run_chat_with_history,
    run_complete,
    run_respond,
    run_typed,
    tier_settings,
)
from quorum_llm.tier1 import extract_keywords

_DEFAULT_MODEL_T2 = "gpt-4o-mini"
_DEFAULT_MODEL_T3 = "gpt-4o"
_DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"


def _is_reasoning_model(model: str) -> bool:
    """Detect reasoning models that should use the Responses API.

    Pydantic AI's chat model handles the parameter-shape differences itself,
    but for ``gpt-5*`` (and ``o*``) we get richer behaviour by routing through
    ``OpenAIResponsesModel`` so the Responses endpoint is used end-to-end.
    """
    name = model.lower()
    if any(name.startswith(p) for p in ("o1", "o3", "o4")):
        return True
    if "gpt-5" in name:
        return True
    return False


class OpenAIProvider(LLMProvider):
    """Plain OpenAI LLM provider (non-Azure) — Pydantic AI under the hood."""

    def __init__(
        self,
        api_key: str | None = None,
        model_t2: str | None = None,
        model_t3: str | None = None,
        embedding_model: str | None = None,
    ):
        self._api_key = api_key or os.environ["OPENAI_API_KEY"]
        self._model_t2 = model_t2 or os.environ.get("OPENAI_MODEL_T2", _DEFAULT_MODEL_T2)
        self._model_t3 = model_t3 or os.environ.get("OPENAI_MODEL_T3", _DEFAULT_MODEL_T3)
        self._embedding_model = (
            embedding_model
            or os.environ.get("OPENAI_EMBEDDING_MODEL", _DEFAULT_EMBEDDING_MODEL)
        )
        # Preserve the AsyncOpenAI client for embed() and for the Pydantic AI
        # provider — sharing one client means one connection pool.
        self._client = AsyncOpenAI(api_key=self._api_key)
        self._agents = AgentCache(self._build_agent_for_tier)

    def _model_for_tier(self, tier: LLMTier) -> str:
        if tier in (LLMTier.CONFLICT, LLMTier.AGENT_CHAT, LLMTier.AGENT_RESPOND):
            return self._model_t2
        if tier in (LLMTier.SYNTHESIS, LLMTier.AGENT_REASON):
            return self._model_t3
        raise ValueError(f"Tier {tier} does not use LLM — use tier1 module directly")

    def _build_agent_for_tier(self, tier: LLMTier) -> Agent:
        model_name = self._model_for_tier(tier)
        provider = PaiOpenAIProvider(openai_client=self._client)
        if _is_reasoning_model(model_name):
            model = OpenAIResponsesModel(model_name, provider=provider)
        else:
            model = OpenAIChatModel(model_name, provider=provider)
        return Agent(model)

    async def complete(self, prompt: str, tier: LLMTier) -> str:
        if tier == LLMTier.KEYWORD:
            return ", ".join(extract_keywords(prompt))

        agent = self._agents.get(tier)
        settings = tier_settings(tier)
        try:
            return await run_complete(agent, prompt, settings)
        except ModelHTTPError as exc:
            _maybe_raise_budget(tier, exc)
            raise
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="openai", tier=tier, detail=str(exc)
            ) from exc

    async def chat(
        self,
        messages: list[dict[str, str]],
        tier: LLMTier,
        temperature: float = 0.4,
        max_tokens: int = 1024,
        *,
        message_history=None,
    ) -> str:
        agent = self._agents.get(tier)
        settings = tier_settings(tier, temperature=temperature, max_tokens=max_tokens)
        try:
            return await run_chat(
                agent, messages, settings, message_history=message_history
            )
        except ModelHTTPError as exc:
            _maybe_raise_budget(tier, exc)
            raise
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="openai", tier=tier, detail=str(exc)
            ) from exc

    async def chat_with_history(
        self,
        messages: list[dict[str, str]],
        tier: LLMTier,
        temperature: float = 0.4,
        max_tokens: int = 1024,
        *,
        message_history=None,
    ) -> ChatResult:
        """Chat returning (text, new_messages) for persistence — see Azure."""
        agent = self._agents.get(tier)
        settings = tier_settings(tier, temperature=temperature, max_tokens=max_tokens)
        try:
            return await run_chat_with_history(
                agent, messages, settings, message_history=message_history
            )
        except ModelHTTPError as exc:
            _maybe_raise_budget(tier, exc)
            raise
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="openai", tier=tier, detail=str(exc)
            ) from exc

    async def respond(
        self,
        instructions: str,
        input_text: str,
        tier: LLMTier,
        reasoning_effort: str = "medium",
        previous_response_id: str | None = None,
    ) -> tuple[str, str | None]:
        """Single-turn Responses-style call.

        Mirrors the legacy contract: when the tier maps to a reasoning model,
        the call goes through ``OpenAIResponsesModel`` and we return a
        sentinel ``"pai-managed"`` response_id; otherwise we return None.
        """
        model_name = self._model_for_tier(tier)
        agent = self._agents.get(tier)
        settings = tier_settings(tier)
        try:
            text = await run_respond(agent, instructions, input_text, settings)
        except ModelHTTPError as exc:
            _maybe_raise_budget(tier, exc)
            raise
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="openai", tier=tier, detail=str(exc)
            ) from exc

        return text, ("pai-managed" if _is_reasoning_model(model_name) else None)

    async def run_typed(
        self,
        prompt: str,
        tier: LLMTier,
        *,
        output_type,
        instructions: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ):
        """Typed-output run via Pydantic AI's structured-output mode (item 9.3)."""
        agent = self._agents.get(tier)
        settings = tier_settings(tier, temperature=temperature, max_tokens=max_tokens)
        try:
            return await run_typed(
                agent,
                prompt,
                settings,
                output_type=output_type,
                instructions=instructions,
            )
        except ModelHTTPError as exc:
            _maybe_raise_budget(tier, exc)
            raise
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="openai", tier=tier, detail=str(exc)
            ) from exc

    async def embed(self, text: str) -> list[float]:
        """Embedding — direct openai SDK call (no Pydantic AI wrapper).

        Pydantic AI exposes ``OpenAIEmbeddingModel`` but its surface is built
        for the typed ``Embedder`` class and would require refactoring callers.
        We keep the direct-SDK call and read the model name from
        ``OPENAI_EMBEDDING_MODEL`` (default ``text-embedding-3-small``, 1536
        dims).  Set ``text-embedding-3-large`` for 3072-dim vectors.
        """
        try:
            response = await self._client.embeddings.create(
                model=self._embedding_model,
                input=text,
            )
            return response.data[0].embedding
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="openai",
                tier=LLMTier.CONFLICT,
                detail=str(exc),
            ) from exc


def _maybe_raise_budget(tier: LLMTier, exc: ModelHTTPError) -> None:
    """Translate a 429 into BudgetExhaustedError (same pattern as Azure)."""
    if getattr(exc, "status_code", None) == 429:
        raise BudgetExhaustedError(
            provider="openai", tier=tier, detail=str(exc)
        ) from exc
