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
        fixture = _load_fixture()
        case = fixture["cases"][2]  # all_roles_contributing
        score, metrics = calculate_health_score(
            case["roles"], case["contributions"], case["artifact"]
        )
        lo, hi = case["expected_score_range"]
        assert lo <= score <= hi, f"Score {score} not in range [{lo}, {hi}]"
        assert metrics["role_coverage_pct"] == 100.0

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
