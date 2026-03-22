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

# Tiers that use the T5 deployment (gpt-5-nano) via the Responses API
_T5_TIERS = frozenset({LLMTier.AGENT_RESPOND})

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
        deployment_t5: str | None = None,
    ):
        self._endpoint = endpoint or os.environ["AZURE_OPENAI_ENDPOINT"]
        self._deployment_t2 = (
            deployment_t2 or os.environ["AZURE_OPENAI_DEPLOYMENT_T2"]
        )
        self._deployment_t3 = (
            deployment_t3 or os.environ["AZURE_OPENAI_DEPLOYMENT_T3"]
        )
        # T5 deployment is optional — gpt-5-nano via Responses API.
        # Falls back gracefully to the T2 deployment if not configured.
        self._deployment_t5 = (
            deployment_t5
            or os.environ.get("AZURE_OPENAI_DEPLOYMENT_T5")
            or self._deployment_t2
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
        AGENT_RESPOND uses the gpt-5-nano deployment (T5) via the Responses API.
        AGENT_REASON uses the same gpt-4o deployment as SYNTHESIS but is
        reserved for escalation / deep reasoning turns only.
        """
        if tier in _T2_TIERS:
            return self._deployment_t2
        if tier in _T5_TIERS:
            return self._deployment_t5
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

    async def respond(
        self,
        instructions: str,
        input_text: str,
        tier: LLMTier,
        reasoning_effort: str = "medium",
        previous_response_id: str | None = None,
    ) -> tuple[str, str | None]:
        """Responses API call for GPT-5 models.

        Uses the OpenAI Responses API (``client.responses.create``) when the
        T5 deployment is a gpt-5-* model.  Falls back to Chat Completions for
        older deployments so callers don't need to branch on model type.

        Key API differences vs Chat Completions:
        - No temperature / top_p / presence_penalty / frequency_penalty.
        - Uses ``reasoning.effort`` (low/medium/high) instead.
        - Stateful: ``previous_response_id`` threads requests server-side,
          avoiding re-transmission of the full conversation history.

        Args:
            instructions: System-level instructions for the agent.
            input_text: The current user message / context to process.
            tier: Should be ``LLMTier.AGENT_RESPOND`` for GPT-5-nano turns.
            reasoning_effort: "low", "medium", or "high".
            previous_response_id: ID from the previous response in the thread.

        Returns:
            (response_text, response_id) where response_id can be stored and
            passed back as previous_response_id to continue the thread.
        """
        deployment = self._deployment_for_tier(tier)

        # Detect whether the deployment is a GPT-5 model.  GPT-5 models
        # require the Responses API; GPT-4 deployments use Chat Completions.
        # We check the deployment name because the model field on the response
        # object is only available after the call, not before.
        is_gpt5 = deployment.startswith("gpt-5") or (
            self._deployment_t5 == deployment
            and "gpt-5" in (os.environ.get("AZURE_OPENAI_DEPLOYMENT_T5") or "")
        )

        if is_gpt5:
            try:
                kwargs: dict = {
                    "model": deployment,
                    "instructions": instructions,
                    "input": input_text,
                    "reasoning": {"effort": reasoning_effort},
                }
                if previous_response_id:
                    kwargs["previous_response_id"] = previous_response_id

                response = await self._client.responses.create(**kwargs)
                return response.output_text, response.id
            except RateLimitError as exc:
                raise BudgetExhaustedError(
                    provider="azure",
                    tier=tier,
                    detail=str(exc),
                ) from exc

        # Fallback: use Chat Completions for non-GPT-5 deployments
        messages = [
            {"role": "system", "content": instructions},
            {"role": "user", "content": input_text},
        ]
        result = await self.chat(messages, tier)
        return result, None

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
