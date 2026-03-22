"""Plain OpenAI provider — the default for open-source users.

Uses the standard OpenAI API (not Azure). Requires only OPENAI_API_KEY.

Uses env vars:
    OPENAI_API_KEY
    OPENAI_MODEL_T2  (default: gpt-4o-mini)
    OPENAI_MODEL_T3  (default: gpt-4o)
"""

from __future__ import annotations

import os

from openai import AsyncOpenAI, RateLimitError

from quorum_llm.interface import LLMProvider
from quorum_llm.models import BudgetExhaustedError, LLMTier
from quorum_llm.tier1 import extract_keywords

_DEFAULT_MODEL_T2 = "gpt-4o-mini"
_DEFAULT_MODEL_T3 = "gpt-4o"


class OpenAIProvider(LLMProvider):
    """Plain OpenAI LLM provider (non-Azure)."""

    def __init__(
        self,
        api_key: str | None = None,
        model_t2: str | None = None,
        model_t3: str | None = None,
    ):
        self._api_key = api_key or os.environ["OPENAI_API_KEY"]
        self._model_t2 = model_t2 or os.environ.get("OPENAI_MODEL_T2", _DEFAULT_MODEL_T2)
        self._model_t3 = model_t3 or os.environ.get("OPENAI_MODEL_T3", _DEFAULT_MODEL_T3)
        self._client = AsyncOpenAI(api_key=self._api_key)

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
            response = await self._client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3 if tier == LLMTier.CONFLICT else 0.7,
                max_tokens=2048 if tier == LLMTier.CONFLICT else 4096,
            )
            return response.choices[0].message.content or ""
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="openai",
                tier=tier,
                detail=str(exc),
            ) from exc

    async def embed(self, text: str) -> list[float]:
        try:
            response = await self._client.embeddings.create(
                model="text-embedding-3-small",
                input=text,
            )
            return response.data[0].embedding
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="openai",
                tier=LLMTier.CONFLICT,
                detail=str(exc),
            ) from exc
