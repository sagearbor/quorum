"""Tests for the AI Architect Agent — generate_roles, routes, guidance."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from .architect_agent import RoleSuggestion, generate_roles, send_guidance
from .main import app


# ---------------------------------------------------------------------------
# generate_roles — QUORUM_TEST_MODE returns 4 mock roles
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_generate_roles_mock_mode():
    roles = await generate_roles("How should we handle climate policy?")
    assert len(roles) == 4
    assert all(isinstance(r, RoleSuggestion) for r in roles)
    names = {r.name for r in roles}
    assert names == {"Researcher", "Ethicist", "Administrator", "Patient Advocate"}


@pytest.mark.asyncio
async def test_generate_roles_returns_valid_shapes():
    roles = await generate_roles("Budget allocation for new department")
    for role in roles:
        assert 1 <= role.authority_rank <= 5
        assert role.name.strip() != ""
        assert role.description.strip() != ""
        assert role.suggested_prompt_focus.strip() != ""


# ---------------------------------------------------------------------------
# Route tests
# ---------------------------------------------------------------------------

def _make_fake_provider(overrides: dict | None = None) -> MagicMock:
    """Return a mock DatabaseProvider whose get_client() returns a fluent mock."""
    overrides = overrides or {}

    def _table_builder(table_name: str):
        rows = overrides.get(table_name, [])
        is_single = [False]
        chain = MagicMock()

        def _single():
            is_single[0] = True
            return chain

        chain.single = _single
        for method in (
            "select", "eq", "neq", "lt", "gt", "gte", "lte",
            "order", "limit", "insert", "update", "delete",
            "upsert", "filter",
        ):
            getattr(chain, method).return_value = chain

        def _execute():
            result = MagicMock()
            result.data = (rows[0] if rows else None) if is_single[0] else rows[:]
            return result

        chain.execute = _execute
        return chain

    db = MagicMock()
    db.table.side_effect = _table_builder

    provider = MagicMock()
    provider.get_client.return_value = db
    return provider


@pytest.fixture
def client():
    fake_provider = _make_fake_provider({
        "events": [{"id": "evt-001", "slug": "test-event"}],
        "quorums": [{"id": "quorum-001", "status": "active", "title": "Q"}],
        "roles": [],
    })
    with (
        patch("apps.api.routes.get_database_provider", return_value=fake_provider),
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
    ):
        import importlib
        import apps.api.main as main_mod
        importlib.reload(main_mod)
        with TestClient(main_mod.app) as tc:
            yield tc


def test_generate_roles_route(client):
    resp = client.post(
        "/events/evt-001/architect/generate-roles",
        json={"problem": "How to allocate research funding?"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "roles" in data
    assert len(data["roles"]) == 4
    assert data["problem_summary"] == "How to allocate research funding?"


def test_generate_roles_route_returns_correct_fields(client):
    resp = client.post(
        "/events/evt-001/architect/generate-roles",
        json={"problem": "Test problem"},
    )
    data = resp.json()
    for role in data["roles"]:
        assert "name" in role
        assert "description" in role
        assert "authority_rank" in role
        assert "capacity" in role
        assert "suggested_prompt_focus" in role


def test_ai_start_route(client):
    roles = [
        {
            "name": "Analyst",
            "description": "Data analyst",
            "authority_rank": 3,
            "capacity": "unlimited",
            "suggested_prompt_focus": "Analyze data",
        }
    ]
    resp = client.post(
        "/events/evt-001/architect/ai-start",
        json={
            "problem": "Test problem",
            "roles": roles,
            "mode": "auto",
            "quorum_title": "Test Quorum",
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "quorum_id" in data
    assert "share_url" in data
    assert data["mode"] == "auto"


# ---------------------------------------------------------------------------
# Guidance tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_send_guidance_falls_back_to_supabase():
    """send_guidance falls back to Supabase when A2A endpoint is not registered."""
    result = await send_guidance("q-001", "Focus on safety", target_role_id="role-1")

    assert result["quorum_id"] == "q-001"
    assert len(result["deliveries"]) == 1
    assert result["deliveries"][0]["role_id"] == "role-1"
    assert result["deliveries"][0]["delivery"] == "supabase_fallback"
    assert result["deliveries"][0]["status"] == "stored"


@pytest.mark.asyncio
async def test_send_guidance_broadcasts_to_all_roles():
    """Without target_role_id, sends guidance to all roles in the quorum."""
    result = await send_guidance("q-001", "General guidance")

    assert result["quorum_id"] == "q-001"
    # Mock DB returns 2 roles (role-1, role-2)
    assert len(result["deliveries"]) == 2


def test_guidance_route(client):
    with patch("apps.api.architect_agent.A2AClient") as MockA2A:
        instance = MockA2A.return_value
        instance.send_message = AsyncMock(return_value=None)

        resp = client.post(
            "/quorums/quorum-001/architect/guidance",
            json={"message": "Please focus on ethical implications"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "deliveries" in data
