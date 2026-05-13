"""Pydantic AI swap — parity tests for checklist item 9.1.

These tests verify that the four cloud LLM provider adapters
(``azure``, ``openai``, ``anthropic``, ``local``) route through Pydantic AI
correctly without making real network calls.  We do that by overriding the
Agent inside each provider with a ``FunctionModel`` / ``TestModel`` from the
``pydantic_ai.models.test``/``function`` modules, then asserting on the
``ModelMessage`` sequence the SDK hands to the underlying model.

Scope covered:
- ``complete(prompt, tier)`` routes through the Agent and returns text.
- ``chat(messages, tier)`` flows system → instructions and the trailing
  user message → user_prompt, with prior turns becoming message_history.
- ``respond(instructions, input_text, tier)`` returns a ``(text, id|None)``
  tuple matching the legacy contract.
- ``ModelSettings.temperature`` / ``ModelSettings.max_tokens`` propagate
  from the caller through Pydantic AI to the model.
- ``QUORUM_TEST_MODE=true`` bypasses every cloud adapter and yields
  ``MockLLMProvider`` regardless of the requested provider name.

We do NOT cover live API calls — those are out of scope for unit tests and
gated behind the existing manual integration tests.
"""

from __future__ import annotations

from typing import Any

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

from quorum_llm.factory import get_llm_provider
from quorum_llm.models import LLMTier
from quorum_llm.providers._pai_common import (
    split_history_and_prompt,
    tier_settings,
    to_pai_messages,
)
from quorum_llm.providers.anthropic import AnthropicProvider
from quorum_llm.providers.azure import AzureOpenAIProvider
from quorum_llm.providers.local import LocalOllamaProvider
from quorum_llm.providers.openai import OpenAIProvider

# Belt-and-braces: block any accidental real model request from a test.
pai_models.ALLOW_MODEL_REQUESTS = False


# ---------------------------------------------------------------------------
# FunctionModel helpers
# ---------------------------------------------------------------------------


class CapturingFunctionModel:
    """Wraps a ``FunctionModel`` and records every call made to it.

    Each call captures:
    - ``messages``: the full ``list[ModelMessage]`` the Agent assembled.
    - ``info``: the ``AgentInfo`` (instructions, model_settings, etc.).

    The model itself responds with a configurable canned text.
    """

    def __init__(self, response: str = "ok"):
        self.calls: list[tuple[list[ModelMessage], AgentInfo]] = []
        self._response = response

    def as_function_model(self) -> FunctionModel:
        async def _fn(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            self.calls.append((messages, info))
            return ModelResponse(parts=[TextPart(content=self._response)])

        return FunctionModel(_fn)


def _last_user_text(messages: list[ModelMessage]) -> str:
    """Extract the last user prompt text from a captured message list."""
    for msg in reversed(messages):
        if isinstance(msg, ModelRequest):
            for part in msg.parts:
                if isinstance(part, UserPromptPart):
                    content = part.content
                    return content if isinstance(content, str) else str(content)
    return ""


def _collected_system_text(messages: list[ModelMessage]) -> str:
    """Collect every SystemPromptPart content into a single string."""
    chunks: list[str] = []
    for msg in messages:
        if isinstance(msg, ModelRequest):
            for part in msg.parts:
                if isinstance(part, SystemPromptPart):
                    chunks.append(part.content)
    return "\n\n".join(chunks)


def _collected_instructions(info: AgentInfo) -> str:
    """Read instructions off an AgentInfo, handling None gracefully."""
    return info.instructions or ""


# ---------------------------------------------------------------------------
# Provider fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def azure_provider(monkeypatch) -> AzureOpenAIProvider:
    """Build an Azure provider without touching real env / network."""
    monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
    return AzureOpenAIProvider(
        endpoint="https://fake-resource.openai.azure.com/",
        api_key="fake-key",
        deployment_t2="gpt-4o-mini",
        deployment_t3="gpt-4o",
        deployment_t5="gpt-4o-mini",  # avoid reasoning-route to keep test deterministic
    )


@pytest.fixture
def openai_provider(monkeypatch) -> OpenAIProvider:
    monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
    return OpenAIProvider(
        api_key="fake-key",
        model_t2="gpt-4o-mini",
        model_t3="gpt-4o",
    )


@pytest.fixture
def anthropic_provider(monkeypatch) -> AnthropicProvider:
    monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
    return AnthropicProvider(
        api_key="fake-key",
        model_t2="claude-haiku-4-5-20251001",
        model_t3="claude-sonnet-4-6",
    )


@pytest.fixture
def local_provider(monkeypatch) -> LocalOllamaProvider:
    monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
    return LocalOllamaProvider(base_url="http://localhost:11434", model="llama3.3")


# Parametrise the four cloud providers so the same parity test runs against
# each.  The fixture name resolution is handled via ``request.getfixturevalue``.
_CLOUD_PROVIDERS = ["azure_provider", "openai_provider", "anthropic_provider", "local_provider"]


def _override_agent(provider, tier: LLMTier, fn_model: FunctionModel):
    """Force a provider's per-tier Agent to use the given FunctionModel.

    Uses ``Agent.override(model=...)`` as a context-manager; we enter and
    return it so the caller can use it in their own ``with`` block.
    """
    agent = provider._agents.get(tier)
    return agent.override(model=fn_model)


# ---------------------------------------------------------------------------
# Helper-module unit tests (no Agent involved)
# ---------------------------------------------------------------------------


class TestSplitHistoryAndPrompt:
    """Verify the dict-messages → (instructions, history, user_prompt) split."""

    def test_extracts_system_into_instructions(self):
        messages = [
            {"role": "system", "content": "You are an IRB officer."},
            {"role": "user", "content": "Confirm the eGFR threshold."},
        ]
        instructions, history, prompt = split_history_and_prompt(messages)
        assert instructions == "You are an IRB officer."
        assert history == []
        assert prompt == "Confirm the eGFR threshold."

    def test_combines_multiple_system_messages(self):
        messages = [
            {"role": "system", "content": "Be helpful."},
            {"role": "system", "content": "Always cite sources."},
            {"role": "user", "content": "Hi"},
        ]
        instructions, _, _ = split_history_and_prompt(messages)
        assert instructions is not None
        assert "Be helpful." in instructions
        assert "Always cite sources." in instructions

    def test_prior_turns_become_history(self):
        messages = [
            {"role": "system", "content": "Sys"},
            {"role": "user", "content": "First user"},
            {"role": "assistant", "content": "First reply"},
            {"role": "user", "content": "Second user"},
        ]
        instructions, history, prompt = split_history_and_prompt(messages)
        assert instructions == "Sys"
        assert prompt == "Second user"
        # History has the first user + first assistant
        assert len(history) == 2
        assert isinstance(history[0], ModelRequest)
        assert isinstance(history[1], ModelResponse)

    def test_no_trailing_user_message(self):
        # Caller sends only system + assistant — user_prompt becomes empty.
        messages = [
            {"role": "system", "content": "Sys"},
            {"role": "assistant", "content": "I had the last word."},
        ]
        _, history, prompt = split_history_and_prompt(messages)
        assert prompt == ""
        assert len(history) == 1

    def test_empty_messages(self):
        instructions, history, prompt = split_history_and_prompt([])
        assert instructions is None
        assert history == []
        assert prompt == ""


class TestToPaiMessages:
    """Verify role → Pydantic AI message-class mapping."""

    def test_system_becomes_system_prompt_part(self):
        result = to_pai_messages([{"role": "system", "content": "S"}])
        assert isinstance(result[0], ModelRequest)
        assert isinstance(result[0].parts[0], SystemPromptPart)

    def test_user_becomes_user_prompt_part(self):
        result = to_pai_messages([{"role": "user", "content": "U"}])
        assert isinstance(result[0], ModelRequest)
        assert isinstance(result[0].parts[0], UserPromptPart)

    def test_assistant_becomes_text_part_response(self):
        result = to_pai_messages([{"role": "assistant", "content": "A"}])
        assert isinstance(result[0], ModelResponse)
        assert isinstance(result[0].parts[0], TextPart)

    def test_unknown_role_falls_back_to_user(self):
        result = to_pai_messages([{"role": "tool", "content": "T"}])
        assert isinstance(result[0], ModelRequest)
        assert isinstance(result[0].parts[0], UserPromptPart)


class TestTierSettings:
    """Verify ModelSettings carry through the tier defaults / overrides."""

    def test_conflict_tier_defaults(self):
        s = tier_settings(LLMTier.CONFLICT)
        assert s["temperature"] == pytest.approx(0.3)
        assert s["max_tokens"] == 2048

    def test_synthesis_tier_defaults(self):
        s = tier_settings(LLMTier.SYNTHESIS)
        assert s["temperature"] == pytest.approx(0.7)
        assert s["max_tokens"] == 4096

    def test_override_temperature(self):
        s = tier_settings(LLMTier.AGENT_CHAT, temperature=0.95)
        assert s["temperature"] == pytest.approx(0.95)

    def test_override_max_tokens(self):
        s = tier_settings(LLMTier.AGENT_CHAT, max_tokens=512)
        assert s["max_tokens"] == 512


# ---------------------------------------------------------------------------
# QUORUM_TEST_MODE bypass — does not depend on real adapters at all
# ---------------------------------------------------------------------------


def test_test_mode_yields_mock_provider(monkeypatch):
    """When QUORUM_TEST_MODE=true, the factory always returns MockLLMProvider."""
    from quorum_llm.providers.mock import MockLLMProvider

    monkeypatch.setenv("QUORUM_TEST_MODE", "true")
    for name in ("azure", "openai", "anthropic", "local"):
        provider = get_llm_provider(name)
        assert isinstance(provider, MockLLMProvider), (
            f"QUORUM_TEST_MODE bypass should yield MockLLMProvider for {name!r}"
        )


# ---------------------------------------------------------------------------
# Per-provider routing tests — use FunctionModel override
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("provider_fixture", _CLOUD_PROVIDERS)
@pytest.mark.asyncio
async def test_complete_routes_through_pydantic_ai(request, provider_fixture):
    """`complete()` must call the underlying Agent and return its text."""
    provider = request.getfixturevalue(provider_fixture)
    capture = CapturingFunctionModel(response="completed text")
    fn_model = capture.as_function_model()

    with _override_agent(provider, LLMTier.CONFLICT, fn_model):
        result = await provider.complete("Detect any conflict.", LLMTier.CONFLICT)

    assert result == "completed text"
    assert len(capture.calls) == 1
    messages, info = capture.calls[0]
    # The prompt should be on the model under either system_prompt or user_prompt
    assert _last_user_text(messages) == "Detect any conflict."


@pytest.mark.parametrize("provider_fixture", _CLOUD_PROVIDERS)
@pytest.mark.asyncio
async def test_chat_splits_system_into_instructions(request, provider_fixture):
    """`chat()` must thread system messages into Pydantic AI's instructions."""
    provider = request.getfixturevalue(provider_fixture)
    capture = CapturingFunctionModel(response="chat reply")
    fn_model = capture.as_function_model()

    messages = [
        {"role": "system", "content": "You are a safety monitor."},
        {"role": "user", "content": "What are the stopping rules?"},
    ]

    with _override_agent(provider, LLMTier.AGENT_CHAT, fn_model):
        result = await provider.chat(messages, LLMTier.AGENT_CHAT)

    assert result == "chat reply"
    assert len(capture.calls) == 1
    captured_messages, info = capture.calls[0]

    # The user message should be the last UserPromptPart.
    assert _last_user_text(captured_messages) == "What are the stopping rules?"

    # The system content should appear EITHER in info.instructions OR as a
    # SystemPromptPart on the first ModelRequest — both are valid Pydantic AI
    # representations and the SDK version may render it either way.
    combined = (
        _collected_instructions(info)
        + "\n"
        + _collected_system_text(captured_messages)
    )
    assert "You are a safety monitor." in combined


@pytest.mark.parametrize("provider_fixture", _CLOUD_PROVIDERS)
@pytest.mark.asyncio
async def test_chat_preserves_prior_turns_as_history(request, provider_fixture):
    """Prior user/assistant turns must appear in the Agent's message_history."""
    provider = request.getfixturevalue(provider_fixture)
    capture = CapturingFunctionModel(response="ack")
    fn_model = capture.as_function_model()

    messages = [
        {"role": "system", "content": "Sys"},
        {"role": "user", "content": "Earlier question"},
        {"role": "assistant", "content": "Earlier reply"},
        {"role": "user", "content": "Latest question"},
    ]

    with _override_agent(provider, LLMTier.AGENT_CHAT, fn_model):
        await provider.chat(messages, LLMTier.AGENT_CHAT)

    captured_messages, _ = capture.calls[0]
    # The captured messages should include the prior turns in order.
    user_contents = []
    for m in captured_messages:
        if isinstance(m, ModelRequest):
            for part in m.parts:
                if isinstance(part, UserPromptPart):
                    user_contents.append(part.content)
    assert user_contents[0] == "Earlier question"
    assert user_contents[-1] == "Latest question"

    # The assistant turn should be a ModelResponse with the canned text.
    assistant_contents = []
    for m in captured_messages:
        if isinstance(m, ModelResponse):
            for part in m.parts:
                if isinstance(part, TextPart):
                    assistant_contents.append(part.content)
    assert "Earlier reply" in assistant_contents


@pytest.mark.parametrize("provider_fixture", _CLOUD_PROVIDERS)
@pytest.mark.asyncio
async def test_respond_returns_tuple(request, provider_fixture):
    """`respond()` must return a (text, response_id|None) tuple."""
    provider = request.getfixturevalue(provider_fixture)
    capture = CapturingFunctionModel(response="responded")
    fn_model = capture.as_function_model()

    with _override_agent(provider, LLMTier.AGENT_RESPOND, fn_model):
        result = await provider.respond(
            instructions="System instructions",
            input_text="User input",
            tier=LLMTier.AGENT_RESPOND,
        )

    assert isinstance(result, tuple)
    assert len(result) == 2
    text, response_id = result
    assert text == "responded"
    # response_id is None for non-reasoning routes; sentinel for reasoning.
    assert response_id is None or isinstance(response_id, str)


@pytest.mark.parametrize("provider_fixture", _CLOUD_PROVIDERS)
@pytest.mark.asyncio
async def test_model_settings_propagate(request, provider_fixture):
    """ModelSettings overrides set on chat() must reach the AgentInfo."""
    provider = request.getfixturevalue(provider_fixture)
    capture = CapturingFunctionModel(response="ok")
    fn_model = capture.as_function_model()

    messages = [
        {"role": "system", "content": "Sys"},
        {"role": "user", "content": "Question"},
    ]

    with _override_agent(provider, LLMTier.AGENT_CHAT, fn_model):
        await provider.chat(
            messages,
            LLMTier.AGENT_CHAT,
            temperature=0.91,
            max_tokens=777,
        )

    _, info = capture.calls[0]
    settings: Any = info.model_settings or {}
    # ModelSettings is a TypedDict-like — temperature and max_tokens must be there
    assert settings.get("temperature") == pytest.approx(0.91)
    assert settings.get("max_tokens") == 777


@pytest.mark.parametrize("provider_fixture", _CLOUD_PROVIDERS)
@pytest.mark.asyncio
async def test_keyword_tier_skips_pydantic_ai(request, provider_fixture):
    """KEYWORD tier is handled by tier1, must not invoke the Agent at all."""
    provider = request.getfixturevalue(provider_fixture)
    capture = CapturingFunctionModel(response="should not be called")
    fn_model = capture.as_function_model()

    # Note: we override AGENT_CHAT tier so an accidental Agent.run() would still
    # blow up via ALLOW_MODEL_REQUESTS=False before reaching the FunctionModel.
    with _override_agent(provider, LLMTier.AGENT_CHAT, fn_model):
        result = await provider.complete("budget enrollment dosing", LLMTier.KEYWORD)

    # Must return the deterministic keywords (non-empty string).
    assert isinstance(result, str)
    assert len(result) > 0
    # The Agent must not have been called.
    assert len(capture.calls) == 0
