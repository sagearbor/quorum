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
        *,
        message_history: list | None = None,
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
            message_history: Optional list of ``pydantic_ai.messages.ModelMessage``
                             instances from a prior persisted conversation
                             (loaded via the conversations table — see
                             ``apps/api/conversation_store.py``).  The default
                             fallback ignores this parameter because the
                             flat-prompt path has no equivalent representation;
                             every Pydantic-AI–backed provider override
                             threads it through to ``Agent.run``.

        Returns:
            The assistant's response text.
        """
        # Flatten to a single string so the base complete() path works.
        # Format mirrors standard chat notation for readability in logs.
        flat = "\n".join(f"[{m['role']}]: {m['content']}" for m in messages)
        return await self.complete(flat, tier)

    async def chat_with_history(
        self,
        messages: list[dict[str, str]],
        tier: LLMTier,
        temperature: float = 0.4,
        max_tokens: int = 1024,
        *,
        message_history: list | None = None,
    ):
        """Multi-turn chat that returns text plus the new-message delta.

        The return type is ``ChatResult`` for Pydantic-AI–backed providers
        (``text`` + ``new_messages``).  The default fallback returns a
        ``ChatResult`` with an empty ``new_messages`` list so callers can
        treat every provider uniformly — they'll get text-only persistence
        in that case, which is still correct.

        Providers that override ``chat_with_history`` (Azure / OpenAI /
        Anthropic / Local) thread ``message_history`` through Pydantic AI's
        ``Agent.run(message_history=...)`` and return the run's
        ``new_messages()`` so the conversation store can append to the
        persisted history.
        """
        # Import here to avoid the providers package being a hard dep of the
        # ABC at import time (the interface ships with the package; the shared
        # helpers may be optional in some lightweight installs).
        from quorum_llm.providers._pai_common import ChatResult

        text = await self.chat(
            messages,
            tier,
            temperature=temperature,
            max_tokens=max_tokens,
            message_history=message_history,
        )
        return ChatResult(text=text, new_messages=[])

    async def respond(
        self,
        instructions: str,
        input_text: str,
        tier: LLMTier,
        reasoning_effort: str = "medium",
        previous_response_id: str | None = None,
    ) -> tuple[str, str | None]:
        """Responses API call for GPT-5 models.

        GPT-5 and later reasoning models use OpenAI's Responses API rather
        than Chat Completions.  Key differences:
        - No temperature/top_p/presence_penalty/frequency_penalty params.
        - Uses ``reasoning.effort`` (low/medium/high) instead of temperature.
        - Stateful: ``previous_response_id`` threads multiple calls into one
          conversation context on the server side, avoiding re-sending the
          full history on each turn.

        The default implementation falls back to ``chat()`` so that callers
        can use ``respond()`` uniformly regardless of which model is active.
        Providers that support GPT-5 natively should override this method.

        Args:
            instructions: The agent's system-level instructions.  Passed as
                          the ``instructions`` field in the Responses API
                          (equivalent to the system message in Chat Completions
                          but separated out in the new API).
            input_text: The user's current message or assembled context block.
            tier: LLM tier for cost tracking.  Use ``LLMTier.AGENT_RESPOND``
                  for standard GPT-5-nano turns.
            reasoning_effort: One of "low", "medium", "high".  Controls the
                              depth of the model's internal reasoning chain.
                              Ignored by the fallback Chat Completions path.
            previous_response_id: If set, the Responses API continues the
                                  conversation from the given response rather
                                  than starting fresh.  This is what makes
                                  GPT-5 turns efficiently stateful.  Ignored
                                  by the fallback path.

        Returns:
            A 2-tuple of (response_text, response_id).  ``response_id`` is
            None when the fallback Chat Completions path is used.  When the
            real Responses API is used, ``response_id`` can be stored and
            passed back as ``previous_response_id`` on the next turn.
        """
        # Default: fall back to chat() so code works even without GPT-5 access.
        # Providers with Responses API support (AzureOpenAIProvider) override this.
        messages = [
            {"role": "system", "content": instructions},
            {"role": "user", "content": input_text},
        ]
        result = await self.chat(messages, tier)
        return result, None
