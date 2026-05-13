"""Azure OpenAI provider — thin wrapper around ``pydantic_ai.Agent``.

Tier 1: Deterministic keyword extraction (no LLM call — handled by tier1 module)
Tier 2: GPT-4o-mini deployment for conflict detection / agent chat
Tier 3: GPT-4o deployment for artifact synthesis / agent deep reasoning
Tier T5 (AGENT_RESPOND): GPT-5-nano deployment via the Responses API — Pydantic
        AI auto-routes when the underlying model profile supports it, so we no
        longer carry a hand-rolled ``self._is_gpt5(...)`` branch.

Auth (mutually exclusive, checked in order):
    API key mode:        set AZURE_OPENAI_KEY in env / .env
    Managed Identity:    omit AZURE_OPENAI_KEY; run `az login` locally or
                         use a managed identity in Azure — no secret needed

Uses env vars:
    AZURE_OPENAI_ENDPOINT
    AZURE_OPENAI_KEY                    (optional — omit to use Managed Identity)
    AZURE_OPENAI_DEPLOYMENT_T2          (gpt-4o-mini)
    AZURE_OPENAI_DEPLOYMENT_T3          (gpt-4o)
    AZURE_OPENAI_DEPLOYMENT_T5          (gpt-5-nano, optional — falls back to T2)
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT   (text-embedding-3-small; required for embed())
    AZURE_OPENAI_API_VERSION            (default: 2025-03-01-preview)

Embeddings (item 11.4): ``embed()`` targets ``AZURE_OPENAI_EMBEDDING_DEPLOYMENT``
— Azure does NOT serve embeddings from chat deployments, so the embedding
deployment MUST be configured separately (e.g. ``text-embedding-3-small``
yielding 1536-dim vectors, or ``text-embedding-3-large`` yielding 3072-dim).
If the env var is unset and no constructor arg is provided, ``embed()`` raises
a clear ``ValueError`` rather than silently degrading.
"""

from __future__ import annotations

import logging
import os

from openai import AsyncAzureOpenAI, RateLimitError
from pydantic_ai import Agent
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.providers.openai import OpenAIProvider as PaiOpenAIProvider

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

# Tiers that use the T2 deployment (gpt-4o-mini family)
_T2_TIERS = frozenset({LLMTier.CONFLICT, LLMTier.AGENT_CHAT})

# Tiers that use the T5 deployment (gpt-5-nano) via the Responses API
_T5_TIERS = frozenset({LLMTier.AGENT_RESPOND})

logger = logging.getLogger(__name__)

# Azure OpenAI API version — must be 2025-03-01-preview or later for the
# Responses API on gpt-5 deployments.
_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2025-03-01-preview")
# Scope required for Entra ID / Managed Identity token
_AZURE_COGNITIVESERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"


class AzureOpenAIProvider(LLMProvider):
    """Azure OpenAI LLM provider backed by Pydantic AI ``Agent`` instances.

    The public surface (``complete``, ``chat``, ``respond``, ``embed``) is
    identical to the legacy adapter so callers in ``apps/api`` need no
    changes.  Internally, each LLM call is routed through a per-tier
    ``pydantic_ai.Agent`` built on top of an ``OpenAIChatModel`` (or
    ``OpenAIResponsesModel`` for the T5 deployment) wired to an Azure-flavored
    ``AsyncAzureOpenAI`` client.
    """

    def __init__(
        self,
        endpoint: str | None = None,
        api_key: str | None = None,
        deployment_t2: str | None = None,
        deployment_t3: str | None = None,
        deployment_t5: str | None = None,
        deployment_embed: str | None = None,
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
        # Embedding deployment is optional at construct time so callers that
        # never invoke embed() can still build the provider.  The error is
        # deferred to embed() itself where the missing config matters.
        self._deployment_embed = (
            deployment_embed
            or os.environ.get("AZURE_OPENAI_EMBEDDING_DEPLOYMENT")
            or None
        )

        resolved_key = api_key or os.environ.get("AZURE_OPENAI_KEY")

        # Build an AsyncAzureOpenAI client up front — same dual-auth dance as
        # the legacy adapter so deployments with Managed Identity keep working.
        if resolved_key:
            logger.info("Azure LLM: using API key auth")
            self._client = AsyncAzureOpenAI(
                azure_endpoint=self._endpoint,
                api_key=resolved_key,
                api_version=_API_VERSION,
            )
        else:
            logger.info(
                "Azure LLM: AZURE_OPENAI_KEY not set — using Managed Identity (DefaultAzureCredential)"
            )
            try:
                from azure.identity import (
                    DefaultAzureCredential,
                    get_bearer_token_provider,
                )
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

        # Lazy per-tier Agent cache.  We use ``OpenAIChatModel`` for Chat
        # Completions deployments and ``OpenAIResponsesModel`` for the T5
        # deployment (so Pydantic AI hits ``/responses`` instead of
        # ``/chat/completions``).  Each model wraps the SAME underlying
        # AsyncAzureOpenAI client so we share the connection pool.
        self._agents = AgentCache(self._build_agent_for_tier)

    # -- Tier → deployment mapping -----------------------------------------

    def _deployment_for_tier(self, tier: LLMTier) -> str:
        if tier in _T2_TIERS:
            return self._deployment_t2
        if tier in _T5_TIERS:
            return self._deployment_t5
        if tier in (LLMTier.SYNTHESIS, LLMTier.AGENT_REASON):
            return self._deployment_t3
        raise ValueError(f"Tier {tier} does not use LLM — use tier1 module directly")

    def _is_reasoning_deployment(self, deployment: str) -> bool:
        """Detect deployments that need the Responses API (gpt-5 + custom names).

        Replicates the legacy ``_is_gpt5`` check: matches deployment names
        containing ``gpt-5`` and any explicit names listed in
        ``AZURE_OPENAI_REASONING_DEPLOYMENTS``.
        """
        name = deployment.lower()
        if "gpt-5" in name:
            return True
        reasoning_list = os.environ.get("AZURE_OPENAI_REASONING_DEPLOYMENTS", "")
        if reasoning_list:
            return deployment in [d.strip() for d in reasoning_list.split(",")]
        return False

    # -- Pydantic AI Agent construction ------------------------------------

    def _build_agent_for_tier(self, tier: LLMTier) -> Agent:
        deployment = self._deployment_for_tier(tier)
        # Pydantic AI's OpenAIProvider can wrap an existing AsyncAzureOpenAI
        # client — that's the documented escape hatch for Azure deployments
        # whose deployment names don't match canonical OpenAI model names
        # (Duke Health, Quorum staging, etc.).
        provider = PaiOpenAIProvider(openai_client=self._client)

        if self._is_reasoning_deployment(deployment):
            # GPT-5 / o-series: route through the Responses API model so
            # temperature is dropped automatically and reasoning effort can
            # be threaded through ModelSettings.
            model = OpenAIResponsesModel(deployment, provider=provider)
        else:
            model = OpenAIChatModel(deployment, provider=provider)

        return Agent(model)

    # -- LLMProvider surface ----------------------------------------------

    async def complete(self, prompt: str, tier: LLMTier) -> str:
        if tier == LLMTier.KEYWORD:
            return ", ".join(extract_keywords(prompt))

        agent = self._agents.get(tier)
        settings = tier_settings(tier)
        try:
            return await run_complete(agent, prompt, settings)
        except ModelHTTPError as exc:
            _maybe_raise_budget("azure", tier, exc)
            raise
        except RateLimitError as exc:  # legacy SDK error type, kept as belt-and-braces
            raise BudgetExhaustedError(
                provider="azure", tier=tier, detail=str(exc)
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
            _maybe_raise_budget("azure", tier, exc)
            raise
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="azure", tier=tier, detail=str(exc)
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

        For GPT-5 / reasoning deployments, Pydantic AI's OpenAIResponsesModel
        targets the Responses API automatically.  For non-reasoning
        deployments, we fall back to the chat path so callers get a
        consistent ``(text, response_id|None)`` shape.

        ``previous_response_id`` is currently ignored — Pydantic AI manages
        conversation continuation through ``message_history`` rather than the
        OpenAI ``previous_response_id`` parameter.  Threading is preserved by
        passing the prior ``ModelResponse`` in subsequent ``chat()`` calls.
        """
        deployment = self._deployment_for_tier(tier)
        agent = self._agents.get(tier)
        settings = tier_settings(tier)

        try:
            text = await run_respond(agent, instructions, input_text, settings)
        except ModelHTTPError as exc:
            _maybe_raise_budget("azure", tier, exc)
            raise
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="azure", tier=tier, detail=str(exc)
            ) from exc

        # Mirror the legacy contract: reasoning deployments return a (synthetic)
        # response_id so callers can thread state; chat deployments return None.
        if self._is_reasoning_deployment(deployment):
            # We don't get the OpenAI response_id back from Pydantic AI's
            # high-level API today.  Returning a sentinel keeps the tuple
            # shape stable while signalling "this came from a Responses model".
            return text, "pai-managed"
        return text, None

    async def embed(self, text: str) -> list[float]:
        """Embedding API — routed to a dedicated Azure embedding deployment.

        Azure OpenAI does NOT serve embeddings from chat deployments; the
        previous implementation targeted the T2 *chat* deployment and would
        404 against any properly-configured Azure resource (audit finding C4,
        checklist item 11.4).

        We use the ``AsyncAzureOpenAI`` client directly because Pydantic AI
        does not wrap embedding endpoints in its high-level Agent API.  The
        deployment is read from ``AZURE_OPENAI_EMBEDDING_DEPLOYMENT`` (or the
        constructor ``deployment_embed`` argument).  If unset, we raise
        ``ValueError`` rather than silently returning a fake vector.
        """
        if not self._deployment_embed:
            raise ValueError(
                "AZURE_OPENAI_EMBEDDING_DEPLOYMENT not configured. "
                "Set it to your Azure embedding deployment name (e.g. "
                "text-embedding-3-small) or pass deployment_embed to the "
                "AzureOpenAIProvider constructor."
            )
        try:
            response = await self._client.embeddings.create(
                model=self._deployment_embed,
                input=text,
            )
            return response.data[0].embedding
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="azure",
                tier=LLMTier.CONFLICT,
                detail=str(exc),
            ) from exc


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _maybe_raise_budget(provider: str, tier: LLMTier, exc: ModelHTTPError) -> None:
    """Translate a 429 from Pydantic AI into our budget-exhausted exception.

    Pydantic AI surfaces HTTP errors as ``ModelHTTPError`` with an explicit
    ``status_code`` field — checking that is more reliable than parsing the
    SDK-specific exception message.
    """
    if getattr(exc, "status_code", None) == 429:
        raise BudgetExhaustedError(
            provider=provider, tier=tier, detail=str(exc)
        ) from exc
