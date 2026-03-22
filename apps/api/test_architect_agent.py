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

@pytest.fixture
def client():
    with TestClient(app) as tc:
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
