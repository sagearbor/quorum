"""Pydantic AI MessageHistory wiring — tests for checklist item 9.2.

Verifies that:

1. ``provider.chat(message_history=...)`` threads the persisted history list
   through to ``Agent.run(message_history=...)`` so the model sees prior
   turns without us having to inline them in the dict messages.

2. ``provider.chat_with_history(...)`` returns a ``ChatResult`` whose
   ``new_messages`` field contains only the delta from THIS run (not the
   full conversation) — that delta is what callers persist to the
   ``conversations`` table.

3. The ``serialise_messages`` / ``deserialise_messages`` helpers round-trip
   a Pydantic AI message list losslessly via the JSON-safe dict form used by
   the JSONB column.

These tests use ``FunctionModel`` (same pattern as test_pydantic_ai_swap.py)
so no real model is contacted.
"""

from __future__ import annotations

import pytest

from pydantic_ai import models as pai_models
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel

from quorum_llm.models import LLMTier
from quorum_llm.providers._pai_common import (
    ChatResult,
    deserialise_messages,
    serialise_messages,
)
from quorum_llm.providers.azure import AzureOpenAIProvider
from quorum_llm.providers.mock import MockLLMProvider
from quorum_llm.providers.openai import OpenAIProvider

# Belt-and-braces — same guard as test_pydantic_ai_swap.py.
pai_models.ALLOW_MODEL_REQUESTS = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _Capture:
    """Capturing FunctionModel — records every Agent.run call."""

    def __init__(self, response: str = "ok"):
        self.calls: list[tuple[list[ModelMessage], AgentInfo]] = []
        self._response = response

    def as_model(self) -> FunctionModel:
        async def _fn(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            self.calls.append((messages, info))
            return ModelResponse(parts=[TextPart(content=self._response)])

        return FunctionModel(_fn)


@pytest.fixture
def azure_provider(monkeypatch):
    monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
    return AzureOpenAIProvider(
        endpoint="https://fake.openai.azure.com/",
        api_key="fake",
        deployment_t2="gpt-4o-mini",
        deployment_t3="gpt-4o",
        deployment_t5="gpt-4o-mini",
    )


@pytest.fixture
def openai_provider(monkeypatch):
    monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
    return OpenAIProvider(api_key="fake", model_t2="gpt-4o-mini", model_t3="gpt-4o")


# ---------------------------------------------------------------------------
# Serialisation round-trip
# ---------------------------------------------------------------------------


class TestSerialisation:
    def test_round_trip_preserves_structure(self):
        original: list[ModelMessage] = [
            ModelRequest(parts=[SystemPromptPart(content="You are a safety monitor.")]),
            ModelRequest(parts=[UserPromptPart(content="What is the stopping rule?")]),
            ModelResponse(parts=[TextPart(content="Pause enrollment at >15% SAE rate.")]),
        ]
        serialised = serialise_messages(original)
        # Serialised form is JSON-safe — list of dicts.
        assert isinstance(serialised, list)
        assert all(isinstance(m, dict) for m in serialised)

        # Round-trip back into ModelMessage instances.
        restored = deserialise_messages(serialised)
        assert len(restored) == 3
        assert isinstance(restored[0], ModelRequest)
        assert isinstance(restored[2], ModelResponse)

        # Content survives the trip.
        sys_part = restored[0].parts[0]
        assert isinstance(sys_part, SystemPromptPart)
        assert sys_part.content == "You are a safety monitor."

        user_part = restored[1].parts[0]
        assert isinstance(user_part, UserPromptPart)
        assert user_part.content == "What is the stopping rule?"

        assistant_part = restored[2].parts[0]
        assert isinstance(assistant_part, TextPart)
        assert assistant_part.content == "Pause enrollment at >15% SAE rate."

    def test_empty_round_trips_to_empty(self):
        assert serialise_messages([]) == []
        assert deserialise_messages([]) == []
        assert deserialise_messages(None) == []


# ---------------------------------------------------------------------------
# chat() threads message_history through to the model
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chat_threads_history_through_provider(azure_provider):
    """The ``message_history`` kwarg must reach the underlying Agent.run."""
    capture = _Capture(response="follow-up reply")
    fn_model = capture.as_model()

    # Simulate a persisted 2-message history (one prior user turn + reply).
    persisted: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content="Earlier user turn")]),
        ModelResponse(parts=[TextPart(content="Earlier assistant reply")]),
    ]

    new_messages = [
        {"role": "system", "content": "Sys"},
        {"role": "user", "content": "Latest user turn"},
    ]

    agent = azure_provider._agents.get(LLMTier.AGENT_CHAT)
    with agent.override(model=fn_model):
        text = await azure_provider.chat(
            new_messages, LLMTier.AGENT_CHAT, message_history=persisted
        )

    assert text == "follow-up reply"
    assert len(capture.calls) == 1
    captured, _info = capture.calls[0]

    # Earlier turns from the persisted history must appear BEFORE the new turn.
    user_texts = []
    for m in captured:
        if isinstance(m, ModelRequest):
            for part in m.parts:
                if isinstance(part, UserPromptPart):
                    user_texts.append(part.content)
    assert user_texts[0] == "Earlier user turn"
    assert user_texts[-1] == "Latest user turn"

    # Assistant text from the persisted history must also be in the captured
    # sequence — proving the agent saw the prior response.
    assistant_texts = []
    for m in captured:
        if isinstance(m, ModelResponse):
            for part in m.parts:
                if isinstance(part, TextPart):
                    assistant_texts.append(part.content)
    assert "Earlier assistant reply" in assistant_texts


@pytest.mark.asyncio
async def test_chat_works_without_message_history(azure_provider):
    """Default behaviour (no message_history kwarg) is unchanged."""
    capture = _Capture(response="ok")
    fn_model = capture.as_model()
    agent = azure_provider._agents.get(LLMTier.AGENT_CHAT)

    with agent.override(model=fn_model):
        text = await azure_provider.chat(
            [{"role": "user", "content": "hi"}], LLMTier.AGENT_CHAT
        )

    assert text == "ok"
    assert len(capture.calls) == 1


# ---------------------------------------------------------------------------
# chat_with_history returns the new-message delta only
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chat_returns_new_messages_only(azure_provider):
    """``chat_with_history`` returns ONLY the delta produced by this run.

    Persisting the full conversation on every turn would double-write history
    and balloon the JSONB column.  The delta is the contract: the conversation
    store appends it to whatever was already stored.
    """
    capture = _Capture(response="delta reply")
    fn_model = capture.as_model()

    persisted: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content="Way back when")]),
        ModelResponse(parts=[TextPart(content="An ancient response")]),
    ]

    new_messages = [
        {"role": "user", "content": "Fresh prompt"},
    ]

    agent = azure_provider._agents.get(LLMTier.AGENT_CHAT)
    with agent.override(model=fn_model):
        result = await azure_provider.chat_with_history(
            new_messages, LLMTier.AGENT_CHAT, message_history=persisted
        )

    assert isinstance(result, ChatResult)
    assert result.text == "delta reply"
    # The delta should contain JUST the new turn's request + response —
    # NOT the persisted history.  Pydantic AI's new_messages() returns the
    # turn's contribution: a ModelRequest for the user input and a
    # ModelResponse for the assistant output, plus optionally tool calls.
    assert len(result.new_messages) >= 1

    # Crucially, the prior "Way back when" / "An ancient response" content
    # MUST NOT appear in the delta — otherwise persistence would duplicate it.
    serialised = serialise_messages(result.new_messages)
    flat = str(serialised)
    assert "Way back when" not in flat
    assert "An ancient response" not in flat
    # The current run's output IS in the delta.
    assert "delta reply" in flat or "Fresh prompt" in flat


# ---------------------------------------------------------------------------
# OpenAI provider has the same wiring
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_openai_provider_also_threads_history(openai_provider):
    capture = _Capture(response="openai reply")
    fn_model = capture.as_model()

    persisted: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content="Hello from yesterday")]),
        ModelResponse(parts=[TextPart(content="Yesterday's reply")]),
    ]

    agent = openai_provider._agents.get(LLMTier.AGENT_CHAT)
    with agent.override(model=fn_model):
        result = await openai_provider.chat_with_history(
            [{"role": "user", "content": "Today's turn"}],
            LLMTier.AGENT_CHAT,
            message_history=persisted,
        )

    assert isinstance(result, ChatResult)
    captured, _ = capture.calls[0]
    user_texts = [
        part.content
        for m in captured if isinstance(m, ModelRequest)
        for part in m.parts if isinstance(part, UserPromptPart)
    ]
    assert "Hello from yesterday" in user_texts
    assert "Today's turn" in user_texts


# ---------------------------------------------------------------------------
# Mock provider records message_history for offline test assertions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mock_provider_records_message_history_len():
    """MockLLMProvider records message_history_len on the call log so tests
    can assert that history was threaded without standing up a real Agent.
    """
    provider = MockLLMProvider()
    persisted = ["msg1", "msg2", "msg3"]  # opaque to the mock — just counted

    await provider.chat(
        [{"role": "user", "content": "Hi"}],
        LLMTier.AGENT_CHAT,
        message_history=persisted,
    )

    assert provider.call_log[-1]["message_history_len"] == 3


@pytest.mark.asyncio
async def test_mock_chat_with_history_returns_chat_result():
    """Mock's ``chat_with_history`` returns a ChatResult with empty delta."""
    provider = MockLLMProvider()
    result = await provider.chat_with_history(
        [{"role": "user", "content": "Hi"}],
        LLMTier.AGENT_CHAT,
    )
    assert isinstance(result, ChatResult)
    assert isinstance(result.text, str) and len(result.text) > 0
    # Mock provider doesn't simulate Pydantic AI message production —
    # the delta is empty, which is the documented contract.
    assert result.new_messages == []
