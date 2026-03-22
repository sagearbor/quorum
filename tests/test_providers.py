"""Tests for provider factory abstractions — storage, database, LLM."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure packages/llm and apps/ are importable
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "llm"))
sys.path.insert(0, str(ROOT / "apps"))

# Force test mode
os.environ["QUORUM_TEST_MODE"] = "true"


# ---------------------------------------------------------------------------
# Storage factory tests
# ---------------------------------------------------------------------------


class TestStorageFactory:
    def setup_method(self):
        # Reset singleton between tests
        import api.storage.factory as sf
        sf._provider = None

    def test_default_is_local(self):
        os.environ.pop("STORAGE_PROVIDER", None)
        from api.storage.factory import get_storage_provider
        from api.storage.local_provider import LocalStorageProvider

        provider = get_storage_provider()
        assert isinstance(provider, LocalStorageProvider)

    def test_local_explicit(self):
        os.environ["STORAGE_PROVIDER"] = "local"
        from api.storage.factory import get_storage_provider
        from api.storage.local_provider import LocalStorageProvider

        provider = get_storage_provider()
        assert isinstance(provider, LocalStorageProvider)

    def test_unknown_raises(self):
        os.environ["STORAGE_PROVIDER"] = "s3"
        from api.storage.factory import get_storage_provider

        with pytest.raises(ValueError, match="Unknown STORAGE_PROVIDER"):
            get_storage_provider()

    def teardown_method(self):
        os.environ.pop("STORAGE_PROVIDER", None)
        import api.storage.factory as sf
        sf._provider = None


# ---------------------------------------------------------------------------
# LocalStorageProvider roundtrip tests
# ---------------------------------------------------------------------------


class TestLocalStorageProvider:
    def test_upload_download_roundtrip(self):
        from api.storage.local_provider import LocalStorageProvider

        with tempfile.TemporaryDirectory() as tmpdir:
            provider = LocalStorageProvider(upload_dir=tmpdir)
            data = b"hello quorum"

            import asyncio

            url = asyncio.get_event_loop().run_until_complete(
                provider.upload("test.txt", data, "text/plain")
            )
            assert url == "/static/test.txt"

            downloaded = asyncio.get_event_loop().run_until_complete(
                provider.download("test.txt")
            )
            assert downloaded == data

    def test_delete(self):
        from api.storage.local_provider import LocalStorageProvider

        with tempfile.TemporaryDirectory() as tmpdir:
            provider = LocalStorageProvider(upload_dir=tmpdir)
            import asyncio

            loop = asyncio.get_event_loop()
            loop.run_until_complete(provider.upload("del.txt", b"x", "text/plain"))
            assert loop.run_until_complete(provider.delete("del.txt")) is True
            assert loop.run_until_complete(provider.delete("del.txt")) is False

    def test_download_missing_raises(self):
        from api.storage.local_provider import LocalStorageProvider

        with tempfile.TemporaryDirectory() as tmpdir:
            provider = LocalStorageProvider(upload_dir=tmpdir)
            import asyncio

            with pytest.raises(FileNotFoundError):
                asyncio.get_event_loop().run_until_complete(
                    provider.download("nonexistent.txt")
                )

    def test_get_url(self):
        from api.storage.local_provider import LocalStorageProvider

        provider = LocalStorageProvider()
        assert provider.get_url("report.pdf") == "/static/report.pdf"


# ---------------------------------------------------------------------------
# Database factory tests
# ---------------------------------------------------------------------------


class TestDatabaseFactory:
    def setup_method(self):
        import api.db.factory as df
        df._provider = None

    def test_default_is_supabase(self):
        os.environ.pop("DATABASE_PROVIDER", None)
        # Supabase provider imports get_supabase which needs env vars,
        # but we can test the factory selection logic by mocking
        with patch("api.db.supabase_provider.get_supabase"):
            from api.db.factory import get_database_provider
            from api.db.supabase_provider import SupabaseDatabaseProvider

            provider = get_database_provider()
            assert isinstance(provider, SupabaseDatabaseProvider)

    def test_unknown_raises(self):
        os.environ["DATABASE_PROVIDER"] = "mysql"
        from api.db.factory import get_database_provider

        with pytest.raises(ValueError, match="Unknown DATABASE_PROVIDER"):
            get_database_provider()

    def teardown_method(self):
        os.environ.pop("DATABASE_PROVIDER", None)
        import api.db.factory as df
        df._provider = None


# ---------------------------------------------------------------------------
# LLM factory tests
# ---------------------------------------------------------------------------


class TestLLMFactory:
    def test_test_mode_returns_mock(self):
        os.environ["QUORUM_TEST_MODE"] = "true"
        from quorum_llm.factory import get_llm_provider
        from quorum_llm.providers.mock import MockLLMProvider

        provider = get_llm_provider("openai")
        assert isinstance(provider, MockLLMProvider)

    def test_mock_by_name(self):
        os.environ.pop("QUORUM_TEST_MODE", None)
        from quorum_llm.factory import get_llm_provider
        from quorum_llm.providers.mock import MockLLMProvider

        provider = get_llm_provider("mock")
        assert isinstance(provider, MockLLMProvider)
        # Restore
        os.environ["QUORUM_TEST_MODE"] = "true"

    def test_unknown_provider_raises(self):
        os.environ.pop("QUORUM_TEST_MODE", None)
        from quorum_llm.factory import get_llm_provider

        with pytest.raises(ValueError, match="Unknown LLM provider"):
            get_llm_provider("gemini")
        os.environ["QUORUM_TEST_MODE"] = "true"

    def test_openai_registered(self):
        from quorum_llm.factory import _PROVIDERS
        assert "openai" in _PROVIDERS

    def test_local_registered(self):
        from quorum_llm.factory import _PROVIDERS
        assert "local" in _PROVIDERS

    def test_all_providers_registered(self):
        from quorum_llm.factory import _PROVIDERS
        expected = {"openai", "azure", "anthropic", "local", "mock"}
        assert set(_PROVIDERS.keys()) == expected


# ---------------------------------------------------------------------------
# Mock LLM provider works in test mode
# ---------------------------------------------------------------------------


class TestMockLLMProviderInTestMode:
    def test_complete_keyword(self):
        import asyncio
        from quorum_llm.models import LLMTier
        from quorum_llm.providers.mock import MockLLMProvider

        provider = MockLLMProvider()
        result = asyncio.get_event_loop().run_until_complete(
            provider.complete("clinical trial safety protocol", LLMTier.KEYWORD)
        )
        assert isinstance(result, str)
        assert len(result) > 0

    def test_complete_conflict(self):
        import asyncio
        from quorum_llm.models import LLMTier
        from quorum_llm.providers.mock import MockLLMProvider

        provider = MockLLMProvider()
        result = asyncio.get_event_loop().run_until_complete(
            provider.complete("some prompt", LLMTier.CONFLICT)
        )
        assert isinstance(result, str)

    def test_embed(self):
        import asyncio
        from quorum_llm.providers.mock import MockLLMProvider

        provider = MockLLMProvider()
        vec = asyncio.get_event_loop().run_until_complete(
            provider.embed("test embedding")
        )
        assert isinstance(vec, list)
        assert len(vec) == 256
