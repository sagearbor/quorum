"""Tests for the respond() Responses API method — Task 1 of Phase 2 Track D.

Covers:
- LLMTier.AGENT_RESPOND value exists and is positioned correctly
- LLMProvider base class default respond() falls back to chat()
- MockLLMProvider.respond() returns (text, response_id) tuple
- MockLLMProvider.respond() records call with reasoning_effort in call_log
- MockLLMProvider.respond() handles previous_response_id threading
- MockLLMProvider.respond() at AGENT_RESPOND tier returns agent-like response
- Base interface respond() fallback uses correct tier
"""

from __future__ import annotations

import pytest

from quorum_llm.interface import LLMProvider
from quorum_llm.models import LLMTier
from quorum_llm.providers.mock import MockLLMProvider


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_provider() -> MockLLMProvider:
    return MockLLMProvider()


# ---------------------------------------------------------------------------
# LLMTier tests
# ---------------------------------------------------------------------------


def test_agent_respond_tier_value():
    """AGENT_RESPOND must be 22 — stored in DB, value must not change."""
    assert LLMTier.AGENT_RESPOND == 22


def test_agent_respond_sits_between_agent_chat_and_synthesis():
    """AGENT_RESPOND (22) should sort between AGENT_CHAT (21) and SYNTHESIS (3).

    Note: IntEnum numeric ordering is used, so SYNTHESIS=3 < AGENT_CHAT=21.
    AGENT_RESPOND=22 comes after AGENT_CHAT and before AGENT_REASON=31.
    """
    assert LLMTier.AGENT_CHAT < LLMTier.AGENT_RESPOND < LLMTier.AGENT_REASON


def test_existing_tier_values_unchanged():
    """Adding AGENT_RESPOND must not shift any existing tier integer values."""
    assert LLMTier.KEYWORD == 1
    assert LLMTier.CONFLICT == 2
    assert LLMTier.SYNTHESIS == 3
    assert LLMTier.AGENT_CHAT == 21
    assert LLMTier.AGENT_REASON == 31


# ---------------------------------------------------------------------------
# MockLLMProvider.respond() tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mock_respond_returns_tuple(mock_provider):
    """respond() must return a (str, str) tuple, not just a string."""
    result = await mock_provider.respond(
        instructions="You are an IRB officer.",
        input_text="Confirm the eGFR threshold.",
        tier=LLMTier.AGENT_RESPOND,
    )

    assert isinstance(result, tuple)
    assert len(result) == 2
    text, response_id = result
    assert isinstance(text, str)
    assert isinstance(response_id, str)


@pytest.mark.asyncio
async def test_mock_respond_returns_non_empty_text(mock_provider):
    """Response text must be substantive (not blank)."""
    text, _ = await mock_provider.respond(
        instructions="You are a safety monitor.",
        input_text="What are the stopping rules?",
        tier=LLMTier.AGENT_RESPOND,
    )
    assert len(text.strip()) > 20


@pytest.mark.asyncio
async def test_mock_respond_returns_response_id(mock_provider):
    """response_id must be a non-empty string (simulates Responses API ID)."""
    _, response_id = await mock_provider.respond(
        instructions="You are a budget analyst.",
        input_text="Review the cost allocation.",
        tier=LLMTier.AGENT_RESPOND,
    )
    assert response_id is not None
    assert len(response_id) > 0
    # Fake IDs use a predictable prefix for identification in tests
    assert response_id.startswith("resp_")


@pytest.mark.asyncio
async def test_mock_respond_records_call_in_log(mock_provider):
    """respond() must append a call entry to call_log."""
    assert len(mock_provider.call_log) == 0

    await mock_provider.respond(
        instructions="System prompt",
        input_text="User input",
        tier=LLMTier.AGENT_RESPOND,
    )

    assert len(mock_provider.call_log) == 1
    entry = mock_provider.call_log[0]
    assert entry["tier"] == int(LLMTier.AGENT_RESPOND)
    assert "prompt_hash" in entry
    assert "reasoning_effort" in entry


@pytest.mark.asyncio
async def test_mock_respond_records_reasoning_effort(mock_provider):
    """Call log entry must record the reasoning_effort for test assertions."""
    await mock_provider.respond(
        instructions="System",
        input_text="Input",
        tier=LLMTier.AGENT_RESPOND,
        reasoning_effort="high",
    )

    assert mock_provider.call_log[0]["reasoning_effort"] == "high"


@pytest.mark.asyncio
async def test_mock_respond_records_previous_response_id(mock_provider):
    """previous_response_id must be stored in call_log for thread verification."""
    prev_id = "resp_abc123_x0y1z2a3"
    await mock_provider.respond(
        instructions="System",
        input_text="Follow-up question",
        tier=LLMTier.AGENT_RESPOND,
        previous_response_id=prev_id,
    )

    assert mock_provider.call_log[0]["previous_response_id"] == prev_id


@pytest.mark.asyncio
async def test_mock_respond_default_reasoning_effort(mock_provider):
    """Default reasoning_effort should be 'medium'."""
    await mock_provider.respond(
        instructions="System",
        input_text="Input",
        tier=LLMTier.AGENT_RESPOND,
    )

    assert mock_provider.call_log[0]["reasoning_effort"] == "medium"


@pytest.mark.asyncio
async def test_mock_respond_contains_tags(mock_provider):
    """Mock response should contain [tags: ...] block for downstream extraction."""
    text, _ = await mock_provider.respond(
        instructions="System",
        input_text="Input",
        tier=LLMTier.AGENT_RESPOND,
    )

    assert "[tags:" in text.lower()


@pytest.mark.asyncio
async def test_mock_respond_stateful_thread_different_ids(mock_provider):
    """Each respond() call should return a distinct response_id."""
    _, id1 = await mock_provider.respond(
        instructions="System",
        input_text="First message",
        tier=LLMTier.AGENT_RESPOND,
    )
    _, id2 = await mock_provider.respond(
        instructions="System",
        input_text="Second message",
        tier=LLMTier.AGENT_RESPOND,
    )
    # IDs are unique (UUID suffix ensures this)
    assert id1 != id2


# ---------------------------------------------------------------------------
# LLMProvider base class default respond() fallback
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_base_interface_respond_falls_back_to_chat():
    """The default LLMProvider.respond() must delegate to chat() and return None
    as the response_id (no Responses API available)."""

    class MinimalProvider(LLMProvider):
        """Provider implementing only complete() and embed() — no respond() override."""

        def __init__(self):
            self.chat_calls: list = []

        async def complete(self, prompt: str, tier: LLMTier) -> str:
            return "complete fallback"

        async def embed(self, text: str) -> list[float]:
            return []

        async def chat(
            self,
            messages: list[dict[str, str]],
            tier: LLMTier,
            temperature: float = 0.4,
            max_tokens: int = 1024,
        ) -> str:
            self.chat_calls.append((messages, tier))
            return "chat fallback"

    p = MinimalProvider()
    text, response_id = await p.respond(
        instructions="System instructions",
        input_text="User input",
        tier=LLMTier.AGENT_RESPOND,
    )

    # Must return text from chat() and None for response_id (no Responses API)
    assert text == "chat fallback"
    assert response_id is None

    # Must have called chat() exactly once
    assert len(p.chat_calls) == 1
    messages, tier = p.chat_calls[0]

    # System message must match the instructions parameter
    assert any(m["role"] == "system" and "System instructions" in m["content"] for m in messages)
    # User message must match the input_text parameter
    assert any(m["role"] == "user" and "User input" in m["content"] for m in messages)


@pytest.mark.asyncio
async def test_base_interface_respond_returns_none_response_id():
    """The fallback respond() must return None as response_id, not an empty string."""

    class BareProvider(LLMProvider):
        async def complete(self, prompt: str, tier: LLMTier) -> str:
            return "response"

        async def embed(self, text: str) -> list[float]:
            return []

    p = BareProvider()
    _, response_id = await p.respond(
        instructions="",
        input_text="Hello",
        tier=LLMTier.AGENT_RESPOND,
    )
    assert response_id is None
