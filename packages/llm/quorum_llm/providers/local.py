"""Local LLM provider via Ollama — thin wrapper around ``pydantic_ai.Agent``.

Zero cloud dependency.  Ollama exposes an OpenAI-compatible API at
``<host>/v1``, so we use Pydantic AI's ``OpenAIChatModel`` pointed at the
local endpoint.

Uses env vars:
    OLLAMA_BASE_URL   (default: http://localhost:11434)
    OLLAMA_MODEL      (default: llama3.3)

A single Ollama model serves every tier — there's no T2/T3 distinction
locally because the user's machine only runs one model at a time.
"""

from __future__ import annotations

import os

from openai import AsyncOpenAI
from pydantic_ai import Agent
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.models.openai import OpenAIChatModel
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
    tier_settings,
)
from quorum_llm.tier1 import extract_keywords

_DEFAULT_BASE_URL = "http://localhost:11434"
_DEFAULT_MODEL = "llama3.3"


class LocalOllamaProvider(LLMProvider):
    """Ollama-backed local LLM provider."""

    def __init__(
        self,
        base_url: str | None = None,
        model: str | None = None,
    ):
        self._base_url = base_url or os.environ.get("OLLAMA_BASE_URL", _DEFAULT_BASE_URL)
        self._model = model or os.environ.get("OLLAMA_MODEL", _DEFAULT_MODEL)
        # Ollama serves an OpenAI-compatible API at /v1; the api_key is a
        # placeholder Ollama doesn't actually validate.
        self._client = AsyncOpenAI(
            base_url=f"{self._base_url.rstrip('/')}/v1",
            api_key="ollama",
        )
        # All tiers share the same agent because we only have one local model.
        # The AgentCache abstraction still works — the factory ignores tier.
        self._agents = AgentCache(self._build_agent_for_tier)

    def _build_agent_for_tier(self, tier: LLMTier) -> Agent:
        provider = PaiOpenAIProvider(openai_client=self._client)
        # OpenAIChatModel is fine for every Ollama model — they all expose the
        # /chat/completions shape regardless of the underlying architecture.
        return Agent(OpenAIChatModel(self._model, provider=provider))

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

    async def chat(
        self,
        messages: list[dict[str, str]],
        tier: LLMTier,
        temperature: float | None = None,
        max_tokens: int | None = None,
        *,
        message_history=None,
    ) -> str:
        if tier == LLMTier.KEYWORD:
            flat = "\n".join(m["content"] for m in messages)
            return ", ".join(extract_keywords(flat))

        agent = self._agents.get(tier)
        settings = tier_settings(tier, temperature=temperature, max_tokens=max_tokens)
        try:
            return await run_chat(
                agent, messages, settings, message_history=message_history
            )
        except ModelHTTPError as exc:
            _maybe_raise_budget(tier, exc)
            raise

    async def chat_with_history(
        self,
        messages: list[dict[str, str]],
        tier: LLMTier,
        temperature: float | None = None,
        max_tokens: int | None = None,
        *,
        message_history=None,
    ) -> ChatResult:
        """Chat returning (text, new_messages) for persistence — see Azure."""
        if tier == LLMTier.KEYWORD:
            flat = "\n".join(m["content"] for m in messages)
            return ChatResult(text=", ".join(extract_keywords(flat)), new_messages=[])

        agent = self._agents.get(tier)
        settings = tier_settings(tier, temperature=temperature, max_tokens=max_tokens)
        try:
            return await run_chat_with_history(
                agent, messages, settings, message_history=message_history
            )
        except ModelHTTPError as exc:
            _maybe_raise_budget(tier, exc)
            raise

    async def respond(
        self,
        instructions: str,
        input_text: str,
        tier: LLMTier,
        reasoning_effort: str = "medium",
        previous_response_id: str | None = None,
    ) -> tuple[str, str | None]:
        """Single-turn instruction+input call.

        Ollama has no Responses API, so this is implemented as a normal chat
        run with the instructions threaded through the system message.
        Returns ``None`` as the response_id, matching the base-class contract.
        """
        agent = self._agents.get(tier)
        settings = tier_settings(tier)
        try:
            text = await run_respond(agent, instructions, input_text, settings)
        except ModelHTTPError as exc:
            _maybe_raise_budget(tier, exc)
            raise
        return text, None

    async def embed(self, text: str) -> list[float]:
        """Embedding via Ollama's OpenAI-compatible /v1/embeddings endpoint.

        Preserved verbatim from the legacy adapter — Pydantic AI does not
        wrap embedding endpoints in its high-level API.
        """
        response = await self._client.embeddings.create(
            model=self._model,
            input=text,
        )
        return response.data[0].embedding


def _maybe_raise_budget(tier: LLMTier, exc: ModelHTTPError) -> None:
    """Local models don't really hit rate limits, but the translation is free."""
    if getattr(exc, "status_code", None) == 429:
        raise BudgetExhaustedError(
            provider="local", tier=tier, detail=str(exc)
        ) from exc
