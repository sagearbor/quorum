"""Tests for health score calculation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps"))

from api.health import calculate_health_score

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _load_fixture():
    with open(FIXTURES / "health_score.json") as f:
        return json.load(f)


class TestHealthScore:
    def test_empty_quorum_low_score(self):
        fixture = _load_fixture()
        case = fixture["cases"][0]  # empty_quorum
        score, metrics = calculate_health_score(
            case["roles"], case["contributions"], case["artifact"]
        )
        lo, hi = case["expected_score_range"]
        assert lo <= score <= hi, f"Score {score} not in range [{lo}, {hi}]"
        assert metrics["role_coverage_pct"] == 0.0

    def test_partial_coverage(self):
        fixture = _load_fixture()
        case = fixture["cases"][1]  # one_role_contributing
        score, metrics = calculate_health_score(
            case["roles"], case["contributions"], case["artifact"]
        )
        lo, hi = case["expected_score_range"]
        assert lo <= score <= hi, f"Score {score} not in range [{lo}, {hi}]"
        assert metrics["role_coverage_pct"] > 0
        assert metrics["role_coverage_pct"] < 100

    def test_full_coverage(self):
        """Every role contributed once → role coverage is NON-ZERO but capped.

        Post-tightening (PR #92): single-contribution-per-role no longer
        saturates role_coverage_pct.  100 now requires SUBSTANTIVE engagement
        (>=3 contributions per role) AND the highest-authority role present.
        With only one contribution per role we should land at or below the
        partial-coverage cap (80) — confirming the saturation fix.
        """
        fixture = _load_fixture()
        case = fixture["cases"][2]  # all_roles_contributing
        score, metrics = calculate_health_score(
            case["roles"], case["contributions"], case["artifact"]
        )
        lo, hi = case["expected_score_range"]
        assert lo <= score <= hi, f"Score {score} not in range [{lo}, {hi}]"
        # Every role represented but only once each → above zero, below cap.
        assert 0 < metrics["role_coverage_pct"] <= 80.0

    def test_score_monotonically_increases(self):
        """More contributions from more roles should increase score."""
        fixture = _load_fixture()
        scores = []
        for case in fixture["cases"]:
            score, _ = calculate_health_score(
                case["roles"], case["contributions"], case["artifact"]
            )
            scores.append(score)
        # Empty < partial < full
        assert scores[0] < scores[1] < scores[2]

    def test_blocker_score_penalizes_missing_single_roles(self):
        roles = [
            {"id": "r1", "name": "PI", "authority_rank": 2, "capacity": "1"},
            {"id": "r2", "name": "IRB", "authority_rank": 3, "capacity": "1"},
        ]
        # No contributions → both single-capacity roles are blockers
        _, metrics = calculate_health_score(roles, [], None)
        assert metrics["blocker_score"] < 100.0

        # One role contributing → only one blocker
        contribs = [{"id": "c1", "role_id": "r1", "content": "x", "user_token": "u1"}]
        _, metrics2 = calculate_health_score(roles, contribs, None)
        assert metrics2["blocker_score"] > metrics["blocker_score"]

    def test_consensus_bonus_for_highest_authority(self):
        roles = [
            {"id": "r1", "name": "PI", "authority_rank": 1},
            {"id": "r2", "name": "IRB", "authority_rank": 5},
        ]
        # Low-authority role only
        contribs_low = [{"id": "c1", "role_id": "r1", "content": "x", "user_token": "u1"}]
        _, metrics_low = calculate_health_score(roles, contribs_low, None)

        # High-authority role contributing
        contribs_high = [{"id": "c2", "role_id": "r2", "content": "x", "user_token": "u2"}]
        _, metrics_high = calculate_health_score(roles, contribs_high, None)

        assert metrics_high["consensus_score"] > metrics_low["consensus_score"]

    def test_no_roles_returns_zero(self):
        score, metrics = calculate_health_score([], [], None)
        assert score >= 0
        assert metrics["role_coverage_pct"] == 0.0


class TestSaturationGuard:
    """Regression suite for the PR #92 saturation tightening.

    The previous implementation saturated at 100/100/100/100/100 whenever
    every role had contributed at least once.  These tests pin down the new
    behavior:

      * "Moderate progress" (some roles spoken, no artifact) → every metric
        stays at or below 80.
      * "Complete success" (resolved artifact, ratified, no unresolved,
        substantive engagement from every role) → every metric CAN reach 100.
    """

    def _moderate_quorum_inputs(self):
        roles = [
            {"id": "r1", "name": "PI", "authority_rank": 3, "capacity": "1"},
            {"id": "r2", "name": "IRB", "authority_rank": 5, "capacity": "1"},
            {"id": "r3", "name": "Biostat", "authority_rank": 2, "capacity": "unlimited"},
            {"id": "r4", "name": "Patient", "authority_rank": 1, "capacity": "unlimited"},
        ]
        # 3 contributions total, 2 of 4 roles spoken.
        contributions = [
            {"id": "c1", "role_id": "r1", "content": "x", "user_token": "u1",
             "structured_fields": {}},
            {"id": "c2", "role_id": "r1", "content": "x", "user_token": "u1",
             "structured_fields": {}},
            {"id": "c3", "role_id": "r3", "content": "x", "user_token": "u3",
             "structured_fields": {}},
        ]
        artifact = None  # no /resolve called, no position snapshot
        return roles, contributions, artifact

    def test_moderate_progress_no_metric_exceeds_80(self):
        """A live, in-flight quorum should land in the 50-80 band, not 100.

        Specifically: 3 contributions, 2 of 4 roles spoken, no artifact, no
        resolved A2A requests.  Every individual metric must stay <= 80.
        """
        roles, contribs, artifact = self._moderate_quorum_inputs()
        score, metrics = calculate_health_score(roles, contribs, artifact)

        for key, value in metrics.items():
            assert value <= 80.0, (
                f"{key} = {value} exceeds the 80 cap for a moderate quorum "
                f"(no artifact, sparse engagement). full metrics={metrics}"
            )
        # The composite must also stay below 80 since every component does.
        assert score < 80.0, f"composite {score} unexpectedly >= 80"

    def _complete_success_inputs(self):
        roles = [
            {"id": "r1", "name": "PI", "authority_rank": 3, "capacity": "1"},
            {"id": "r2", "name": "IRB", "authority_rank": 5, "capacity": "1"},
            {"id": "r3", "name": "Biostat", "authority_rank": 2, "capacity": "unlimited"},
            {"id": "r4", "name": "Patient", "authority_rank": 1, "capacity": "unlimited"},
        ]
        # 5 contributions per role → substantive across the board.  Two
        # shared structured_fields keys (``dose`` and ``arms``) appear in
        # contributions from multiple roles → consensus closure evidence.
        contributions = []
        shared_fields_a = {"dose": "10mg", "arms": 2}
        shared_fields_b = {"dose": "10mg", "arms": 2}
        for role_id in ("r1", "r2", "r3", "r4"):
            for i in range(5):
                contributions.append({
                    "id": f"{role_id}-{i}",
                    "role_id": role_id,
                    "content": "substantive contribution",
                    "user_token": role_id,
                    # Even contributions get the shared fields → ≥2 keys shared
                    # across contributions from different roles.
                    "structured_fields": shared_fields_a if i % 2 == 0 else shared_fields_b,
                })
        # Artifact: final + zero unresolved on both snapshots (initial had open
        # items, final closed them all → critical_path burndown = 1.0).
        artifact = {
            "status": "final",
            "sections": [
                {"title": "S1", "content": "full body"},
                {"title": "S2", "content": "full body"},
            ],
            "initial_position": {"unresolved": ["open question 1", "open question 2"]},
            "final_position": {"unresolved": []},
        }
        return roles, contributions, artifact

    def test_complete_success_can_reach_100(self):
        """A fully closed-out quorum must be ALLOWED to hit 100 on every metric.

        Otherwise the tightening would be just a global rescale, which the PR
        explicitly avoids: 100 should still mean "complete success".
        """
        roles, contribs, artifact = self._complete_success_inputs()
        score, metrics = calculate_health_score(roles, contribs, artifact)

        # Every metric must reach 100 given full final-state evidence.
        for key, value in metrics.items():
            assert value == 100.0, (
                f"{key} = {value} failed to reach 100 even with full "
                f"complete-success evidence. full metrics={metrics}"
            )
        assert score == 100.0, f"composite {score} != 100 with full evidence"

    def test_no_artifact_caps_completion(self):
        """Activity count alone must NOT drive completion past 80."""
        roles = [{"id": "r1", "authority_rank": 1, "capacity": "1"}]
        # Drown the formula in chat activity.
        _, metrics = calculate_health_score(
            roles, [], None, activity_count=10_000
        )
        assert metrics["completion_pct"] <= 80.0

    def test_consensus_capped_without_closure(self):
        """Authority-weighted full coverage alone can't push consensus to 100."""
        roles = [
            {"id": "r1", "authority_rank": 3, "capacity": "1"},
            {"id": "r2", "authority_rank": 5, "capacity": "1"},
        ]
        contribs = [
            {"id": "c1", "role_id": "r1", "content": "x", "user_token": "u1",
             "structured_fields": {"a": 1}},
            {"id": "c2", "role_id": "r2", "content": "x", "user_token": "u2",
             "structured_fields": {"b": 2}},
        ]
        # No artifact, no shared structured_fields keys → no closure evidence.
        _, metrics = calculate_health_score(roles, contribs, None)
        assert metrics["consensus_score"] <= 75.0

    def test_critical_path_capped_without_a2a(self):
        """With zero A2A traffic / position snapshot, critical_path can't hit 100."""
        roles = [
            {"id": "r1", "authority_rank": 1, "capacity": "1"},
            {"id": "r2", "authority_rank": 1, "capacity": "1"},
        ]
        contribs = [
            {"id": f"c{i}", "role_id": rid, "content": "x", "user_token": rid,
             "structured_fields": {}}
            for rid in ("r1", "r2")
            for i in range(10)
        ]
        _, metrics = calculate_health_score(roles, contribs, None)
        assert metrics["critical_path_score"] <= 85.0

    def test_blocker_capped_without_closure(self):
        """No missing single-cap roles + no closure → blocker_score capped at 90."""
        roles = [
            {"id": "r1", "authority_rank": 1, "capacity": "unlimited"},
            {"id": "r2", "authority_rank": 1, "capacity": "unlimited"},
        ]
        contribs = [
            {"id": "c1", "role_id": "r1", "content": "x", "user_token": "u1",
             "structured_fields": {}},
        ]
        # No artifact → no closure evidence.
        _, metrics = calculate_health_score(roles, contribs, None)
        assert metrics["blocker_score"] <= 90.0
