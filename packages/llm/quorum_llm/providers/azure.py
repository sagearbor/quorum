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

from openai import AsyncAzureOpenAI, BadRequestError, RateLimitError

from quorum_llm.interface import LLMProvider
from quorum_llm.models import BudgetExhaustedError, LLMTier
from quorum_llm.tier1 import extract_keywords

# Tiers that use the T2 deployment (gpt-4o-mini)
_T2_TIERS = frozenset({LLMTier.CONFLICT, LLMTier.AGENT_CHAT})

# Tiers that use the T5 deployment (gpt-5-nano) via the Responses API
_T5_TIERS = frozenset({LLMTier.AGENT_RESPOND})

logger = logging.getLogger(__name__)

# Azure OpenAI API version — must be 2025-03-01-preview or later for Responses API (gpt-5)
_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2025-03-01-preview")
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

    def _is_gpt5(self, deployment: str) -> bool:
        """Check if a deployment is a GPT-5/reasoning model (needs Responses API).

        Checks deployment name AND the explicit AZURE_OPENAI_REASONING_DEPLOYMENTS
        env var (comma-separated list of deployment names that are reasoning models).
        """
        name = deployment.lower()
        if "gpt-5" in name:
            return True
        # Allow explicit configuration for deployments with custom names
        reasoning_list = os.environ.get("AZURE_OPENAI_REASONING_DEPLOYMENTS", "")
        if reasoning_list:
            return deployment in [d.strip() for d in reasoning_list.split(",")]
        return False

    async def _call(self, kwargs: dict, tier: LLMTier) -> str:
        """Make an Azure OpenAI call.

        For GPT-5 models, automatically routes to the Responses API.
        For other models, uses Chat Completions with temperature retry.
        """
        model = kwargs.get("model", "")

        # GPT-5 models: use Responses API instead of Chat Completions
        if self._is_gpt5(model):
            messages = kwargs.get("messages", [])
            system_parts = [m["content"] for m in messages if m["role"] == "system"]
            user_parts = [m["content"] for m in messages if m["role"] != "system"]
            instructions = "\n".join(system_parts) if system_parts else "You are a helpful assistant."
            input_text = "\n".join(user_parts)
            try:
                response = await self._client.responses.create(
                    model=model,
                    instructions=instructions,
                    input=input_text,
                )
                return response.output_text or ""
            except RateLimitError as exc:
                raise BudgetExhaustedError(
                    provider="azure", tier=tier, detail=str(exc),
                ) from exc

        # Non-GPT-5: Chat Completions with temperature retry
        try:
            response = await self._client.chat.completions.create(**kwargs)
            return response.choices[0].message.content or ""
        except BadRequestError as exc:
            if "temperature" in str(exc) and "temperature" in kwargs:
                kwargs.pop("temperature")
                response = await self._client.chat.completions.create(**kwargs)
                return response.choices[0].message.content or ""
            raise
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="azure", tier=tier, detail=str(exc),
            ) from exc

    async def complete(self, prompt: str, tier: LLMTier) -> str:
        if tier == LLMTier.KEYWORD:
            return ", ".join(extract_keywords(prompt))

        deployment = self._deployment_for_tier(tier)
        kwargs: dict = {
            "model": deployment,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3 if tier == LLMTier.CONFLICT else 0.7,
            "max_completion_tokens": 2048 if tier == LLMTier.CONFLICT else 4096,
        }
        return await self._call(kwargs, tier)

    async def chat(
        self,
        messages: list[dict[str, str]],
        tier: LLMTier,
        temperature: float = 0.4,
        max_tokens: int = 1024,
    ) -> str:
        """Chat completion using the native Azure OpenAI messages API."""
        if tier == LLMTier.KEYWORD:
            flat = "\n".join(m["content"] for m in messages)
            return ", ".join(extract_keywords(flat))

        deployment = self._deployment_for_tier(tier)
        kwargs: dict = {
            "model": deployment,
            "messages": messages,
            "temperature": temperature,
            "max_completion_tokens": max_tokens,
        }
        return await self._call(kwargs, tier)

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

        if self._is_gpt5(deployment):
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
        result = await self.chat(messages, LLMTier.AGENT_CHAT)
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
