"""Tests for checklist item 10.1 — architect persona generation + persistence.

Covers:
  - RoleSuggestion now carries a full persona (system_prompt, domain_tags,
    temperature, model).
  - Mock-mode roles ship with non-empty personas.
  - generate_roles() parses a single LLM response that contains personas
    inline (one round-trip, not N+1).
  - persist_agent_configs() inserts one row per role with the persona fields.
  - architect_ai_start route inserts BOTH roles AND agent_configs rows.
  - agents.load_agent() prefers an agent_configs row over the static YAML
    fallback / generic auto-generated definition.
"""

from __future__ import annotations

import json
import os
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# 1. Mock-mode personas
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_mock_roles_ship_with_personas(monkeypatch):
    """In QUORUM_TEST_MODE every mock role has a non-empty persona."""
    monkeypatch.setenv("QUORUM_TEST_MODE", "true")
    from apps.api.architect_agent import generate_roles

    roles = await generate_roles("Test problem")

    assert len(roles) >= 4
    for role in roles:
        assert role.system_prompt.strip(), (
            f"role {role.name!r} ships with an empty system_prompt — defeats "
            "the purpose of preferring agent_configs over the generic"
        )
        assert len(role.system_prompt.split()) >= 50, (
            f"role {role.name!r} has a suspiciously short persona "
            f"({len(role.system_prompt.split())} words) — expected ~50+"
        )
        assert len(role.domain_tags) >= 5, (
            f"role {role.name!r} has only {len(role.domain_tags)} domain tags "
            "— expected 8-15"
        )
        assert 0.0 <= role.temperature <= 2.0
        assert role.model, f"role {role.name!r} has no model set"


# ---------------------------------------------------------------------------
# 2. Live-mode: single LLM call returns personas inline
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_generate_roles_parses_inline_personas(monkeypatch):
    """A single LLM call that returns persona-laden JSON should parse cleanly."""
    monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)

    fake_llm_payload = json.dumps([
        {
            "name": "Medical Principal Investigator",
            "description": "Lead clinician responsible for trial safety and design.",
            "authority_rank": 5,
            "capacity": "1",
            "suggested_prompt_focus": "Safety, scientific validity, feasibility.",
            "system_prompt": (
                "You are the Medical Principal Investigator on this trial. "
                "Your priorities are patient safety, scientific validity, and "
                "clinical feasibility. You ask hard questions about endpoints, "
                "eligibility criteria, and risk-benefit ratios. Tag your "
                "key points with [tags: ...]."
            ),
            "domain_tags": [
                "clinical_design", "patient_safety", "eligibility_criteria",
                "endpoints", "risk_benefit", "feasibility", "protocol",
                "regulatory", "ich_gcp",
            ],
            "temperature": 0.4,
            "model": "gpt-4o-mini",
        },
        {
            "name": "Statistician",
            "description": "Owns power calculations, randomization, and analysis plans.",
            "authority_rank": 3,
            "capacity": "unlimited",
            "suggested_prompt_focus": "Statistical rigor and power.",
            "system_prompt": (
                "You are the Statistician on this quorum. You evaluate power, "
                "Type I/II error, randomization, stratification, and analysis "
                "plans. You push back on under-powered designs and on "
                "post-hoc fishing. Tag your key points with [tags: ...]."
            ),
            "domain_tags": [
                "statistics", "power", "randomization", "endpoints",
                "analysis_plan", "type_i_error", "stratification",
                "missing_data",
            ],
            "temperature": 0.3,
            "model": "gpt-4o-mini",
        },
    ])

    fake_provider = MagicMock()
    fake_provider.respond = AsyncMock(return_value=(fake_llm_payload, {}))
    # If respond() is preferred we never need chat(), but stub it anyway:
    fake_provider.chat = AsyncMock(return_value=fake_llm_payload)

    from apps.api.architect_agent import generate_roles

    roles = await generate_roles(
        "Design a phase-2 oncology trial", llm_provider=fake_provider
    )

    # Exactly one LLM round-trip — no N+1 calls per role
    total_llm_calls = fake_provider.respond.await_count + fake_provider.chat.await_count
    assert total_llm_calls == 1, (
        f"Expected exactly 1 LLM call, got {total_llm_calls} — N+1 regression"
    )

    assert len(roles) == 2
    pi = roles[0]
    assert pi.name == "Medical Principal Investigator"
    assert "patient safety" in pi.system_prompt.lower()
    assert "clinical_design" in pi.domain_tags
    assert 0.2 <= pi.temperature <= 0.7
    assert pi.model == "gpt-4o-mini"


# ---------------------------------------------------------------------------
# 3. persist_agent_configs writes one row per role
# ---------------------------------------------------------------------------

class _FakeTable:
    """Fluent fake table that records every insert."""

    def __init__(self, name: str, inserts: list[dict[str, Any]]):
        self._name = name
        self._inserts = inserts
        self._last_insert: dict[str, Any] | None = None

    def insert(self, row: dict[str, Any]):
        self._last_insert = row
        return self

    def execute(self):
        if self._last_insert is not None:
            self._inserts.append({"_table": self._name, **self._last_insert})
            self._last_insert = None
        result = MagicMock()
        result.data = []
        return result

    def __getattr__(self, _name):
        # Any other fluent call (select, eq, etc.) is a no-op returning self.
        return lambda *a, **kw: self


class _FakeDB:
    def __init__(self):
        self.inserts: list[dict[str, Any]] = []

    def table(self, name: str):
        return _FakeTable(name, self.inserts)


def test_persist_agent_configs_writes_one_row_per_role():
    """persist_agent_configs inserts one agent_configs row per (role_id, suggestion)."""
    from apps.api.architect_agent import RoleSuggestion, persist_agent_configs

    db = _FakeDB()
    quorum_id = str(uuid.uuid4())
    role_a_id = str(uuid.uuid4())
    role_b_id = str(uuid.uuid4())

    assignments = [
        (
            role_a_id,
            RoleSuggestion(
                name="Researcher",
                description="...",
                authority_rank=3,
                capacity="unlimited",
                suggested_prompt_focus="...",
                system_prompt="You are the Researcher. Persona text here.",
                domain_tags=["research", "evidence", "methodology"],
                temperature=0.3,
                model="gpt-4o-mini",
            ),
        ),
        (
            role_b_id,
            RoleSuggestion(
                name="Ethicist",
                description="...",
                authority_rank=4,
                capacity="1",
                suggested_prompt_focus="...",
                system_prompt="You are the Ethicist. Persona text here.",
                domain_tags=["ethics", "consent", "compliance"],
                temperature=0.4,
                model="gpt-4o-mini",
            ),
        ),
    ]

    rows = persist_agent_configs(db, quorum_id, assignments)

    # Two rows inserted into agent_configs
    agent_config_inserts = [i for i in db.inserts if i["_table"] == "agent_configs"]
    assert len(agent_config_inserts) == 2
    assert len(rows) == 2

    by_role = {r["role_id"]: r for r in agent_config_inserts}
    assert role_a_id in by_role
    assert role_b_id in by_role

    a = by_role[role_a_id]
    assert a["system_prompt"] == "You are the Researcher. Persona text here."
    assert a["temperature"] == 0.3
    assert a["domain_tags"] == ["research", "evidence", "methodology"]
    assert a["quorum_id"] == quorum_id
    assert a["agent_slug"] == "researcher"


def test_persist_agent_configs_falls_back_to_generic_when_persona_empty():
    """If the LLM returned an empty system_prompt, we still write a row using
    a minimal generic persona so EVERY role has an agent_configs entry."""
    from apps.api.architect_agent import RoleSuggestion, persist_agent_configs

    db = _FakeDB()
    role_id = str(uuid.uuid4())
    rows = persist_agent_configs(
        db,
        "q-1",
        [
            (
                role_id,
                RoleSuggestion(
                    name="Mystery Role",
                    description="...",
                    authority_rank=3,
                    suggested_prompt_focus="Focus on widgets",
                    system_prompt="",  # intentionally empty
                ),
            )
        ],
    )

    assert len(rows) == 1
    inserted = [i for i in db.inserts if i["_table"] == "agent_configs"][0]
    assert inserted["system_prompt"], "fallback persona should not be empty"
    assert "Mystery Role" in inserted["system_prompt"]
    assert "Focus on widgets" in inserted["system_prompt"]


# ---------------------------------------------------------------------------
# 4. End-to-end: ai-start route inserts BOTH roles AND agent_configs
# ---------------------------------------------------------------------------

def test_ai_start_route_writes_roles_and_agent_configs(monkeypatch):
    """POST /events/{id}/architect/ai-start inserts one roles row AND one
    agent_configs row per role from the request body."""
    monkeypatch.setenv("QUORUM_TEST_MODE", "true")

    # Build a fake DB that records every insert across all tables
    inserts: list[dict[str, Any]] = []

    def _table_builder(name: str):
        return _FakeTable(name, inserts)

    fake_db = MagicMock()
    fake_db.table.side_effect = _table_builder

    # _fetch_single uses .single().execute(), which our _FakeTable.__getattr__
    # collapses to a no-op returning self. We need .execute() on that path to
    # return a row with id+slug for the event. Patch _fetch_single directly.
    from fastapi.testclient import TestClient

    fake_event_row = MagicMock()
    fake_event_row.data = {"id": "evt-001", "slug": "test-event"}

    def _fake_fetch_single(db, table, col, val, **kw):
        return fake_event_row

    with (
        patch("apps.api.routes.get_supabase", return_value=fake_db),
        patch("apps.api.routes._fetch_single", side_effect=_fake_fetch_single),
        patch("apps.api.seed_loader.load_seed_quorum", new=AsyncMock()),
    ):
        import importlib
        import apps.api.main as main_mod
        importlib.reload(main_mod)
        with TestClient(main_mod.app, raise_server_exceptions=False) as client:
            resp = client.post(
                "/events/evt-001/architect/ai-start",
                json={
                    "problem": "Test problem",
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
                            "capacity": "1",
                            "suggested_prompt_focus": "Identify ethical issues",
                            "system_prompt": "You are the Ethicist on this quorum.",
                            "domain_tags": ["ethics", "consent"],
                            "temperature": 0.4,
                            "model": "gpt-4o-mini",
                        },
                    ],
                    "mode": "approved",
                    "quorum_title": "Test Quorum",
                    "autonomy_level": 0.0,
                },
            )

    assert resp.status_code == 200, resp.text

    role_inserts = [i for i in inserts if i["_table"] == "roles"]
    config_inserts = [i for i in inserts if i["_table"] == "agent_configs"]

    assert len(role_inserts) == 2, (
        f"Expected 2 roles inserts, got {len(role_inserts)}: {role_inserts}"
    )
    assert len(config_inserts) == 2, (
        f"Expected 2 agent_configs inserts, got {len(config_inserts)}: "
        f"{config_inserts}"
    )

    # Verify each agent_configs row carries the persona from the request body
    by_slug = {c["agent_slug"]: c for c in config_inserts}
    assert "researcher" in by_slug
    assert "ethicist" in by_slug
    assert (
        by_slug["researcher"]["system_prompt"]
        == "You are the Researcher on this quorum."
    )
    assert by_slug["researcher"]["temperature"] == 0.3
    assert by_slug["researcher"]["domain_tags"] == ["research", "evidence"]
    assert (
        by_slug["ethicist"]["system_prompt"]
        == "You are the Ethicist on this quorum."
    )

    # Each agent_configs row must reference an actually-inserted role_id
    role_ids = {r["id"] for r in role_inserts}
    config_role_ids = {c["role_id"] for c in config_inserts}
    assert config_role_ids == role_ids, (
        "agent_configs.role_id values must match the just-inserted roles"
    )


# ---------------------------------------------------------------------------
# 5. agents.load_agent prefers agent_configs over generic fallback
# ---------------------------------------------------------------------------

def test_load_agent_prefers_agent_configs_when_row_exists():
    """When an agent_configs row exists for the role_id, load_agent uses it."""
    from apps.api.agents import load_agent

    persona = "You are the Researcher. Evidence quality is everything."
    fake_row = {
        "system_prompt": persona,
        "temperature": 0.3,
        "max_tokens": 2048,
        "domain_tags": ["research", "evidence", "methodology"],
        "agent_slug": "researcher",
    }

    fake_db = MagicMock()
    chain = MagicMock()
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.limit.return_value = chain
    result = MagicMock()
    result.data = [fake_row]
    chain.execute.return_value = result
    fake_db.table.return_value = chain

    defn = load_agent("researcher", role_id="role-abc", db=fake_db)

    assert defn.instructions == persona
    assert defn.temperature == 0.3
    assert defn.max_tokens == 2048
    assert defn.domain_tags == ["research", "evidence", "methodology"]


def test_load_agent_falls_through_when_agent_configs_empty():
    """When no agent_configs row exists, load_agent returns the generic
    auto-generated definition (NOT raises) — preserves the old behavior."""
    from apps.api.agents import load_agent

    fake_db = MagicMock()
    chain = MagicMock()
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.limit.return_value = chain
    result = MagicMock()
    result.data = []  # no rows
    chain.execute.return_value = result
    fake_db.table.return_value = chain

    defn = load_agent("patient_advocate", role_id="role-xyz", db=fake_db)

    assert defn.name == "Patient Advocate"
    # Generic fallback instructions mention the role name
    assert "Patient Advocate" in defn.instructions
    # And come with the inferred tag set
    assert "patient" in defn.domain_tags


def test_load_agent_works_without_role_id_or_db():
    """Legacy single-arg signature still produces the generic definition."""
    from apps.api.agents import load_agent

    defn = load_agent("researcher")
    assert defn.name == "Researcher"
    assert "Researcher" in defn.instructions


# ---------------------------------------------------------------------------
# 6. Empty-domain_tags retry + keyword fallback
# ---------------------------------------------------------------------------
# Regression: production quorum 1ff1ac0b-9816-4478-a783-a2166615a914 shipped
# a role ("Data Modeling & Architecture Strategist") with domain_tags=[] from
# the architect LLM, which made every affinity score involving that role
# return 0.  The fix retries the full generate_roles call once, then
# backfills any remaining empty roles with keyword-extracted tags.

def test_keyword_fallback_tags_produces_canonical_tags():
    """_keyword_fallback_tags extracts tokens from name+focus and canonicalizes them."""
    from apps.api.architect_agent import _keyword_fallback_tags

    tags = _keyword_fallback_tags(
        name="Data Modeling & Architecture Strategist",
        focus="Design data models for cross-functional analytics platform.",
    )

    assert len(tags) >= 3, f"expected >=3 fallback tags, got {tags}"
    # Canonicalized form: lowercase snake_case, no punctuation
    for tag in tags:
        assert tag == tag.lower(), f"tag {tag!r} not lowercase"
        assert " " not in tag, f"tag {tag!r} contains space"
    # The most-frequent role-defining tokens should appear
    assert "data" in tags
    assert "modeling" in tags
    assert "architecture" in tags


def test_keyword_fallback_returns_empty_for_empty_inputs():
    """_keyword_fallback_tags returns [] when name+focus are empty/whitespace."""
    from apps.api.architect_agent import _keyword_fallback_tags

    assert _keyword_fallback_tags("", "") == []
    assert _keyword_fallback_tags("   ", "  ") == []


def test_backfill_empty_tags_fills_only_missing_roles(caplog):
    """_backfill_empty_tags backfills empty roles but leaves populated roles alone."""
    import logging

    from apps.api.architect_agent import RoleSuggestion, _backfill_empty_tags

    good_role = RoleSuggestion(
        name="Statistician",
        description="Owns power calculations.",
        authority_rank=3,
        suggested_prompt_focus="Statistical rigor.",
        system_prompt="You are the Statistician.",
        domain_tags=["statistics", "power", "randomization"],
        temperature=0.3,
    )
    broken_role = RoleSuggestion(
        name="Data Modeling & Architecture Strategist",
        description="Owns the data model.",
        authority_rank=4,
        suggested_prompt_focus="Design data models for analytics.",
        system_prompt="You are the Strategist.",
        domain_tags=[],  # LLM dropped the tags
        temperature=0.4,
    )

    with caplog.at_level(logging.WARNING):
        backfilled = _backfill_empty_tags([good_role, broken_role], label="test")

    # Only the broken role gets backfilled
    assert backfilled == 1
    assert good_role.domain_tags == ["statistics", "power", "randomization"]
    assert len(broken_role.domain_tags) >= 3
    assert "data" in broken_role.domain_tags
    # A WARNING should fire so operators can see which role got patched
    assert any(
        "Data Modeling" in rec.getMessage() and "empty domain_tags" in rec.getMessage()
        for rec in caplog.records
    ), f"expected WARNING for backfilled role; got: {[r.getMessage() for r in caplog.records]}"


@pytest.mark.asyncio
async def test_generate_roles_retries_when_any_role_has_empty_tags(monkeypatch, caplog):
    """generate_roles_with_title retries the FULL call once if any role lacks tags."""
    import logging

    monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)

    from apps.api.architect_agent import (
        RoleSuggestion,
        RoleSuggestionList,
        generate_roles_with_title,
    )
    from quorum_llm.interface import LLMProvider

    first_response = RoleSuggestionList(
        roles=[
            RoleSuggestion(
                name="Good Role",
                description="Has tags.",
                authority_rank=3,
                suggested_prompt_focus="Be useful.",
                system_prompt="You are Good Role.",
                domain_tags=["alpha", "beta", "gamma"],
                temperature=0.3,
            ),
            RoleSuggestion(
                name="Broken Role",
                description="Missing tags.",
                authority_rank=2,
                suggested_prompt_focus="Owns the data model strategy.",
                system_prompt="You are Broken Role.",
                domain_tags=[],  # bug: empty
                temperature=0.3,
            ),
        ],
        short_title="Initial Title",
    )
    second_response = RoleSuggestionList(
        roles=[
            RoleSuggestion(
                name="Good Role",
                description="Has tags.",
                authority_rank=3,
                suggested_prompt_focus="Be useful.",
                system_prompt="You are Good Role.",
                domain_tags=["alpha", "beta", "gamma"],
                temperature=0.3,
            ),
            RoleSuggestion(
                name="Broken Role",
                description="Now has tags.",
                authority_rank=2,
                suggested_prompt_focus="Owns the data model strategy.",
                system_prompt="You are Broken Role.",
                domain_tags=["data", "model", "strategy"],  # retry filled them in
                temperature=0.3,
            ),
        ],
        short_title="Retry Title",
    )

    call_count = {"n": 0}

    # Subclass LLMProvider so _provider_supports_run_typed returns True
    class _FakeTypedProvider(LLMProvider):
        async def complete(self, prompt, tier):
            return ""

        async def embed(self, text):
            return []

        async def run_typed(self, *args, **kwargs):
            call_count["n"] += 1
            return first_response if call_count["n"] == 1 else second_response

    with caplog.at_level(logging.WARNING):
        roles, short_title = await generate_roles_with_title(
            "Design a data platform", llm_provider=_FakeTypedProvider()
        )

    # The full call was retried exactly once (2 total invocations)
    assert call_count["n"] == 2, f"expected 2 LLM calls, got {call_count['n']}"

    # Retry results are used (Broken Role now has tags from retry, not fallback)
    by_name = {r.name: r for r in roles}
    assert by_name["Broken Role"].domain_tags == ["data", "model", "strategy"]
    assert by_name["Good Role"].domain_tags == ["alpha", "beta", "gamma"]
    # Retry's non-empty short_title is used
    assert short_title == "Retry Title"

    # WARNING was emitted about the empty tags before the retry
    assert any(
        "empty" in rec.getMessage().lower() and "retrying" in rec.getMessage().lower()
        for rec in caplog.records
    )


@pytest.mark.asyncio
async def test_generate_roles_falls_back_to_keywords_when_retry_also_empty(
    monkeypatch, caplog
):
    """If both LLM calls return empty tags, keyword extraction fills them in."""
    import logging

    monkeypatch.delenv("QUORUM_TEST_MODE", raising=False)

    from apps.api.architect_agent import (
        RoleSuggestion,
        RoleSuggestionList,
        generate_roles_with_title,
    )
    from quorum_llm.interface import LLMProvider

    empty_response = RoleSuggestionList(
        roles=[
            RoleSuggestion(
                name="Data Modeling Strategist",
                description="Owns the data model.",
                authority_rank=4,
                suggested_prompt_focus="Design data models for analytics.",
                system_prompt="You are the Strategist.",
                domain_tags=[],  # both calls fail
                temperature=0.4,
            )
        ],
        short_title="Strategy Quorum",
    )

    class _FakeTypedProvider(LLMProvider):
        async def complete(self, prompt, tier):
            return ""

        async def embed(self, text):
            return []

        async def run_typed(self, *args, **kwargs):
            return empty_response

    with caplog.at_level(logging.WARNING):
        roles, _ = await generate_roles_with_title(
            "Design a data platform", llm_provider=_FakeTypedProvider()
        )

    assert len(roles) == 1
    role = roles[0]
    # Keyword fallback filled the tags
    assert len(role.domain_tags) >= 3, (
        f"keyword fallback should yield >=3 tags, got {role.domain_tags}"
    )
    assert "data" in role.domain_tags
    # A WARNING was emitted naming the role we backfilled
    assert any(
        "Data Modeling Strategist" in rec.getMessage()
        and "keyword-extracted" in rec.getMessage()
        for rec in caplog.records
    ), f"expected backfill WARNING; got: {[r.getMessage() for r in caplog.records]}"


def test_persist_agent_configs_backfills_empty_domain_tags(caplog):
    """persist_agent_configs also applies the keyword fallback (defense in depth).

    The ai-start route accepts RoleSuggestion objects from the request body
    (the architect UI sends them after the user reviews/edits), so a role
    with domain_tags=[] can reach persist_agent_configs even if
    generate_roles_with_title already backfilled.
    """
    import logging

    from apps.api.architect_agent import RoleSuggestion, persist_agent_configs

    db = _FakeDB()
    role_id = str(uuid.uuid4())

    with caplog.at_level(logging.WARNING):
        rows = persist_agent_configs(
            db,
            "q-1",
            [
                (
                    role_id,
                    RoleSuggestion(
                        name="Data Modeling & Architecture Strategist",
                        description="Owns the data model.",
                        authority_rank=4,
                        suggested_prompt_focus="Design data models for analytics.",
                        system_prompt="You are the Strategist.",
                        domain_tags=[],  # bug from upstream
                        temperature=0.4,
                    ),
                )
            ],
        )

    assert len(rows) == 1
    inserted = [i for i in db.inserts if i["_table"] == "agent_configs"][0]
    assert len(inserted["domain_tags"]) >= 3
    assert "data" in inserted["domain_tags"]
    # WARNING was logged
    assert any(
        "empty domain_tags" in rec.getMessage() and "keyword-extracted" in rec.getMessage()
        for rec in caplog.records
    )
