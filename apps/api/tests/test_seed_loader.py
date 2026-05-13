"""Smoke tests for seed JSON files.

These tests validate the schema of every seed file in `seed/` so that the seed
loader (which is invoked at FastAPI startup when QUORUM_TEST_MODE=true) can
successfully insert them into Supabase. They are pure schema/sanity checks —
they do not require Supabase or any external service.

Each new seed should be added to SEED_FILES below.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

# Project root: <repo>/seed/
SEED_DIR = Path(__file__).resolve().parents[3] / "seed"

SEED_FILES = [
    "clinical-trial.json",
    "tumor-board.json",
    "faculty-hiring.json",
    "pandemic-response.json",
]


def _load(name: str) -> dict:
    path = SEED_DIR / name
    assert path.exists(), f"Seed file missing: {path}"
    with open(path) as f:
        return json.load(f)


@pytest.mark.parametrize("seed_name", SEED_FILES)
def test_seed_file_loads_and_has_required_top_level_keys(seed_name: str) -> None:
    """Every seed file is valid JSON with `event` and `quorums` top-level keys."""
    seed = _load(seed_name)
    assert "event" in seed, f"{seed_name} missing 'event' top-level key"
    assert "quorums" in seed, f"{seed_name} missing 'quorums' top-level key"
    assert isinstance(seed["quorums"], list)
    assert len(seed["quorums"]) >= 1, f"{seed_name} has no quorums"


@pytest.mark.parametrize("seed_name", SEED_FILES)
def test_seed_event_has_required_fields(seed_name: str) -> None:
    """Event block must have id, name, slug, access_code, max_active_quorums, created_by."""
    seed = _load(seed_name)
    event = seed["event"]
    for field in ("id", "name", "slug", "access_code", "max_active_quorums", "created_by"):
        assert field in event, f"{seed_name} event missing field: {field}"
    assert isinstance(event["max_active_quorums"], int)
    assert event["max_active_quorums"] >= 1


@pytest.mark.parametrize("seed_name", SEED_FILES)
def test_each_quorum_has_required_structure(seed_name: str) -> None:
    """Every quorum has id, event_id, title, description, status, heat_score,
    dashboard_types, carousel_mode, roles."""
    seed = _load(seed_name)
    for quorum in seed["quorums"]:
        for field in (
            "id", "event_id", "title", "description", "status",
            "heat_score", "dashboard_types", "carousel_mode", "roles",
        ):
            assert field in quorum, f"{seed_name} quorum missing field: {field}"
        assert quorum["event_id"] == seed["event"]["id"], (
            f"{seed_name} quorum {quorum['id']} event_id mismatch"
        )
        assert isinstance(quorum["dashboard_types"], list)
        assert isinstance(quorum["roles"], list)


@pytest.mark.parametrize("seed_name", [
    "tumor-board.json",
    "faculty-hiring.json",
    "pandemic-response.json",
])
def test_new_seeds_have_substantive_role_count(seed_name: str) -> None:
    """New Duke seeds should have >3 roles per quorum (this is the contrast point
    that makes them interesting demos vs the existing clinical-trial seed)."""
    seed = _load(seed_name)
    for quorum in seed["quorums"]:
        assert len(quorum["roles"]) > 3, (
            f"{seed_name} quorum {quorum['title']!r} has only "
            f"{len(quorum['roles'])} roles — need >3 for a compelling demo"
        )


@pytest.mark.parametrize("seed_name", SEED_FILES)
def test_every_role_has_prompt_template(seed_name: str) -> None:
    """Each role must have a non-empty prompt_template list of {field_name, prompt}
    objects. This is the persona seed that drives the architect's agent config."""
    seed = _load(seed_name)
    for quorum in seed["quorums"]:
        for role in quorum["roles"]:
            assert "prompt_template" in role, (
                f"{seed_name} role {role.get('name')!r} missing prompt_template"
            )
            assert isinstance(role["prompt_template"], list)
            assert len(role["prompt_template"]) > 0, (
                f"{seed_name} role {role['name']!r} has empty prompt_template"
            )
            for entry in role["prompt_template"]:
                assert "field_name" in entry and "prompt" in entry, (
                    f"{seed_name} role {role['name']!r} has malformed "
                    f"prompt_template entry: {entry!r}"
                )
                assert entry["field_name"], "field_name must be non-empty"
                assert entry["prompt"], "prompt must be non-empty"


@pytest.mark.parametrize("seed_name", SEED_FILES)
def test_every_role_has_authority_rank_and_capacity(seed_name: str) -> None:
    """authority_rank must be int 1-5. capacity must be 1 or 'unlimited'."""
    seed = _load(seed_name)
    for quorum in seed["quorums"]:
        for role in quorum["roles"]:
            assert "authority_rank" in role
            assert 1 <= role["authority_rank"] <= 5, (
                f"{seed_name} role {role['name']!r} authority_rank "
                f"{role['authority_rank']} out of range"
            )
            assert "capacity" in role
            assert role["capacity"] == 1 or role["capacity"] == "unlimited", (
                f"{seed_name} role {role['name']!r} capacity must be 1 or "
                f"'unlimited' (got {role['capacity']!r})"
            )


@pytest.mark.parametrize("seed_name", [
    "tumor-board.json",
    "faculty-hiring.json",
    "pandemic-response.json",
])
def test_new_seeds_have_at_least_one_contribution(seed_name: str) -> None:
    """New demo seeds should ship with seed contributions so the demo doesn't
    start from an empty quorum at the expo."""
    seed = _load(seed_name)
    total_contribs = sum(
        len(q.get("contributions", [])) for q in seed["quorums"]
    )
    assert total_contribs >= 1, (
        f"{seed_name} has zero seed contributions — at least one needed"
    )


@pytest.mark.parametrize("seed_name", SEED_FILES)
def test_contribution_role_ids_resolve(seed_name: str) -> None:
    """Every contribution.role_id must match a role.id within the same quorum."""
    seed = _load(seed_name)
    for quorum in seed["quorums"]:
        role_ids = {r["id"] for r in quorum["roles"]}
        for contrib in quorum.get("contributions", []):
            assert contrib["role_id"] in role_ids, (
                f"{seed_name} quorum {quorum['title']!r} contribution "
                f"{contrib['id']} references unknown role_id {contrib['role_id']}"
            )


def test_seed_event_ids_are_unique() -> None:
    """No two seed files should claim the same event id — otherwise the loader's
    idempotency check would treat them as duplicates."""
    event_ids = []
    for name in SEED_FILES:
        seed = _load(name)
        event_ids.append((name, seed["event"]["id"]))
    seen: dict[str, str] = {}
    for name, eid in event_ids:
        assert eid not in seen, (
            f"Event id collision: {name} and {seen[eid]} both claim {eid}"
        )
        seen[eid] = name
