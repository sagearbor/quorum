"""Unit tests for ``quorum_llm.metric_deltas``.

Covers the parser (``extract_score_deltas``), the running-total accumulator
(``apply_deltas_to_running_total``), and the rationale buffer
(``append_rationale``).
"""

from __future__ import annotations

import pytest

from quorum_llm.metric_deltas import (
    CUMULATIVE_MAX,
    CUMULATIVE_MIN,
    DECAY_FACTOR,
    SHORT_TO_COLUMN,
    append_rationale,
    apply_deltas_to_running_total,
    extract_score_deltas,
)


# ---------------------------------------------------------------------------
# Parser — extract_score_deltas
# ---------------------------------------------------------------------------


def test_parser_basic_block():
    """A canonical block produces the expected dict and no rationale."""
    text = "I think we should pause. [scores: consensus=-10, blockers=+5]"
    deltas, why = extract_score_deltas(text)
    assert deltas == {"consensus": -10.0, "blockers": 5.0}
    assert why is None


def test_parser_all_five_keys():
    text = (
        "[scores: consensus=+8, completion=+3, role_coverage=-2, "
        "critical_path=+4, blockers=-7]"
    )
    deltas, _ = extract_score_deltas(text)
    assert deltas == {
        "consensus": 8.0,
        "completion": 3.0,
        "role_coverage": -2.0,
        "critical_path": 4.0,
        "blockers": -7.0,
    }


def test_parser_clamps_per_turn():
    """Out-of-range values are clamped to [-20, 20]."""
    text = "[scores: consensus=+50, blockers=-100, completion=+15]"
    deltas, _ = extract_score_deltas(text)
    assert deltas["consensus"] == 20.0
    assert deltas["blockers"] == -20.0
    # In-range values pass through.
    assert deltas["completion"] == 15.0


def test_parser_drops_unknown_keys():
    """Unknown metric keys are silently dropped (forward compat)."""
    text = "[scores: consensus=+5, foobar=+99, completion=-3]"
    deltas, _ = extract_score_deltas(text)
    assert deltas == {"consensus": 5.0, "completion": -3.0}


def test_parser_with_rationale():
    text = (
        "I'm worried about consent. "
        "[scores: blockers=+8, consensus=-5] "
        "[scores-why: IRB flagged a missing assent form for minors]"
    )
    deltas, why = extract_score_deltas(text)
    assert deltas == {"blockers": 8.0, "consensus": -5.0}
    assert why == "IRB flagged a missing assent form for minors"


def test_parser_rationale_truncated_to_100_chars():
    long = "x" * 200
    text = f"[scores: consensus=+1] [scores-why: {long}]"
    _, why = extract_score_deltas(text)
    assert why is not None
    assert len(why) == 100


def test_parser_empty_block_returns_empty():
    """An empty or absent block produces no deltas."""
    assert extract_score_deltas("") == ({}, None)
    assert extract_score_deltas("just some text") == ({}, None)
    deltas, why = extract_score_deltas("[scores: ]")
    assert deltas == {}
    assert why is None


def test_parser_tolerates_messy_formatting():
    """Permissive whitespace, +prefix, decimal values, case-insensitive keys."""
    text = "  [SCORES:  Consensus = +7.5 ,  BLOCKERS:-3   ]  "
    deltas, _ = extract_score_deltas(text)
    assert deltas == {"consensus": 7.5, "blockers": -3.0}


def test_parser_takes_last_block_when_multiple():
    """When the LLM repeats itself, the LAST block wins (matches tag policy)."""
    text = "[scores: consensus=+1] then later [scores: consensus=-9, blockers=+2]"
    deltas, _ = extract_score_deltas(text)
    assert deltas == {"consensus": -9.0, "blockers": 2.0}


def test_parser_scores_why_does_not_match_scores():
    """[scores-why: ...] alone (no [scores: ...]) yields no deltas, only rationale."""
    text = "Calm turn. [scores-why: just a check-in, no movement]"
    deltas, why = extract_score_deltas(text)
    assert deltas == {}
    assert why == "just a check-in, no movement"


def test_parser_handles_invalid_numbers():
    """Non-numeric values are dropped without breaking the whole parse."""
    text = "[scores: consensus=hello, completion=+4]"
    deltas, _ = extract_score_deltas(text)
    assert deltas == {"completion": 4.0}


def test_short_to_column_mapping_covers_all_five_metrics():
    """Sanity: the short-key map matches the canonical 5-metric column names."""
    expected_columns = {
        "consensus_score",
        "completion_pct",
        "role_coverage_pct",
        "critical_path_score",
        "blocker_score",
    }
    assert set(SHORT_TO_COLUMN.values()) == expected_columns


# ---------------------------------------------------------------------------
# Running total — apply_deltas_to_running_total
# ---------------------------------------------------------------------------


def test_running_total_decay_applied_before_addition():
    """Existing value × 0.8, then new delta added."""
    existing = {"consensus": 10.0}
    new = {"consensus": 5.0}
    out = apply_deltas_to_running_total(existing, new)
    assert out["consensus"] == pytest.approx(10.0 * DECAY_FACTOR + 5.0)


def test_running_total_decay_alone_no_new_deltas():
    """With no new deltas, existing values simply decay 20%."""
    existing = {"blockers": -20.0}
    out = apply_deltas_to_running_total(existing, {})
    assert out["blockers"] == pytest.approx(-20.0 * DECAY_FACTOR)


def test_running_total_clamps_cumulative():
    """Cumulative bounds are tighter than per-turn — repeated big deltas saturate."""
    existing = {"consensus": 45.0}
    out = apply_deltas_to_running_total(existing, {"consensus": 20.0})
    # 45 * 0.8 = 36 + 20 = 56 → clamped to CUMULATIVE_MAX (50).
    assert out["consensus"] == CUMULATIVE_MAX


def test_running_total_clamps_cumulative_negative():
    existing = {"blockers": -45.0}
    out = apply_deltas_to_running_total(existing, {"blockers": -20.0})
    # -45 * 0.8 = -36 + -20 = -56 → clamped to CUMULATIVE_MIN (-50).
    assert out["blockers"] == CUMULATIVE_MIN


def test_running_total_handles_none_existing():
    out = apply_deltas_to_running_total(None, {"consensus": 5.0})
    assert out == {"consensus": 5.0}


def test_running_total_preserves_unknown_keys():
    """Forward-compat: unknown keys already in the column survive decay."""
    existing = {"some_future_metric": 10.0}
    out = apply_deltas_to_running_total(existing, {})
    assert "some_future_metric" in out
    assert out["some_future_metric"] == pytest.approx(8.0)


def test_running_total_drops_non_numeric_existing():
    """Defensive: a hand-edited row with a string value won't crash."""
    existing = {"consensus": "not a number", "blockers": 5.0}
    out = apply_deltas_to_running_total(existing, {"consensus": 3.0})
    # "not a number" dropped, then 3.0 added fresh; blockers decayed.
    assert out["consensus"] == 3.0
    assert out["blockers"] == pytest.approx(4.0)


# ---------------------------------------------------------------------------
# Rationale buffer — append_rationale
# ---------------------------------------------------------------------------


def test_append_rationale_one_entry_per_nonzero_delta():
    out = append_rationale(
        [],
        ts="2026-05-18T12:00:00Z",
        deltas={"consensus": -5.0, "blockers": 3.0, "completion": 0.0},
        why="something happened",
    )
    # Two entries (zero delta omitted), same ts + why.
    assert len(out) == 2
    metrics = {entry["metric"] for entry in out}
    assert metrics == {"consensus", "blockers"}
    assert all(e["why"] == "something happened" for e in out)


def test_append_rationale_ring_buffer_cap():
    """When length exceeds max_entries, oldest entries are dropped."""
    existing = [{"ts": str(i), "metric": "consensus", "delta": 1.0, "why": None} for i in range(20)]
    out = append_rationale(
        existing,
        ts="2026-05-18T12:00:00Z",
        deltas={"consensus": 5.0},
        why="new",
        max_entries=20,
    )
    assert len(out) == 20
    # The newest entry is the last, and the oldest existing entry was dropped.
    assert out[-1]["why"] == "new"
    assert out[0]["ts"] != "0"


def test_append_rationale_skips_when_no_nonzero_deltas():
    out = append_rationale([], ts="t", deltas={}, why="anything")
    assert out == []
