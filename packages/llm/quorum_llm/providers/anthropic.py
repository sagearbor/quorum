"""Anthropic provider implementation — alternative to Azure OpenAI.

Uses env vars:
    ANTHROPIC_API_KEY
    ANTHROPIC_MODEL_T2  (default: claude-haiku-4-5-20251001)
    ANTHROPIC_MODEL_T3  (default: claude-sonnet-4-6)
"""

from __future__ import annotations

import os

import anthropic

from quorum_llm.interface import LLMProvider
from quorum_llm.models import BudgetExhaustedError, LLMTier
from quorum_llm.tier1 import extract_keywords

_DEFAULT_MODEL_T2 = "claude-haiku-4-5-20251001"
_DEFAULT_MODEL_T3 = "claude-sonnet-4-6"


class AnthropicProvider(LLMProvider):
    """Anthropic Claude LLM provider."""

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
        self._client = anthropic.AsyncAnthropic(api_key=self._api_key)

    def _model_for_tier(self, tier: LLMTier) -> str:
        if tier == LLMTier.CONFLICT:
            return self._model_t2
        if tier == LLMTier.SYNTHESIS:
            return self._model_t3
        raise ValueError(f"Tier {tier} does not use LLM — use tier1 module directly")

    async def complete(self, prompt: str, tier: LLMTier) -> str:
        if tier == LLMTier.KEYWORD:
            return ", ".join(extract_keywords(prompt))

        model = self._model_for_tier(tier)
        try:
            response = await self._client.messages.create(
                model=model,
                max_tokens=2048 if tier == LLMTier.CONFLICT else 4096,
                messages=[{"role": "user", "content": prompt}],
            )
            return response.content[0].text
        except anthropic.RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="anthropic",
                tier=tier,
                detail=str(exc),
            ) from exc

    async def embed(self, text: str) -> list[float]:
        # Anthropic does not offer an embedding API.
        # Fall back to a simple TF-based embedding for compatibility.
        # In production, pair with a dedicated embedding provider.
        from quorum_llm.tier1 import extract_keywords

        keywords = extract_keywords(text, max_keywords=50)
        # Return a sparse keyword-hash vector of fixed dimension
        dim = 256
        vec = [0.0] * dim
        for kw in keywords:
            idx = hash(kw) % dim
            vec[idx] = 1.0
        # Normalize
        magnitude = sum(v * v for v in vec) ** 0.5
        if magnitude > 0:
            vec = [v / magnitude for v in vec]
        return vec
