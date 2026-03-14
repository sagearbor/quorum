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
            chat(messages: Message[], tier: LLMTier): Promise<string>;
        }

    The ``chat`` method is a concrete default that flattens the messages array
    into a single prompt string and delegates to ``complete``.  Providers that
    support native multi-turn APIs (Azure OpenAI, Anthropic) should override
    ``chat`` to pass the messages array directly — this enables prompt caching
    on the stable system/context prefix.
    """

    @abstractmethod
    async def complete(self, prompt: str, tier: LLMTier) -> str:
        """Generate a completion for the given prompt at the specified tier."""

    @abstractmethod
    async def embed(self, text: str) -> list[float]:
        """Generate an embedding vector for the given text."""

    async def chat(
        self,
        messages: list[dict[str, str]],
        tier: LLMTier,
        temperature: float = 0.4,
        max_tokens: int = 1024,
    ) -> str:
        """Chat completion with conversation history.

        Default implementation flattens ``messages`` to a single string and
        calls ``complete``.  Providers that support native multi-turn chat
        (Azure OpenAI, Anthropic) should override this method to pass the
        messages array directly, which enables Azure prompt caching on stable
        prefixes and gives the model richer context for role-play fidelity.

        Args:
            messages: Ordered list of ``{"role": ..., "content": ...}`` dicts.
                      Role values must be "system", "user", or "assistant".
            tier: LLM tier controlling model selection and cost tracking.
                  Typically ``LLMTier.AGENT_CHAT`` for facilitator turns or
                  ``LLMTier.AGENT_REASON`` for escalation / deep reasoning.
            temperature: Sampling temperature (0.0–1.0).  Ignored by the
                         default flat-prompt fallback — passed through in
                         provider overrides.
            max_tokens: Upper bound on output tokens.  Same caveat as above.

        Returns:
            The assistant's response text.
        """
        # Flatten to a single string so the base complete() path works.
        # Format mirrors standard chat notation for readability in logs.
        flat = "\n".join(f"[{m['role']}]: {m['content']}" for m in messages)
        return await self.complete(flat, tier)
