"""Tests for checklist item 9.3 — typed Pydantic AI agents in the architect.

Covers the typed-output ``generate_roles`` path and verifies the
``RoleSuggestionList`` wrapper, the QUORUM_TEST_MODE short-circuit, and
backward compatibility with the legacy MagicMock-based test fixtures.

Pipeline-side typed-output tests live in
``packages/llm/tests/test_pipeline_typed_agents.py`` so the LLM package is
self-contained.
"""

from __future__ import annotations

import pytest


# ---------------------------------------------------------------------------
# 1. QUORUM_TEST_MODE short-circuit still bypasses LLM entirely
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_test_mode_returns_mock_roles_without_llm(monkeypatch):
    """In QUORUM_TEST_MODE we skip the LLM and return the canned mock roles."""
    monkeypatch.setenv("QUORUM_TEST_MODE", "true")
    from apps.api.architect_agent import generate_roles, RoleSuggestion

    roles = await generate_roles("Test problem")
    assert len(roles) >= 4
    assert all(isinstance(r, RoleSuggestion) for r in roles)


# ---------------------------------------------------------------------------
# 2. Typed-agent path uses run_typed with output_type=RoleSuggestionList
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_roles_uses_typed_agent_when_provider_overrides_run_typed(monkeypatch):
    """When the provider has a real run_typed override (not the ABC default),
    generate_roles routes through it and gets a typed RoleSuggestionList back.

    We construct a minimal test double here rather than importing the real
    MockLLMProvider because apps/api tests run with a stubbed quorum_llm
    module (see conftest._install_quorum_llm_mock).
    """
    monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
    from apps.api.architect_agent import generate_roles, RoleSuggestion

    call_log: list[dict] = []

    from quorum_llm.interface import LLMProvider

    class TypedTestProvider(LLMProvider):  # type: ignore[misc]
        async def complete(self, prompt, tier):
            return ""

        async def embed(self, text):
            return [0.0] * 10

        async def run_typed(
            self, prompt, tier, *, output_type, instructions=None,
            temperature=None, max_tokens=None,
        ):
            call_log.append({
                "prompt": prompt,
                "tier": int(tier),
                "output_type": output_type.__name__,
            })
            payload = {
                "roles": [
                    {
                        "name": "Researcher",
                        "description": "Evidence specialist",
                        "authority_rank": 3,
                        "capacity": "unlimited",
                        "suggested_prompt_focus": "Evaluate evidence",
                        "system_prompt": "You are the Researcher on this quorum.",
                        "domain_tags": ["research", "evidence"],
                        "temperature": 0.3,
                        "model": "gpt-4o-mini",
                    },
                    {
                        "name": "Ethicist",
                        "description": "Ethics specialist",
                        "authority_rank": 4,
                        "capacity": 1,
                        "suggested_prompt_focus": "Identify ethical issues",
                        "system_prompt": "You are the Ethicist on this quorum.",
                        "domain_tags": ["ethics", "consent"],
                        "temperature": 0.4,
                        "model": "gpt-4o-mini",
                    },
                ],
            }
            return output_type.model_validate(payload)

    provider = TypedTestProvider()
    roles = await generate_roles(
        "Design a phase-2 oncology trial", llm_provider=provider
    )

    assert len(roles) == 2
    assert all(isinstance(r, RoleSuggestion) for r in roles)
    names = {r.name for r in roles}
    assert names == {"Researcher", "Ethicist"}

    # Exactly one typed-output LLM call
    typed_calls = [
        c for c in call_log if c["output_type"] == "RoleSuggestionList"
    ]
    assert len(typed_calls) == 1
    # And the tier is CONFLICT (Tier 2) — same as before the refactor
    from quorum_llm.models import LLMTier
    assert typed_calls[0]["tier"] == int(LLMTier.CONFLICT)


# ---------------------------------------------------------------------------
# 3. Backward compatibility: MagicMock fixtures (legacy path) still work
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_roles_legacy_path_still_works_with_magicmock(monkeypatch):
    """Existing test fixtures that stub .respond / .chat directly (MagicMock-
    based) must keep working — the architect detects them and routes through
    the legacy free-text + JSON-parse path instead of run_typed.

    Regression guard for tests in test_architect_personas.py that pre-date
    item 9.3 and don't know about run_typed.
    """
    import json
    from unittest.mock import AsyncMock, MagicMock

    monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)
    from apps.api.architect_agent import generate_roles

    fake_payload = json.dumps([
        {
            "name": "Researcher",
            "description": "Evidence specialist",
            "authority_rank": 3,
            "capacity": "unlimited",
            "suggested_prompt_focus": "Evaluate evidence",
            "system_prompt": "You are the Researcher.",
            "domain_tags": ["r1", "r2", "r3"],
            "temperature": 0.3,
            "model": "gpt-4o-mini",
        }
    ])
    fake_provider = MagicMock()
    fake_provider.respond = AsyncMock(return_value=(fake_payload, {}))
    fake_provider.chat = AsyncMock(return_value=fake_payload)

    roles = await generate_roles("Test problem", llm_provider=fake_provider)
    assert len(roles) == 1
    assert roles[0].name == "Researcher"


# ---------------------------------------------------------------------------
# 4. RoleSuggestionList wrapper schema is sound
# ---------------------------------------------------------------------------


def test_role_suggestion_list_wrapper_validates_inputs():
    """RoleSuggestionList must require at least one role."""
    from apps.api.architect_agent import RoleSuggestion, RoleSuggestionList
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        RoleSuggestionList(roles=[])

    role = RoleSuggestion(
        name="X",
        description="desc",
        authority_rank=3,
        suggested_prompt_focus="focus",
    )
    wrapped = RoleSuggestionList(roles=[role])
    assert len(wrapped.roles) == 1
