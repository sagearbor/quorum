"""Azure OpenAI provider implementation.

Tier 1: Deterministic keyword extraction (no LLM call — handled by tier1 module)
Tier 2: GPT-4o-mini for conflict detection
Tier 3: GPT-4o for final artifact synthesis

Auth (mutually exclusive, checked in order):
    API key mode:        set AZURE_OPENAI_KEY in env / .env
    Managed Identity:    omit AZURE_OPENAI_KEY; run `az login` locally
                         or use a managed identity in Azure — no secret needed

Uses env vars:
    AZURE_OPENAI_ENDPOINT
    AZURE_OPENAI_KEY            (optional — omit to use Managed Identity)
    AZURE_OPENAI_DEPLOYMENT_T2  (gpt-4o-mini)
    AZURE_OPENAI_DEPLOYMENT_T3  (gpt-4o)
"""

from __future__ import annotations

import logging
import os

from openai import AsyncAzureOpenAI, RateLimitError

from quorum_llm.interface import LLMProvider
from quorum_llm.models import BudgetExhaustedError, LLMTier
from quorum_llm.tier1 import extract_keywords

# Tiers that use the T2 deployment (gpt-4o-mini)
_T2_TIERS = frozenset({LLMTier.CONFLICT, LLMTier.AGENT_CHAT})

logger = logging.getLogger(__name__)

# Azure OpenAI API version
_API_VERSION = "2024-10-21"
# Scope required for Entra ID / Managed Identity token
_AZURE_COGNITIVESERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"


class AzureOpenAIProvider(LLMProvider):
    """Azure OpenAI LLM provider.

    Supports two auth modes:
    - API key:          pass api_key or set AZURE_OPENAI_KEY env var
    - Managed Identity: omit api_key/AZURE_OPENAI_KEY; uses DefaultAzureCredential
                        (works with `az login` locally or managed identity in Azure)
    """

    def __init__(
        self,
        endpoint: str | None = None,
        api_key: str | None = None,
        deployment_t2: str | None = None,
        deployment_t3: str | None = None,
    ):
        self._endpoint = endpoint or os.environ["AZURE_OPENAI_ENDPOINT"]
        self._deployment_t2 = (
            deployment_t2 or os.environ["AZURE_OPENAI_DEPLOYMENT_T2"]
        )
        self._deployment_t3 = (
            deployment_t3 or os.environ["AZURE_OPENAI_DEPLOYMENT_T3"]
        )

        resolved_key = api_key or os.environ.get("AZURE_OPENAI_KEY")

        if resolved_key:
            logger.info("Azure LLM: using API key auth")
            self._client = AsyncAzureOpenAI(
                azure_endpoint=self._endpoint,
                api_key=resolved_key,
                api_version=_API_VERSION,
            )
        else:
            logger.info("Azure LLM: AZURE_OPENAI_KEY not set — using Managed Identity (DefaultAzureCredential)")
            try:
                from azure.identity import DefaultAzureCredential, get_bearer_token_provider
            except ImportError as exc:
                raise ImportError(
                    "azure-identity is required for Managed Identity auth. "
                    "Run: pip install azure-identity"
                ) from exc

            token_provider = get_bearer_token_provider(
                DefaultAzureCredential(), _AZURE_COGNITIVESERVICES_SCOPE
            )
            self._client = AsyncAzureOpenAI(
                azure_endpoint=self._endpoint,
                azure_ad_token_provider=token_provider,
                api_version=_API_VERSION,
            )

    def _deployment_for_tier(self, tier: LLMTier) -> str:
        """Map a tier to the appropriate Azure deployment name.

        AGENT_CHAT uses the same gpt-4o-mini deployment as CONFLICT but is
        tracked separately for cost accounting purposes.
        AGENT_REASON uses the same gpt-4o deployment as SYNTHESIS but is
        reserved for escalation / deep reasoning turns only.
        """
        if tier in _T2_TIERS:
            return self._deployment_t2
        if tier in (LLMTier.SYNTHESIS, LLMTier.AGENT_REASON):
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

    async def chat(
        self,
        messages: list[dict[str, str]],
        tier: LLMTier,
        temperature: float = 0.4,
        max_tokens: int = 1024,
    ) -> str:
        """Chat completion using the native Azure OpenAI messages API.

        Passes the full messages array directly to the API rather than
        flattening to a string.  This gives the model proper role-aware
        context and enables Azure OpenAI prompt caching on stable prefixes
        (system message + slowly-changing context block), reducing per-turn
        cost by ~50% after the first call in a session.

        The KEYWORD tier is not applicable for multi-turn chat; callers should
        use ``complete()`` or ``extract_keywords()`` from tier1 directly.
        """
        if tier == LLMTier.KEYWORD:
            # Keyword extraction is deterministic and does not use the messages
            # format — flatten and delegate so callers can use chat() uniformly.
            flat = "\n".join(m["content"] for m in messages)
            return ", ".join(extract_keywords(flat))

        deployment = self._deployment_for_tier(tier)
        # Default temperature per tier: lower for analytical turns (conflict,
        # agent_chat), higher for synthesis/reasoning turns.
        resolved_temperature = temperature
        resolved_max_tokens = max_tokens

        try:
            response = await self._client.chat.completions.create(
                model=deployment,
                messages=messages,  # type: ignore[arg-type]
                temperature=resolved_temperature,
                max_tokens=resolved_max_tokens,
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
