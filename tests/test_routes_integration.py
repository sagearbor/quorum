"""Integration tests for FastAPI routes with MockLLMProvider + Supabase mock.

Uses an in-memory dict-based mock that replaces the Supabase client, so
tests run without any external services.
"""

from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

# Ensure test mode and paths
os.environ["QUORUM_TEST_MODE"] = "true"
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "llm"))
sys.path.insert(0, str(ROOT / "apps"))


# ---------------------------------------------------------------------------
# In-memory Supabase mock
# ---------------------------------------------------------------------------

class MockQueryResult:
    def __init__(self, data: list[dict]):
        self.data = data


class MockTableQuery:
    """Chainable query builder that operates on an in-memory list."""

    def __init__(self, table: MockTable, data: list[dict]):
        self._table = table
        self._data = data
        self._filters: list[tuple[str, str]] = []
        self._is_single = False
        self._order_col: str | None = None

    def eq(self, col: str, val: Any) -> MockTableQuery:
        self._filters.append((col, val))
        return self

    def single(self) -> MockTableQuery:
        self._is_single = True
        return self

    def order(self, col: str) -> MockTableQuery:
        self._order_col = col
        return self

    def select(self, cols: str) -> MockTableQuery:
        return self

    def execute(self) -> MockQueryResult:
        result = self._data
        for col, val in self._filters:
            result = [r for r in result if r.get(col) == val]
        if self._order_col:
            result = sorted(result, key=lambda r: r.get(self._order_col, ""))
        if self._is_single:
            return MockQueryResult(result[0] if result else None)
        return MockQueryResult(result)


class MockInsertQuery:
    def __init__(self, table: MockTable, row: dict):
        self._table = table
        self._row = row

    def execute(self) -> MockQueryResult:
        # Add created_at if not present
        if "created_at" not in self._row:
            self._row["created_at"] = datetime.now(timezone.utc).isoformat()
        self._table._rows.append(self._row)
        return MockQueryResult([self._row])


class MockUpdateQuery:
    def __init__(self, table: MockTable, updates: dict):
        self._table = table
        self._updates = updates
        self._filters: list[tuple[str, str]] = []

    def eq(self, col: str, val: Any) -> MockUpdateQuery:
        self._filters.append((col, val))
        return self

    def execute(self) -> MockQueryResult:
        updated = []
        for row in self._table._rows:
            match = all(row.get(c) == v for c, v in self._filters)
            if match:
                row.update(self._updates)
                updated.append(row)
        return MockQueryResult(updated)


class MockTable:
    def __init__(self, name: str):
        self.name = name
        self._rows: list[dict] = []

    def select(self, cols: str = "*") -> MockTableQuery:
        return MockTableQuery(self, self._rows)

    def insert(self, row: dict) -> MockInsertQuery:
        return MockInsertQuery(self, row)

    def update(self, updates: dict) -> MockUpdateQuery:
        return MockUpdateQuery(self, updates)


class MockSupabase:
    def __init__(self):
        self._tables: dict[str, MockTable] = {}

    def table(self, name: str) -> MockTable:
        if name not in self._tables:
            self._tables[name] = MockTable(name)
        return self._tables[name]


# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_db(monkeypatch):
    """Replace get_supabase with in-memory mock."""
    db = MockSupabase()
    import api.database as db_mod
    import api.routes as routes_mod
    # Patch both the database module and the routes module reference
    monkeypatch.setattr(db_mod, "_client", db)
    monkeypatch.setattr(db_mod, "get_supabase", lambda: db)
    # routes.py does `from .database import get_supabase` — patch that too
    monkeypatch.setattr(routes_mod, "get_supabase", lambda: db)
    return db


@pytest.fixture
def mock_llm(monkeypatch):
    """Replace llm_provider with MockLLMProvider."""
    from quorum_llm.providers.mock import MockLLMProvider
    provider = MockLLMProvider()
    # Patch the lazy provider's backing instance so routes use our mock
    import api.llm as llm_mod
    monkeypatch.setattr(llm_mod, "_llm_provider", provider)
    import api.routes as routes_mod
    monkeypatch.setattr(routes_mod, "llm_provider", provider)
    return provider


@pytest.fixture
def seeded_db(mock_db):
    """DB pre-seeded with an event, quorum, and roles."""
    event_id = "evt-001"
    quorum_id = "qrm-001"

    mock_db.table("events")._rows.append({
        "id": event_id,
        "name": "Test Event",
        "slug": "test-event",
        "access_code": "test123",
        "max_active_quorums": 5,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    mock_db.table("quorums")._rows.append({
        "id": quorum_id,
        "event_id": event_id,
        "title": "Clinical Trial Protocol",
        "description": "Multi-site Phase II trial",
        "status": "open",
        "heat_score": 0,
        "carousel_mode": "multi-view",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    roles = [
        {"id": "role-pi", "quorum_id": quorum_id, "name": "Principal Investigator",
         "capacity": "1", "authority_rank": 2, "prompt_template": [], "fallback_chain": []},
        {"id": "role-irb", "quorum_id": quorum_id, "name": "IRB Representative",
         "capacity": "1", "authority_rank": 3, "prompt_template": [], "fallback_chain": []},
        {"id": "role-biostat", "quorum_id": quorum_id, "name": "Biostatistician",
         "capacity": "unlimited", "authority_rank": 1, "prompt_template": [], "fallback_chain": []},
    ]
    for r in roles:
        mock_db.table("roles")._rows.append(r)

    return mock_db, event_id, quorum_id


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestContributeRoute:
    @pytest.mark.asyncio
    async def test_basic_contribution(self, seeded_db, mock_llm):
        from api.routes import contribute
        from api.models import ContributeRequest

        _, _, quorum_id = seeded_db

        body = ContributeRequest(
            role_id="role-pi",
            user_token="user-1",
            content="Recommend 12-week dosing interval",
            structured_fields={"dosing_interval": "12 weeks"},
        )
        response = await contribute(quorum_id, body)
        assert response.contribution_id
        assert response.tier_processed >= 1

    @pytest.mark.asyncio
    async def test_contribution_activates_quorum(self, seeded_db, mock_llm):
        from api.routes import contribute
        from api.models import ContributeRequest

        db, _, quorum_id = seeded_db

        body = ContributeRequest(
            role_id="role-pi",
            user_token="user-1",
            content="Test activation",
        )
        await contribute(quorum_id, body)

        # Quorum should be activated
        quorum = db.table("quorums").select("*").eq("id", quorum_id).single().execute()
        assert quorum.data["status"] == "active"

    @pytest.mark.asyncio
    async def test_tier2_triggered_on_overlapping_fields(self, seeded_db, mock_llm):
        from api.routes import contribute
        from api.models import ContributeRequest

        _, _, quorum_id = seeded_db

        # First contribution
        body1 = ContributeRequest(
            role_id="role-pi",
            user_token="user-1",
            content="12-week dosing",
            structured_fields={"dosing_interval": "12 weeks"},
        )
        await contribute(quorum_id, body1)

        # Second contribution on same field → should trigger Tier 2
        body2 = ContributeRequest(
            role_id="role-irb",
            user_token="user-2",
            content="6-week safety checkpoint",
            structured_fields={"dosing_interval": "6 weeks"},
        )
        response2 = await contribute(quorum_id, body2)
        assert response2.tier_processed == 2

    @pytest.mark.asyncio
    async def test_health_score_increases(self, seeded_db, mock_llm):
        from api.routes import contribute
        from api.models import ContributeRequest

        db, _, quorum_id = seeded_db

        # Contribute from one role
        body = ContributeRequest(
            role_id="role-pi",
            user_token="user-1",
            content="Test contribution",
        )
        await contribute(quorum_id, body)

        quorum = db.table("quorums").select("*").eq("id", quorum_id).single().execute()
        score_1 = quorum.data["heat_score"]
        assert score_1 > 0

        # Contribute from another role
        body2 = ContributeRequest(
            role_id="role-irb",
            user_token="user-2",
            content="Another contribution",
        )
        await contribute(quorum_id, body2)

        quorum2 = db.table("quorums").select("*").eq("id", quorum_id).single().execute()
        score_2 = quorum2.data["heat_score"]
        assert score_2 > score_1

    @pytest.mark.asyncio
    async def test_contribution_to_resolved_quorum_fails(self, seeded_db, mock_llm):
        from api.routes import contribute
        from api.models import ContributeRequest
        from fastapi import HTTPException

        db, _, quorum_id = seeded_db
        # Mark quorum resolved
        db.table("quorums").update({"status": "resolved"}).eq("id", quorum_id).execute()

        body = ContributeRequest(
            role_id="role-pi",
            user_token="user-1",
            content="Too late",
        )
        with pytest.raises(HTTPException) as exc_info:
            await contribute(quorum_id, body)
        assert exc_info.value.status_code == 409


class TestResolveRoute:
    @pytest.mark.asyncio
    async def test_resolve_generates_artifact(self, seeded_db, mock_llm):
        from api.routes import contribute, resolve_quorum
        from api.models import ContributeRequest, ResolveRequest

        db, _, quorum_id = seeded_db

        # Add contributions first
        for role_id, user, content in [
            ("role-pi", "u1", "12-week dosing based on PK"),
            ("role-irb", "u2", "6-week safety checkpoints required"),
            ("role-biostat", "u3", "240 participants for 0.82 power"),
        ]:
            await contribute(quorum_id, ContributeRequest(
                role_id=role_id, user_token=user, content=content,
            ))

        # Resolve
        result = await resolve_quorum(quorum_id, ResolveRequest(sign_off_token="admin"))
        assert result.artifact_id
        assert result.download_url.startswith("/artifacts/")

        # Artifact should exist in DB
        artifacts = db.table("artifacts").select("*").eq("quorum_id", quorum_id).execute()
        assert len(artifacts.data) == 1
        artifact = artifacts.data[0]
        assert artifact["version"] == 1
        assert artifact["content_hash"]
        assert len(artifact["sections"]) >= 1

    @pytest.mark.asyncio
    async def test_resolve_marks_pending_ratification_when_roles_missing(
        self, seeded_db, mock_llm
    ):
        from api.routes import contribute, resolve_quorum
        from api.models import ContributeRequest, ResolveRequest

        db, _, quorum_id = seeded_db

        # Only one role contributes (two are missing)
        await contribute(quorum_id, ContributeRequest(
            role_id="role-pi", user_token="u1", content="Only PI contributed",
        ))

        result = await resolve_quorum(quorum_id, ResolveRequest(sign_off_token="admin"))

        artifacts = db.table("artifacts").select("*").eq("quorum_id", quorum_id).execute()
        assert artifacts.data[0]["status"] == "pending_ratification"

    @pytest.mark.asyncio
    async def test_resolve_already_resolved_fails(self, seeded_db, mock_llm):
        from api.routes import resolve_quorum
        from api.models import ResolveRequest
        from fastapi import HTTPException

        db, _, quorum_id = seeded_db
        db.table("quorums").update({"status": "resolved"}).eq("id", quorum_id).execute()

        with pytest.raises(HTTPException) as exc_info:
            await resolve_quorum(quorum_id, ResolveRequest(sign_off_token="admin"))
        assert exc_info.value.status_code == 409

    @pytest.mark.asyncio
    async def test_resolve_sets_quorum_resolved(self, seeded_db, mock_llm):
        from api.routes import contribute, resolve_quorum
        from api.models import ContributeRequest, ResolveRequest

        db, _, quorum_id = seeded_db

        await contribute(quorum_id, ContributeRequest(
            role_id="role-pi", user_token="u1", content="test",
        ))
        await resolve_quorum(quorum_id, ResolveRequest(sign_off_token="admin"))

        quorum = db.table("quorums").select("*").eq("id", quorum_id).single().execute()
        assert quorum.data["status"] == "resolved"


class TestGetState:
    @pytest.mark.asyncio
    async def test_state_returns_health_score(self, seeded_db, mock_llm):
        from api.routes import contribute, get_quorum_state
        from api.models import ContributeRequest

        _, _, quorum_id = seeded_db

        await contribute(quorum_id, ContributeRequest(
            role_id="role-pi", user_token="u1", content="test",
        ))

        state = await get_quorum_state(quorum_id)
        assert state.health_score > 0
        assert len(state.active_roles) == 3  # All roles listed
        # PI should have participant_count >= 1
        pi_role = next(r for r in state.active_roles if r.role_id == "role-pi")
        assert pi_role.participant_count >= 1

    @pytest.mark.asyncio
    async def test_state_includes_artifact_after_resolve(self, seeded_db, mock_llm):
        from api.routes import contribute, resolve_quorum, get_quorum_state
        from api.models import ContributeRequest, ResolveRequest

        _, _, quorum_id = seeded_db

        await contribute(quorum_id, ContributeRequest(
            role_id="role-pi", user_token="u1", content="test",
        ))
        await resolve_quorum(quorum_id, ResolveRequest(sign_off_token="admin"))

        state = await get_quorum_state(quorum_id)
        assert state.artifact is not None
        assert state.artifact["content_hash"]
