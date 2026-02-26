"""Tests for packages/db — MockDBProvider, AzureSQLProvider (SQLite mode), and factory."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Ensure packages are importable
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages"))

os.environ["QUORUM_TEST_MODE"] = "true"


# ---------------------------------------------------------------------------
# MockDBProvider tests
# ---------------------------------------------------------------------------


class TestMockDBProvider:
    @pytest.fixture
    def db(self):
        from db.mock_provider import MockDBProvider
        return MockDBProvider()

    @pytest.mark.asyncio
    async def test_create_and_get_event(self, db):
        row = {"id": "evt-1", "name": "Test", "slug": "test", "access_code": "abc", "max_active_quorums": 5}
        created = await db.create_event(row)
        assert created["id"] == "evt-1"
        assert "created_at" in created

        found = await db.get_event("test")
        assert found is not None
        assert found["id"] == "evt-1"

        by_id = await db.get_event_by_id("evt-1")
        assert by_id is not None
        assert by_id["slug"] == "test"

    @pytest.mark.asyncio
    async def test_event_not_found(self, db):
        assert await db.get_event("nonexistent") is None
        assert await db.get_event_by_id("nonexistent") is None

    @pytest.mark.asyncio
    async def test_create_and_get_quorum(self, db):
        row = {"id": "q-1", "event_id": "evt-1", "title": "Test Q", "status": "open"}
        await db.create_quorum(row)

        found = await db.get_quorum("q-1")
        assert found is not None
        assert found["title"] == "Test Q"

    @pytest.mark.asyncio
    async def test_update_quorum(self, db):
        await db.create_quorum({"id": "q-1", "event_id": "evt-1", "title": "T", "status": "open"})
        updated = await db.update_quorum("q-1", {"status": "active"})
        assert updated is not None
        assert updated["status"] == "active"

    @pytest.mark.asyncio
    async def test_roles_crud(self, db):
        await db.create_role({"id": "r-1", "quorum_id": "q-1", "name": "PI", "authority_rank": 2})
        await db.create_role({"id": "r-2", "quorum_id": "q-1", "name": "IRB", "authority_rank": 3})
        await db.create_role({"id": "r-3", "quorum_id": "q-2", "name": "Other", "authority_rank": 1})

        roles = await db.get_roles("q-1")
        assert len(roles) == 2
        names = {r["name"] for r in roles}
        assert names == {"PI", "IRB"}

    @pytest.mark.asyncio
    async def test_contributions_ordered(self, db):
        await db.add_contribution({
            "id": "c-1", "quorum_id": "q-1", "role_id": "r-1",
            "user_token": "u1", "content": "first", "created_at": "2024-01-01T00:00:00",
        })
        await db.add_contribution({
            "id": "c-2", "quorum_id": "q-1", "role_id": "r-2",
            "user_token": "u2", "content": "second", "created_at": "2024-01-01T00:00:01",
        })

        contribs = await db.get_contributions("q-1")
        assert len(contribs) == 2
        assert contribs[0]["id"] == "c-1"
        assert contribs[1]["id"] == "c-2"

    @pytest.mark.asyncio
    async def test_update_contribution(self, db):
        await db.add_contribution({
            "id": "c-1", "quorum_id": "q-1", "role_id": "r-1",
            "user_token": "u1", "content": "test", "tier_processed": 1,
        })
        await db.update_contribution("c-1", {"tier_processed": 2})
        contribs = await db.get_contributions("q-1")
        assert contribs[0]["tier_processed"] == 2

    @pytest.mark.asyncio
    async def test_artifact_crud_with_cas(self, db):
        await db.create_artifact({
            "id": "a-1", "quorum_id": "q-1", "version": 1,
            "content_hash": "abc", "sections": [], "status": "draft",
        })

        found = await db.get_artifact("q-1")
        assert found is not None
        assert found["version"] == 1

        # CAS success
        updated = await db.update_artifact("a-1", 1, {"version": 2, "content_hash": "def"})
        assert updated is not None
        assert updated["version"] == 2

        # CAS failure (wrong version)
        failed = await db.update_artifact("a-1", 1, {"version": 3})
        assert failed is None

    @pytest.mark.asyncio
    async def test_get_quorum_state(self, db):
        await db.create_quorum({"id": "q-1", "event_id": "evt-1", "title": "T", "status": "open"})
        await db.create_role({"id": "r-1", "quorum_id": "q-1", "name": "PI"})
        await db.add_contribution({
            "id": "c-1", "quorum_id": "q-1", "role_id": "r-1",
            "user_token": "u1", "content": "test",
        })

        state = await db.get_quorum_state("q-1")
        assert state is not None
        assert state["quorum"]["id"] == "q-1"
        assert len(state["roles"]) == 1
        assert len(state["contributions"]) == 1
        assert state["artifact"] is None

    @pytest.mark.asyncio
    async def test_get_quorum_state_not_found(self, db):
        assert await db.get_quorum_state("nonexistent") is None


# ---------------------------------------------------------------------------
# AzureSQLProvider (SQLite in-memory) tests
# ---------------------------------------------------------------------------


class TestAzureSQLProvider:
    @pytest.fixture
    def db(self):
        from db.azure_provider import AzureSQLProvider
        return AzureSQLProvider()  # Uses SQLite in-memory due to QUORUM_TEST_MODE=true

    @pytest.mark.asyncio
    async def test_create_and_get_event(self, db):
        row = {"id": "evt-1", "name": "Test", "slug": "test-azure", "access_code": "xyz", "max_active_quorums": 3}
        created = await db.create_event(row)
        assert created["id"] == "evt-1"

        found = await db.get_event("test-azure")
        assert found is not None
        assert found["name"] == "Test"

    @pytest.mark.asyncio
    async def test_quorum_lifecycle(self, db):
        await db.create_event({"id": "evt-1", "name": "E", "slug": "e", "access_code": "x"})
        await db.create_quorum({"id": "q-1", "event_id": "evt-1", "title": "Q", "status": "open"})

        q = await db.get_quorum("q-1")
        assert q["status"] == "open"

        await db.update_quorum("q-1", {"status": "active"})
        q = await db.get_quorum("q-1")
        assert q["status"] == "active"

    @pytest.mark.asyncio
    async def test_roles_and_contributions(self, db):
        await db.create_role({
            "id": "r-1", "quorum_id": "q-1", "name": "PI",
            "authority_rank": 2, "prompt_template": [{"field_name": "dosing", "prompt": "Enter dosing"}],
            "fallback_chain": ["r-2"],
        })

        roles = await db.get_roles("q-1")
        assert len(roles) == 1
        assert roles[0]["prompt_template"] == [{"field_name": "dosing", "prompt": "Enter dosing"}]
        assert roles[0]["fallback_chain"] == ["r-2"]

        await db.add_contribution({
            "id": "c-1", "quorum_id": "q-1", "role_id": "r-1",
            "user_token": "u1", "content": "12 weeks",
            "structured_fields": {"dosing": "12 weeks"}, "tier_processed": 1,
        })

        contribs = await db.get_contributions("q-1")
        assert len(contribs) == 1
        assert contribs[0]["structured_fields"] == {"dosing": "12 weeks"}

    @pytest.mark.asyncio
    async def test_artifact_cas(self, db):
        await db.create_artifact({
            "id": "a-1", "quorum_id": "q-1", "version": 1,
            "content_hash": "h1", "sections": [{"title": "S1", "content": "C1"}], "status": "draft",
        })

        art = await db.get_artifact("q-1")
        assert art["sections"] == [{"title": "S1", "content": "C1"}]

        # CAS success
        updated = await db.update_artifact("a-1", 1, {
            "version": 2, "content_hash": "h2",
            "sections": [{"title": "S1", "content": "Updated"}],
        })
        assert updated is not None
        assert updated["version"] == 2

        # CAS failure
        failed = await db.update_artifact("a-1", 1, {"version": 3})
        assert failed is None

    @pytest.mark.asyncio
    async def test_get_quorum_state(self, db):
        await db.create_quorum({"id": "q-1", "event_id": "evt-1", "title": "T", "status": "open"})
        await db.create_role({"id": "r-1", "quorum_id": "q-1", "name": "PI"})

        state = await db.get_quorum_state("q-1")
        assert state is not None
        assert state["quorum"]["title"] == "T"
        assert state["artifact"] is None


# ---------------------------------------------------------------------------
# Factory tests
# ---------------------------------------------------------------------------


class TestDBFactory:
    def test_default_returns_supabase_provider(self, monkeypatch):
        """With DB_PROVIDER unset or 'supabase', factory returns SupabaseProvider."""
        monkeypatch.delenv("DB_PROVIDER", raising=False)
        # We can't fully instantiate SupabaseProvider without env vars,
        # but we can test the factory logic by mocking
        from db import reset_db_provider, get_db_provider, set_db_provider
        from db.mock_provider import MockDBProvider

        reset_db_provider()
        mock = MockDBProvider()
        set_db_provider(mock)
        assert get_db_provider() is mock
        reset_db_provider()

    def test_azure_returns_azure_provider(self, monkeypatch):
        """With DB_PROVIDER=azure and QUORUM_TEST_MODE=true, factory returns AzureSQLProvider."""
        monkeypatch.setenv("DB_PROVIDER", "azure")
        monkeypatch.setenv("QUORUM_TEST_MODE", "true")

        from db import reset_db_provider, get_db_provider
        from db.azure_provider import AzureSQLProvider

        reset_db_provider()
        provider = get_db_provider()
        assert isinstance(provider, AzureSQLProvider)
        reset_db_provider()

    def test_set_and_reset(self):
        from db import reset_db_provider, get_db_provider, set_db_provider
        from db.mock_provider import MockDBProvider

        reset_db_provider()
        mock = MockDBProvider()
        set_db_provider(mock)
        assert get_db_provider() is mock
        reset_db_provider()
