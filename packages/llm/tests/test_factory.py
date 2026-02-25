"""Tests for the provider factory."""

import pytest

from quorum_llm.factory import get_llm_provider


def test_unknown_provider():
    with pytest.raises(ValueError, match="Unknown LLM provider"):
        get_llm_provider("nonexistent")


def test_azure_provider_requires_env(monkeypatch):
    """Azure provider should fail without env vars."""
    monkeypatch.delenv("AZURE_OPENAI_ENDPOINT", raising=False)
    monkeypatch.delenv("AZURE_OPENAI_KEY", raising=False)
    with pytest.raises(KeyError):
        get_llm_provider("azure")


def test_anthropic_provider_requires_env(monkeypatch):
    """Anthropic provider should fail without API key."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(KeyError):
        get_llm_provider("anthropic")


def test_azure_provider_with_explicit_args():
    """Azure provider should accept explicit constructor args."""
    provider = get_llm_provider(
        "azure",
        endpoint="https://test.openai.azure.com/",
        api_key="test-key",
        deployment_t2="gpt-4o-mini",
        deployment_t3="gpt-4o",
    )
    assert provider is not None


def test_anthropic_provider_with_explicit_args():
    """Anthropic provider should accept explicit API key."""
    provider = get_llm_provider("anthropic", api_key="test-key")
    assert provider is not None
