"""Azure OpenAI provider implementation.

Tier 1: Deterministic keyword extraction (no LLM call — handled by tier1 module)
Tier 2: GPT-4o-mini for conflict detection
Tier 3: GPT-4o for final artifact synthesis

Uses env vars:
    AZURE_OPENAI_ENDPOINT
    AZURE_OPENAI_KEY
    AZURE_OPENAI_DEPLOYMENT_T2  (gpt-4o-mini)
    AZURE_OPENAI_DEPLOYMENT_T3  (gpt-4o)
"""

from __future__ import annotations

import os

from openai import AsyncAzureOpenAI, RateLimitError

from quorum_llm.interface import LLMProvider
from quorum_llm.models import BudgetExhaustedError, LLMTier
from quorum_llm.tier1 import extract_keywords

# Azure OpenAI API version
_API_VERSION = "2024-10-21"


class AzureOpenAIProvider(LLMProvider):
    """Azure OpenAI LLM provider."""

    def __init__(
        self,
        endpoint: str | None = None,
        api_key: str | None = None,
        deployment_t2: str | None = None,
        deployment_t3: str | None = None,
    ):
        self._endpoint = endpoint or os.environ["AZURE_OPENAI_ENDPOINT"]
        self._api_key = api_key or os.environ["AZURE_OPENAI_KEY"]
        self._deployment_t2 = (
            deployment_t2 or os.environ["AZURE_OPENAI_DEPLOYMENT_T2"]
        )
        self._deployment_t3 = (
            deployment_t3 or os.environ["AZURE_OPENAI_DEPLOYMENT_T3"]
        )
        self._client = AsyncAzureOpenAI(
            azure_endpoint=self._endpoint,
            api_key=self._api_key,
            api_version=_API_VERSION,
        )

    def _deployment_for_tier(self, tier: LLMTier) -> str:
        if tier == LLMTier.CONFLICT:
            return self._deployment_t2
        if tier == LLMTier.SYNTHESIS:
            return self._deployment_t3
        raise ValueError(f"Tier {tier} does not use LLM — use tier1 module directly")

    async def complete(self, prompt: str, tier: LLMTier) -> str:
        if tier == LLMTier.KEYWORD:
            return ", ".join(extract_keywords(prompt))

        deployment = self._deployment_for_tier(tier)
        try:
            response = await self._client.chat.completions.create(
                model=deployment,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3 if tier == LLMTier.CONFLICT else 0.7,
                max_tokens=2048 if tier == LLMTier.CONFLICT else 4096,
            )
            return response.choices[0].message.content or ""
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="azure",
                tier=tier,
                detail=str(exc),
            ) from exc

    async def embed(self, text: str) -> list[float]:
        try:
            response = await self._client.embeddings.create(
                model=self._deployment_t2,
                input=text,
            )
            return response.data[0].embedding
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="azure",
                tier=LLMTier.CONFLICT,
                detail=str(exc),
            ) from exc
