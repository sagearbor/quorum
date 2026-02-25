"""LLMProvider abstract interface — all providers implement this."""

from __future__ import annotations

from abc import ABC, abstractmethod

from quorum_llm.models import LLMTier


class LLMProvider(ABC):
    """Pluggable LLM provider interface.

    Matches CONTRACT.md:
        interface LLMProvider {
            complete(prompt: string, tier: LLMTier): Promise<string>;
            embed(text: string): Promise<number[]>;
        }
    """

    @abstractmethod
    async def complete(self, prompt: str, tier: LLMTier) -> str:
        """Generate a completion for the given prompt at the specified tier."""

    @abstractmethod
    async def embed(self, text: str) -> list[float]:
        """Generate an embedding vector for the given text."""
