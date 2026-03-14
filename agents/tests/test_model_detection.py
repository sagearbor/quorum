"""Tests for model auto-detection in agent_engine._call_llm.

Verifies:
- gpt-5-* models route to respond() (Responses API)
- gpt-4-* models route to chat()
- Fallback to complete() when chat() is unavailable
- Graceful degradation: respond() failure falls back to chat()
- _is_gpt5_model() helper correctness
"""

from __future__ import annotations

import sys
import types
from unittest.mock import AsyncMock, MagicMock

import pytest


# ---------------------------------------------------------------------------
# Minimal quorum_llm stub — agent_engine imports from this package.
# The stub replicates the tier enum values we need without requiring the
# full package to be installed in the test environment.
# ---------------------------------------------------------------------------


def _install_quorum_llm_stub() -> None:
    """Install a minimal quorum_llm stub so agent_engine can be imported."""
    if "quorum_llm" in sys.modules:
        return

    pkg = types.ModuleType("quorum_llm")

    from enum import IntEnum

    class LLMTier(IntEnum):
        KEYWORD = 1
        CONFLICT = 2
        AGENT_CHAT = 21
        AGENT_RESPOND = 22
        SYNTHESIS = 3
        AGENT_REASON = 31

    pkg.LLMTier = LLMTier
    sys.modules["quorum_llm"] = pkg

    models_stub = types.ModuleType("quorum_llm.models")
    models_stub.LLMTier = LLMTier
    sys.modules["quorum_llm.models"] = models_stub

    for sub in ("interface", "factory", "tier1", "providers.mock"):
        full = f"quorum_llm.{sub}"
        if full not in sys.modules:
            stub = types.ModuleType(full)
            if sub == "tier1":
                stub.extract_keywords = lambda t, **kw: t.lower().split()[:5]
            sys.modules[full] = stub

    providers_pkg = types.ModuleType("quorum_llm.providers")
    sys.modules["quorum_llm.providers"] = providers_pkg


_install_quorum_llm_stub()


# Also install the agents package stub so agent_engine doesn't fail on
# `from agents import load_agent`.
def _install_agents_stub() -> None:
    if "agents" in sys.modules:
        return
    stub = types.ModuleType("agents")

    class FakeAgent:
        def __init__(self, model="gpt-4o-mini", domain_tags=None, name="Fake"):
            self.model = model
            self.domain_tags = domain_tags or []
            self.name = name
            self.instructions = "You are a test agent."

    def load_agent(slug):
        raise FileNotFoundError(f"No agent: {slug}")

    stub.load_agent = load_agent
    stub.FakeAgent = FakeAgent
    sys.modules["agents"] = stub


_install_agents_stub()


# ---------------------------------------------------------------------------
# Import the module under test (after stubs are in place)
# ---------------------------------------------------------------------------


from apps.api.agent_engine import _call_llm, _is_gpt5_model  # noqa: E402


# ---------------------------------------------------------------------------
# Unit tests: _is_gpt5_model()
# ---------------------------------------------------------------------------


class TestIsGpt5Model:
    def test_gpt5_nano(self):
        assert _is_gpt5_model("gpt-5-nano") is True

    def test_gpt5_turbo(self):
        assert _is_gpt5_model("gpt-5-turbo") is True

    def test_gpt5_generic(self):
        assert _is_gpt5_model("gpt-5") is True

    def test_gpt4o_not_gpt5(self):
        assert _is_gpt5_model("gpt-4o") is False

    def test_gpt4o_mini_not_gpt5(self):
        assert _is_gpt5_model("gpt-4o-mini") is False

    def test_gpt4_not_gpt5(self):
        assert _is_gpt5_model("gpt-4") is False

    def test_empty_string(self):
        assert _is_gpt5_model("") is False

    def test_prefix_only_match(self):
        # Should only match at string start — "notgpt-5-nano" should NOT match
        assert _is_gpt5_model("notgpt-5-nano") is False


# ---------------------------------------------------------------------------
# Integration tests: _call_llm() routing
# ---------------------------------------------------------------------------


def _make_gpt5_agent_def():
    """Create a minimal agent definition with gpt-5-nano model."""
    agent = MagicMock()
    agent.model = "gpt-5-nano"
    agent.name = "GPT-5 Test Agent"
    return agent


def _make_gpt4_agent_def():
    """Create a minimal agent definition with gpt-4o-mini model."""
    agent = MagicMock()
    agent.model = "gpt-4o-mini"
    agent.name = "GPT-4 Test Agent"
    return agent


def _make_messages():
    """Standard message list for testing."""
    return [
        {"role": "system", "content": "You are an IRB officer."},
        {"role": "user", "content": "Confirm the eGFR threshold."},
    ]


@pytest.mark.asyncio
async def test_gpt5_agent_routes_to_respond():
    """When agent.model starts with 'gpt-5', _call_llm should call respond()."""
    provider = MagicMock()
    provider.respond = AsyncMock(return_value=("gpt5 response", "resp_abc"))
    provider.chat = AsyncMock(return_value="chat response")

    result = await _call_llm(provider, _make_messages(), agent_def=_make_gpt5_agent_def())

    assert result == "gpt5 response"
    provider.respond.assert_called_once()
    provider.chat.assert_not_called()


@pytest.mark.asyncio
async def test_gpt5_respond_receives_correct_args():
    """respond() should be called with extracted instructions and input_text."""
    provider = MagicMock()
    provider.respond = AsyncMock(return_value=("response", "resp_id"))

    messages = [
        {"role": "system", "content": "System instructions here."},
        {"role": "user", "content": "Context block"},
        {"role": "assistant", "content": "Prior reply"},
        {"role": "user", "content": "Latest user message"},
    ]

    await _call_llm(provider, messages, agent_def=_make_gpt5_agent_def())

    call_kwargs = provider.respond.call_args
    # instructions should be extracted from the system message
    assert call_kwargs.kwargs["instructions"] == "System instructions here."
    # input_text should be the LAST user message
    assert call_kwargs.kwargs["input_text"] == "Latest user message"


@pytest.mark.asyncio
async def test_gpt4_agent_routes_to_chat():
    """When agent.model is gpt-4o-mini, _call_llm should call chat(), not respond()."""
    provider = MagicMock()
    provider.respond = AsyncMock(return_value=("respond response", "resp_id"))
    provider.chat = AsyncMock(return_value="chat response")

    result = await _call_llm(provider, _make_messages(), agent_def=_make_gpt4_agent_def())

    assert result == "chat response"
    provider.chat.assert_called_once()
    provider.respond.assert_not_called()


@pytest.mark.asyncio
async def test_no_agent_def_routes_to_chat():
    """Without an agent_def, _call_llm should fall through to chat()."""
    provider = MagicMock()
    provider.respond = AsyncMock(return_value=("respond response", "resp_id"))
    provider.chat = AsyncMock(return_value="chat response")

    result = await _call_llm(provider, _make_messages(), agent_def=None)

    assert result == "chat response"
    provider.chat.assert_called_once()
    provider.respond.assert_not_called()


@pytest.mark.asyncio
async def test_gpt5_respond_failure_falls_back_to_chat():
    """If respond() raises, _call_llm should fall back to chat() gracefully."""
    provider = MagicMock()
    provider.respond = AsyncMock(side_effect=RuntimeError("Responses API unavailable"))
    provider.chat = AsyncMock(return_value="chat fallback")

    result = await _call_llm(provider, _make_messages(), agent_def=_make_gpt5_agent_def())

    assert result == "chat fallback"
    provider.respond.assert_called_once()
    provider.chat.assert_called_once()


@pytest.mark.asyncio
async def test_no_respond_attribute_routes_to_chat():
    """If provider has no respond() attribute, _call_llm should use chat()."""
    provider = MagicMock(spec=["chat"])  # spec excludes respond
    provider.chat = AsyncMock(return_value="chat only")

    result = await _call_llm(provider, _make_messages(), agent_def=_make_gpt5_agent_def())

    assert result == "chat only"
    provider.chat.assert_called_once()


@pytest.mark.asyncio
async def test_no_chat_attribute_falls_back_to_complete():
    """If provider has neither respond() nor chat(), _call_llm uses complete()."""
    provider = MagicMock(spec=["complete"])  # spec excludes both chat and respond
    provider.complete = AsyncMock(return_value="complete fallback")

    result = await _call_llm(provider, _make_messages(), agent_def=_make_gpt4_agent_def())

    assert result == "complete fallback"
    provider.complete.assert_called_once()


@pytest.mark.asyncio
async def test_gpt5_respond_called_with_agent_respond_tier():
    """respond() must be called with LLMTier.AGENT_RESPOND (22), not AGENT_CHAT."""
    from quorum_llm.models import LLMTier

    provider = MagicMock()
    provider.respond = AsyncMock(return_value=("ok", "resp_id"))

    await _call_llm(provider, _make_messages(), agent_def=_make_gpt5_agent_def())

    call_kwargs = provider.respond.call_args
    assert call_kwargs.kwargs["tier"] == LLMTier.AGENT_RESPOND
