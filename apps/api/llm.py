"""LLM provider interface — stub for Stream D.

Real implementation lives in Stream E (packages/llm/).
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class LLMProvider(ABC):
    """Abstract LLM provider. Swap Azure / Anthropic / local behind this."""

    @abstractmethod
    async def complete(self, prompt: str, tier: int) -> str:
        """Run a completion at the given tier (1=free, 2=cheap, 3=expensive)."""
        ...

    @abstractmethod
    async def embed(self, text: str) -> list[float]:
        """Return an embedding vector for the given text."""
        ...


class StubLLMProvider(LLMProvider):
    """No-op stub used until Stream E wires in the real provider."""

    async def complete(self, prompt: str, tier: int) -> str:
        return f"[stub] LLM synthesis not yet implemented (tier {tier})"

    async def embed(self, text: str) -> list[float]:
        return [0.0] * 256


# Module-level instance used by route handlers.
llm_provider: LLMProvider = StubLLMProvider()
