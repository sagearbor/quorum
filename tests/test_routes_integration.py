"""Integration tests for FastAPI routes with MockDBProvider + MockLLMProvider.

Uses MockDBProvider (in-memory dict-based) so tests run without
any external services (no Supabase, no Azure SQL).
"""

from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

# Ensure test mode and paths
os.environ["QUORUM_TEST_MODE"] = "true"
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "llm"))
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT / "apps"))


# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_db(monkeypatch):
    """Replace get_db_provider with MockDBProvider."""
    from db import set_db_provider, reset_db_provider
    from db.mock_provider import MockDBProvider

    provider = MockDBProvider()
    set_db_provider(provider)

    yield provider

    reset_db_provider()


@pytest.fixture
def mock_realtime(monkeypatch):
    """Replace realtime provider with no-op polling provider."""
    from api.realtime import set_realtime_provider, reset_realtime_provider, PollingRealtimeProvider

    provider = PollingRealtimeProvider()
    set_realtime_provider(provider)

    yield provider

    reset_realtime_provider()


@pytest.fixture
def mock_llm(monkeypatch):
    """Replace llm_provider with MockLLMProvider."""
    from quorum_llm.providers.mock import MockLLMProvider
    provider = MockLLMProvider()
    import api.llm as llm_mod
    monkeypatch.setattr(llm_mod, "_llm_provider", provider)
    import api.routes as routes_mod
    monkeypatch.setattr(routes_mod, "llm_provider", provider)
    return provider


@pytest.fixture
def seeded_db(mock_db, mock_realtime):
    """DB pre-seeded with an event, quorum, and roles."""
    event_id = "evt-001"
    quorum_id = "qrm-001"

    loop = asyncio.get_event_loop()

    loop.run_until_complete(mock_db.create_event({
        "id": event_id,
        "name": "Test Event",
        "slug": "test-event",
        "access_code": "test123",
        "max_active_quorums": 5,
    }))

    loop.run_until_complete(mock_db.create_quorum({
        "id": quorum_id,
        "event_id": event_id,
        "title": "Clinical Trial Protocol",
        "description": "Multi-site Phase II trial",
        "status": "open",
        "heat_score": 0,
        "carousel_mode": "multi-view",
    }))

    roles = [
        {"id": "role-pi", "quorum_id": quorum_id, "name": "Principal Investigator",
         "capacity": "1", "authority_rank": 2, "prompt_template": [], "fallback_chain": []},
        {"id": "role-irb", "quorum_id": quorum_id, "name": "IRB Representative",
         "capacity": "1", "authority_rank": 3, "prompt_template": [], "fallback_chain": []},
        {"id": "role-biostat", "quorum_id": quorum_id, "name": "Biostatistician",
         "capacity": "unlimited", "authority_rank": 1, "prompt_template": [], "fallback_chain": []},
    ]
    for r in roles:
        loop.run_until_complete(mock_db.create_role(r))

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
        from db import get_db_provider

        _, _, quorum_id = seeded_db

        body = ContributeRequest(
            role_id="role-pi",
            user_token="user-1",
            content="Test activation",
        )
        await contribute(quorum_id, body)

        quorum = await get_db_provider().get_quorum(quorum_id)
        assert quorum["status"] == "active"

    @pytest.mark.asyncio
    async def test_tier2_triggered_on_overlapping_fields(self, seeded_db, mock_llm):
        from api.routes import contribute
        from api.models import ContributeRequest

        _, _, quorum_id = seeded_db

        body1 = ContributeRequest(
            role_id="role-pi",
            user_token="user-1",
            content="12-week dosing",
            structured_fields={"dosing_interval": "12 weeks"},
        )
        await contribute(quorum_id, body1)

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
        from db import get_db_provider

        _, _, quorum_id = seeded_db

        body = ContributeRequest(
            role_id="role-pi",
            user_token="user-1",
            content="Test contribution",
        )
        await contribute(quorum_id, body)

        quorum = await get_db_provider().get_quorum(quorum_id)
        score_1 = quorum["heat_score"]
        assert score_1 > 0

        body2 = ContributeRequest(
            role_id="role-irb",
            user_token="user-2",
            content="Another contribution",
        )
        await contribute(quorum_id, body2)

        quorum2 = await get_db_provider().get_quorum(quorum_id)
        score_2 = quorum2["heat_score"]
        assert score_2 > score_1

    @pytest.mark.asyncio
    async def test_contribution_to_resolved_quorum_fails(self, seeded_db, mock_llm):
        from api.routes import contribute
        from api.models import ContributeRequest
        from fastapi import HTTPException
        from db import get_db_provider

        _, _, quorum_id = seeded_db
        await get_db_provider().update_quorum(quorum_id, {"status": "resolved"})

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
        from db import get_db_provider

        _, _, quorum_id = seeded_db

        for role_id, user, content in [
            ("role-pi", "u1", "12-week dosing based on PK"),
            ("role-irb", "u2", "6-week safety checkpoints required"),
            ("role-biostat", "u3", "240 participants for 0.82 power"),
        ]:
            await contribute(quorum_id, ContributeRequest(
                role_id=role_id, user_token=user, content=content,
            ))

        result = await resolve_quorum(quorum_id, ResolveRequest(sign_off_token="admin"))
        assert result.artifact_id
        assert result.download_url.startswith("/artifacts/")

        artifact = await get_db_provider().get_artifact(quorum_id)
        assert artifact is not None
        assert artifact["version"] == 1
        assert artifact["content_hash"]
        assert len(artifact["sections"]) >= 1

    @pytest.mark.asyncio
    async def test_resolve_marks_pending_ratification_when_roles_missing(
        self, seeded_db, mock_llm
    ):
        from api.routes import contribute, resolve_quorum
        from api.models import ContributeRequest, ResolveRequest
        from db import get_db_provider

        _, _, quorum_id = seeded_db

        await contribute(quorum_id, ContributeRequest(
            role_id="role-pi", user_token="u1", content="Only PI contributed",
        ))

        await resolve_quorum(quorum_id, ResolveRequest(sign_off_token="admin"))

        artifact = await get_db_provider().get_artifact(quorum_id)
        assert artifact["status"] == "pending_ratification"

    @pytest.mark.asyncio
    async def test_resolve_already_resolved_fails(self, seeded_db, mock_llm):
        from api.routes import resolve_quorum
        from api.models import ResolveRequest
        from fastapi import HTTPException
        from db import get_db_provider

        _, _, quorum_id = seeded_db
        await get_db_provider().update_quorum(quorum_id, {"status": "resolved"})

        with pytest.raises(HTTPException) as exc_info:
            await resolve_quorum(quorum_id, ResolveRequest(sign_off_token="admin"))
        assert exc_info.value.status_code == 409

    @pytest.mark.asyncio
    async def test_resolve_sets_quorum_resolved(self, seeded_db, mock_llm):
        from api.routes import contribute, resolve_quorum
        from api.models import ContributeRequest, ResolveRequest
        from db import get_db_provider

        _, _, quorum_id = seeded_db

        await contribute(quorum_id, ContributeRequest(
            role_id="role-pi", user_token="u1", content="test",
        ))
        await resolve_quorum(quorum_id, ResolveRequest(sign_off_token="admin"))

        quorum = await get_db_provider().get_quorum(quorum_id)
        assert quorum["status"] == "resolved"


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
        assert len(state.active_roles) == 3
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


class TestPollEndpoint:
    @pytest.mark.asyncio
    async def test_poll_returns_state_with_etag(self, seeded_db, mock_llm):
        from api.routes import contribute, poll_quorum
        from api.models import ContributeRequest

        _, _, quorum_id = seeded_db

        await contribute(quorum_id, ContributeRequest(
            role_id="role-pi", user_token="u1", content="test",
        ))

        result = await poll_quorum(quorum_id)
        assert result.health_score > 0
        assert result.etag
        assert len(result.active_roles) == 3

    @pytest.mark.asyncio
    async def test_poll_etag_changes_on_new_contribution(self, seeded_db, mock_llm):
        from api.routes import contribute, poll_quorum
        from api.models import ContributeRequest

        _, _, quorum_id = seeded_db

        await contribute(quorum_id, ContributeRequest(
            role_id="role-pi", user_token="u1", content="first",
        ))
        result1 = await poll_quorum(quorum_id)

        await contribute(quorum_id, ContributeRequest(
            role_id="role-irb", user_token="u2", content="second",
        ))
        result2 = await poll_quorum(quorum_id)

        assert result1.etag != result2.etag

    @pytest.mark.asyncio
    async def test_poll_not_found(self, seeded_db, mock_llm):
        from api.routes import poll_quorum
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            await poll_quorum("nonexistent")
        assert exc_info.value.status_code == 404
