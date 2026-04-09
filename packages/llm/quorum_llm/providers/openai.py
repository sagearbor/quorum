"""Plain OpenAI provider — the default for open-source users.

Uses the standard OpenAI API (not Azure). Requires only OPENAI_API_KEY.

Uses env vars:
    OPENAI_API_KEY
    OPENAI_MODEL_T2  (default: gpt-4o-mini)
    OPENAI_MODEL_T3  (default: gpt-4o)
"""

from __future__ import annotations

import os

from openai import AsyncOpenAI, BadRequestError, RateLimitError

from quorum_llm.interface import LLMProvider
from quorum_llm.models import BudgetExhaustedError, LLMTier
from quorum_llm.tier1 import extract_keywords

_DEFAULT_MODEL_T2 = "gpt-4o-mini"
_DEFAULT_MODEL_T3 = "gpt-4o"


def _is_reasoning_model(model: str) -> bool:
    """Reasoning models don't support temperature.

    Covers: o1, o3, o4 series, gpt-5 series, and any model that
    OpenAI may restrict temperature on in the future.
    """
    name = model.lower()
    # o-series reasoning models
    if any(name.startswith(p) for p in ("o1", "o3", "o4")):
        return True
    # GPT-5 family uses Responses API but also rejects temperature via Chat Completions
    if "gpt-5" in name:
        return True
    return False


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
        if tier in (LLMTier.CONFLICT, LLMTier.AGENT_CHAT, LLMTier.AGENT_RESPOND):
            return self._model_t2
        if tier in (LLMTier.SYNTHESIS, LLMTier.AGENT_REASON):
            return self._model_t3
        raise ValueError(f"Tier {tier} does not use LLM — use tier1 module directly")

    async def _call(self, kwargs: dict, tier: LLMTier) -> str:
        """Make an OpenAI API call, retrying without temperature if rejected."""
        try:
            response = await self._client.chat.completions.create(**kwargs)
            return response.choices[0].message.content or ""
        except BadRequestError as exc:
            if "temperature" in str(exc) and "temperature" in kwargs:
                # Model doesn't support temperature — retry without it
                kwargs.pop("temperature")
                response = await self._client.chat.completions.create(**kwargs)
                return response.choices[0].message.content or ""
            raise
        except RateLimitError as exc:
            raise BudgetExhaustedError(
                provider="openai", tier=tier, detail=str(exc),
            ) from exc

    async def complete(self, prompt: str, tier: LLMTier) -> str:
        if tier == LLMTier.KEYWORD:
            return ", ".join(extract_keywords(prompt))

        model = self._model_for_tier(tier)
        kwargs: dict = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_completion_tokens": 2048 if tier == LLMTier.CONFLICT else 4096,
        }
        if not _is_reasoning_model(model):
            kwargs["temperature"] = 0.3 if tier == LLMTier.CONFLICT else 0.7
        return await self._call(kwargs, tier)

    async def chat(
        self,
        messages: list[dict[str, str]],
        tier: LLMTier,
        temperature: float = 0.4,
        max_tokens: int = 1024,
    ) -> str:
        model = self._model_for_tier(tier)
        kwargs: dict = {
            "model": model,
            "messages": messages,
            "max_completion_tokens": max_tokens,
        }
        if not _is_reasoning_model(model):
            kwargs["temperature"] = temperature
        return await self._call(kwargs, tier)

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
