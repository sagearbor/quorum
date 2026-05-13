"""Anthropic provider — thin wrapper around ``pydantic_ai.Agent``.

Alternative to Azure OpenAI / OpenAI for callers who prefer Claude.

Uses env vars:
    ANTHROPIC_API_KEY
    ANTHROPIC_MODEL_T2  (default: claude-haiku-4-5-20251001)
    ANTHROPIC_MODEL_T3  (default: claude-sonnet-4-6)

Anthropic uses ``max_tokens`` (not ``max_completion_tokens``) — Pydantic AI's
``ModelSettings.max_tokens`` maps to the right parameter for each provider,
so we no longer carry a manual branch here.
"""

from __future__ import annotations

import os

import anthropic
from pydantic_ai import Agent
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.providers.anthropic import AnthropicProvider as PaiAnthropicProvider

from quorum_llm.interface import LLMProvider
from quorum_llm.models import BudgetExhaustedError, LLMTier
from quorum_llm.providers._pai_common import (
    AgentCache,
    run_chat,
    run_complete,
    run_respond,
    tier_settings,
)
from quorum_llm.tier1 import extract_keywords

_DEFAULT_MODEL_T2 = "claude-haiku-4-5-20251001"
_DEFAULT_MODEL_T3 = "claude-sonnet-4-6"


class AnthropicProvider(LLMProvider):
    """Anthropic Claude LLM provider backed by Pydantic AI ``Agent`` instances."""

    def __init__(
        self,
        api_key: str | None = None,
        model_t2: str | None = None,
        model_t3: str | None = None,
    ):
        self._api_key = api_key or os.environ["ANTHROPIC_API_KEY"]
        self._model_t2 = model_t2 or os.environ.get(
            "ANTHROPIC_MODEL_T2", _DEFAULT_MODEL_T2
        )
        self._model_t3 = model_t3 or os.environ.get(
            "ANTHROPIC_MODEL_T3", _DEFAULT_MODEL_T3
        )
        # The Anthropic Python SDK client — wrapped by Pydantic AI's provider so
        # we share a single connection pool / retry policy across all tiers.
        self._client = anthropic.AsyncAnthropic(api_key=self._api_key)
        self._agents = AgentCache(self._build_agent_for_tier)

    def _model_for_tier(self, tier: LLMTier) -> str:
        # Map the same way the legacy adapter did.  AGENT_CHAT/RESPOND share
        # the T2 (haiku) model; SYNTHESIS/AGENT_REASON use T3 (sonnet).
        if tier in (LLMTier.CONFLICT, LLMTier.AGENT_CHAT, LLMTier.AGENT_RESPOND):
            return self._model_t2
        if tier in (LLMTier.SYNTHESIS, LLMTier.AGENT_REASON):
            return self._model_t3
        raise ValueError(f"Tier {tier} does not use LLM — use tier1 module directly")

    def _build_agent_for_tier(self, tier: LLMTier) -> Agent:
        model_name = self._model_for_tier(tier)
        provider = PaiAnthropicProvider(anthropic_client=self._client)
        return Agent(AnthropicModel(model_name, provider=provider))

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
        except anthropic.RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="anthropic", tier=tier, detail=str(exc)
            ) from exc

    async def chat(
        self,
        messages: list[dict[str, str]],
        tier: LLMTier,
        temperature: float = 0.4,
        max_tokens: int = 1024,
    ) -> str:
        if tier == LLMTier.KEYWORD:
            flat = "\n".join(m["content"] for m in messages)
            return ", ".join(extract_keywords(flat))

        agent = self._agents.get(tier)
        settings = tier_settings(tier, temperature=temperature, max_tokens=max_tokens)
        try:
            return await run_chat(agent, messages, settings)
        except ModelHTTPError as exc:
            _maybe_raise_budget(tier, exc)
            raise
        except anthropic.RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="anthropic", tier=tier, detail=str(exc)
            ) from exc

    async def respond(
        self,
        instructions: str,
        input_text: str,
        tier: LLMTier,
        reasoning_effort: str = "medium",
        previous_response_id: str | None = None,
    ) -> tuple[str, str | None]:
        """Single-turn instruction+input call.

        Claude doesn't have a Responses API, so we always return ``None`` as
        the response_id — same as the base-class fallback contract.  The
        ``reasoning_effort`` argument is accepted for interface parity but
        currently ignored (no Anthropic equivalent that Pydantic AI surfaces).
        """
        agent = self._agents.get(tier)
        settings = tier_settings(tier)
        try:
            text = await run_respond(agent, instructions, input_text, settings)
        except ModelHTTPError as exc:
            _maybe_raise_budget(tier, exc)
            raise
        except anthropic.RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="anthropic", tier=tier, detail=str(exc)
            ) from exc
        return text, None

    async def embed(self, text: str) -> list[float]:
        """Embedding API — NOT SUPPORTED by Anthropic.

        Anthropic's API does not expose an embedding endpoint (as of 2026-05),
        and the previous adapter returned a 256-dim hash-bucket fake vector
        that quietly broke downstream cosine similarity (audit finding C4,
        checklist item 11.4).

        We now raise ``NotImplementedError`` so callers receive a hard,
        actionable error instead of a silently-degraded routing decision.
        Pair this provider with a dedicated embedding source — typically
        Azure (``AZURE_OPENAI_EMBEDDING_DEPLOYMENT``) or OpenAI
        (``OPENAI_API_KEY``) — by constructing the matching provider for
        embed() calls.
        """
        raise NotImplementedError(
            "Anthropic provider has no native embedding API. "
            "Configure AZURE_OPENAI_EMBEDDING_DEPLOYMENT or OPENAI_API_KEY "
            "and use AzureOpenAIProvider / OpenAIProvider for embeddings."
        )


def _maybe_raise_budget(tier: LLMTier, exc: ModelHTTPError) -> None:
    """Translate a 429 into BudgetExhaustedError."""
    if getattr(exc, "status_code", None) == 429:
        raise BudgetExhaustedError(
            provider="anthropic", tier=tier, detail=str(exc)
        ) from exc
