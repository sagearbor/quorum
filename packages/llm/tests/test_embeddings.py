"""Embedding-provider tests — checklist item 11.4 / audit finding C4.

Pre-merge audit identified two bugs in the embedding providers:

1.  ``AnthropicProvider.embed()`` returned a 256-dim hash-bucket fake vector
    that quietly satisfied downstream cosine similarity, silently breaking
    agent affinity routing.  Fix: raise ``NotImplementedError`` so callers
    fail fast.

2.  ``AzureOpenAIProvider.embed()`` routed to the T2 *chat* deployment, which
    Azure does not serve embeddings from.  Fix: read a dedicated deployment
    from ``AZURE_OPENAI_EMBEDDING_DEPLOYMENT`` (or constructor arg) and raise
    ``ValueError`` when unset rather than silently degrading.

These tests cover the new contract end-to-end with mocked SDK clients so the
suite never hits the network.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from quorum_llm.providers.anthropic import AnthropicProvider
from quorum_llm.providers.azure import AzureOpenAIProvider
from quorum_llm.providers.mock import MockLLMProvider
from quorum_llm.providers.openai import OpenAIProvider


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fake_embedding_response(dim: int = 1536) -> SimpleNamespace:
    """Build a stand-in for ``openai.types.CreateEmbeddingResponse``.

    The SDK call site only touches ``response.data[0].embedding`` — using a
    SimpleNamespace keeps the test free of pydantic-model wiring.
    """
    return SimpleNamespace(data=[SimpleNamespace(embedding=[0.01] * dim)])


# ---------------------------------------------------------------------------
# Azure
# ---------------------------------------------------------------------------


class TestAzureEmbed:
    @pytest.mark.asyncio
    async def test_azure_embed_uses_dedicated_deployment(self, monkeypatch):
        """``embed()`` must route to the embedding deployment, NOT T2."""
        monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
        monkeypatch.setenv(
            "AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-3-small"
        )

        provider = AzureOpenAIProvider(
            endpoint="https://fake-resource.openai.azure.com/",
            api_key="fake-key",
            deployment_t2="gpt-4o-mini",
            deployment_t3="gpt-4o",
            deployment_t5="gpt-4o-mini",
        )

        # Replace the underlying AsyncAzureOpenAI client's embeddings.create
        # with an AsyncMock so we can assert the deployment name.
        fake_create = AsyncMock(return_value=_fake_embedding_response(1536))
        provider._client.embeddings = MagicMock()
        provider._client.embeddings.create = fake_create

        vec = await provider.embed("hello world")

        # Returned vector matches the mocked SDK payload shape.
        assert isinstance(vec, list)
        assert len(vec) == 1536

        # The SDK was called against the embedding deployment, NOT the chat
        # deployment.  This is the regression guard for C4 / 11.4.
        fake_create.assert_awaited_once()
        kwargs = fake_create.await_args.kwargs
        assert kwargs["model"] == "text-embedding-3-small"
        assert kwargs["model"] != "gpt-4o-mini"  # explicit: NOT the chat deployment

    @pytest.mark.asyncio
    async def test_azure_embed_uses_constructor_arg_over_env(self, monkeypatch):
        """Constructor ``deployment_embed`` wins over the env var."""
        monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
        monkeypatch.setenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "from-env")

        provider = AzureOpenAIProvider(
            endpoint="https://fake-resource.openai.azure.com/",
            api_key="fake-key",
            deployment_t2="gpt-4o-mini",
            deployment_t3="gpt-4o",
            deployment_embed="from-ctor",
        )
        fake_create = AsyncMock(return_value=_fake_embedding_response(1536))
        provider._client.embeddings = MagicMock()
        provider._client.embeddings.create = fake_create

        await provider.embed("text")

        assert fake_create.await_args.kwargs["model"] == "from-ctor"

    @pytest.mark.asyncio
    async def test_azure_embed_raises_without_deployment_env(self, monkeypatch):
        """No env var, no constructor arg → ValueError (not silent degrade)."""
        monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
        monkeypatch.delenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", raising=False)

        provider = AzureOpenAIProvider(
            endpoint="https://fake-resource.openai.azure.com/",
            api_key="fake-key",
            deployment_t2="gpt-4o-mini",
            deployment_t3="gpt-4o",
        )

        with pytest.raises(ValueError, match="AZURE_OPENAI_EMBEDDING_DEPLOYMENT"):
            await provider.embed("anything")


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------


class TestAnthropicEmbed:
    @pytest.mark.asyncio
    async def test_anthropic_embed_raises_not_implemented(self, monkeypatch):
        """Anthropic has no embedding API — must raise, never return a vector."""
        monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
        provider = AnthropicProvider(
            api_key="fake-key",
            model_t2="claude-haiku-4-5-20251001",
            model_t3="claude-sonnet-4-6",
        )

        with pytest.raises(NotImplementedError, match="no native embedding API"):
            await provider.embed("this would have returned a fake vector before")

    @pytest.mark.asyncio
    async def test_anthropic_embed_does_not_return_hash_vector(self, monkeypatch):
        """Belt-and-braces: confirm the legacy 256-dim fake-vector path is gone.

        If someone reintroduces a silent fallback that returns a list, this
        test fails because the assertion path is structured around the
        exception, not a return value.
        """
        monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
        provider = AnthropicProvider(
            api_key="fake-key",
            model_t2="claude-haiku-4-5-20251001",
            model_t3="claude-sonnet-4-6",
        )
        try:
            await provider.embed("text")
        except NotImplementedError:
            return  # expected path
        else:  # pragma: no cover - defensive
            pytest.fail("Anthropic.embed() must NOT return a vector silently")


# ---------------------------------------------------------------------------
# OpenAI
# ---------------------------------------------------------------------------


class TestOpenAIEmbed:
    @pytest.mark.asyncio
    async def test_openai_embed_basic(self, monkeypatch):
        """Happy path — uses default embedding model and returns the SDK vector."""
        monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
        monkeypatch.delenv("OPENAI_EMBEDDING_MODEL", raising=False)

        provider = OpenAIProvider(
            api_key="fake-key",
            model_t2="gpt-4o-mini",
            model_t3="gpt-4o",
        )
        fake_create = AsyncMock(return_value=_fake_embedding_response(1536))
        provider._client.embeddings = MagicMock()
        provider._client.embeddings.create = fake_create

        vec = await provider.embed("hello")

        assert isinstance(vec, list)
        assert len(vec) == 1536
        kwargs = fake_create.await_args.kwargs
        # Default embedding model
        assert kwargs["model"] == "text-embedding-3-small"
        assert kwargs["input"] == "hello"

    @pytest.mark.asyncio
    async def test_openai_embed_respects_env_override(self, monkeypatch):
        """``OPENAI_EMBEDDING_MODEL`` overrides the default."""
        monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
        monkeypatch.setenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-large")

        provider = OpenAIProvider(api_key="fake-key")
        fake_create = AsyncMock(return_value=_fake_embedding_response(3072))
        provider._client.embeddings = MagicMock()
        provider._client.embeddings.create = fake_create

        vec = await provider.embed("hello")

        assert len(vec) == 3072
        assert fake_create.await_args.kwargs["model"] == "text-embedding-3-large"

    @pytest.mark.asyncio
    async def test_openai_embed_respects_constructor_arg(self, monkeypatch):
        """Constructor argument wins over env var."""
        monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
        monkeypatch.setenv("OPENAI_EMBEDDING_MODEL", "from-env")

        provider = OpenAIProvider(api_key="fake-key", embedding_model="from-ctor")
        fake_create = AsyncMock(return_value=_fake_embedding_response(1536))
        provider._client.embeddings = MagicMock()
        provider._client.embeddings.create = fake_create

        await provider.embed("hello")

        assert fake_create.await_args.kwargs["model"] == "from-ctor"


# ---------------------------------------------------------------------------
# Mock provider — deterministic vector (already correct, regression guard)
# ---------------------------------------------------------------------------


class TestMockEmbed:
    @pytest.mark.asyncio
    async def test_mock_embed_returns_deterministic_vector(self):
        """Same input → same output, every call."""
        provider = MockLLMProvider()
        v1 = await provider.embed("hello world")
        v2 = await provider.embed("hello world")
        assert v1 == v2

    @pytest.mark.asyncio
    async def test_mock_embed_different_inputs_diverge(self):
        """Different inputs produce different vectors (no collision)."""
        provider = MockLLMProvider()
        v1 = await provider.embed("alpha")
        v2 = await provider.embed("beta")
        assert v1 != v2

    @pytest.mark.asyncio
    async def test_mock_embed_returns_list_of_floats(self):
        provider = MockLLMProvider()
        vec = await provider.embed("any text")
        assert isinstance(vec, list)
        assert len(vec) > 0
        assert all(isinstance(x, float) for x in vec)
