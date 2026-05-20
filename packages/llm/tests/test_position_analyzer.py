"""Tests for :mod:`quorum_llm.position_analyzer`.

Covers the behaviours the routes layer relies on:

* Valid output from the mock provider returns a clean :class:`PositionSnapshot`.
* Driver IDs that aren't in the supplied contribution list are dropped from
  the row's ``drivers`` (without dropping the row itself — we want to keep
  partial signal at expo time).
* Rows with empty ``field`` are dropped entirely.
* ``stage="initial"`` forces ``changed=False`` and ``before=after`` even
  when the LLM ignores the system prompt.
* ``key_aspects`` longer than 12 are clamped to 12.
"""

from __future__ import annotations

import pytest

from quorum_llm.models import Contribution, LLMTier, Role
from quorum_llm.position_analyzer import (
    FieldChange,
    PositionSnapshot,
    _validate_snapshot,
    synthesize_position,
)
from quorum_llm.providers.mock import MockLLMProvider


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _roles() -> list[Role]:
    return [
        Role(id="role-pi", name="Principal Investigator", authority_rank=2),
        Role(id="role-irb", name="IRB", authority_rank=5),
    ]


def _contribs() -> list[Contribution]:
    return [
        Contribution(
            id="contrib-a",
            role_id="role-pi",
            content="Propose a 12-week dosing interval for the trial.",
        ),
        Contribution(
            id="contrib-b",
            role_id="role-irb",
            content="IRB requires a 6-week safety review checkpoint.",
        ),
        Contribution(
            id="contrib-c",
            role_id="role-pi",
            content="Accept the IRB recommendation; revise dosing protocol.",
        ),
    ]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_synthesize_position_final_returns_valid_snapshot():
    """End-to-end: mock provider yields a clean PositionSnapshot for stage=final."""
    provider = MockLLMProvider()
    snap = await synthesize_position(
        role_definitions=_roles(),
        contributions=_contribs(),
        chats=[],
        stage="final",
        llm_provider=provider,
    )
    assert isinstance(snap, PositionSnapshot)
    # 3 summary sentences guaranteed.
    assert len(snap.summary_sentences) == 3
    # Headline <= 80 chars.
    assert len(snap.headline) <= 80
    # All 3 mock aspects survive (none have empty fields).
    assert len(snap.key_aspects) == 3
    # All surviving rows have non-empty field.
    assert all(row.field for row in snap.key_aspects)
    # AGENT_CHAT tier per spec.
    typed_calls = [c for c in provider.call_log if c.get("output_type") == "PositionSnapshot"]
    assert typed_calls, f"Expected a PositionSnapshot typed call, got: {provider.call_log}"
    assert typed_calls[0]["tier"] == int(LLMTier.AGENT_CHAT)


@pytest.mark.asyncio
async def test_synthesize_position_drops_unknown_driver_ids():
    """Drivers not in the supplied contribution list are stripped from the row."""
    provider = MockLLMProvider()
    snap = await synthesize_position(
        role_definitions=_roles(),
        contributions=_contribs(),
        chats=[],
        stage="final",
        llm_provider=provider,
    )
    valid_ids = {c.id for c in _contribs()}
    for row in snap.key_aspects:
        for driver in row.drivers:
            assert driver in valid_ids, (
                f"Driver {driver!r} on field {row.field!r} is not in the "
                f"valid contribution list — validator failed to strip it."
            )
    # The consent_requirement row in the mock injects "bogus-id-does-not-exist"
    # alongside a real ID — verify the real ID survives.
    consent_row = next(
        (r for r in snap.key_aspects if r.field == "consent_requirement"),
        None,
    )
    assert consent_row is not None, "consent_requirement row should survive"
    assert "bogus-id-does-not-exist" not in consent_row.drivers
    assert "contrib-a" in consent_row.drivers


@pytest.mark.asyncio
async def test_synthesize_position_initial_forces_changed_false():
    """Stage=initial must force changed=False and before=after on every row."""
    provider = MockLLMProvider()
    snap = await synthesize_position(
        role_definitions=_roles(),
        contributions=_contribs(),
        chats=[],
        stage="initial",
        llm_provider=provider,
    )
    # The mock emits changed=True on all rows; the validator must rewrite.
    for row in snap.key_aspects:
        assert row.changed is False, (
            f"Initial-stage row {row.field!r} has changed=True; validator failed."
        )
        assert row.before == row.after, (
            f"Initial-stage row {row.field!r}: before={row.before!r} != "
            f"after={row.after!r}"
        )


def test_validator_clamps_key_aspects_to_max():
    """Snapshots with more than 12 key_aspects are clamped to 12."""
    contribs = _contribs()
    valid_ids = [c.id for c in contribs]
    # Build a snapshot with 20 valid aspects.
    aspects = [
        FieldChange(
            field=f"field_{i}",
            before="old",
            after="new",
            changed=True,
            drivers=[contribs[0].id],
        )
        for i in range(20)
    ]
    raw = PositionSnapshot(
        summary_sentences=["a sentence.", "b sentence.", "c sentence."],
        headline="test headline",
        key_aspects=aspects[:12],  # Pydantic max_length=12 on construction
        unresolved=[],
    )
    # Force-feed extras past the Pydantic guard by mutating the instance —
    # we want to verify _validate_snapshot's own clamp, not Pydantic's.
    object.__setattr__(raw, "key_aspects", aspects)
    cleaned = _validate_snapshot(raw, valid_ids, stage="final")
    assert len(cleaned.key_aspects) == 12, (
        f"Expected 12 key_aspects after clamp, got {len(cleaned.key_aspects)}"
    )


def test_validator_drops_rows_with_empty_field():
    """Rows where `field` is empty/whitespace are dropped wholesale."""
    contribs = _contribs()
    valid_ids = [c.id for c in contribs]
    aspects = [
        FieldChange(field="scope", before="a", after="b", changed=True, drivers=[]),
        # Build a row with whitespace-only field by bypassing Pydantic's
        # min_length guard via construct().
        FieldChange.model_construct(
            field="   ", before="a", after="b", changed=True, drivers=[]
        ),
        FieldChange(field="cadence", before="c", after="d", changed=True, drivers=[]),
    ]
    raw = PositionSnapshot.model_construct(
        summary_sentences=["a.", "b.", "c."],
        headline="hl",
        key_aspects=aspects,
        unresolved=[],
    )
    cleaned = _validate_snapshot(raw, valid_ids, stage="final")
    fields = [r.field for r in cleaned.key_aspects]
    assert "scope" in fields
    assert "cadence" in fields
    # No whitespace-only field survived.
    assert all(f.strip() for f in fields)
