"""Tests for :mod:`quorum_llm.contribution_analyzer`.

The analyzer is one structured-output LLM call per contribution that returns
``ContributionAnalysis`` (tags + per-metric deltas + rationale).  These tests
verify:

* Per-metric clamping to ``[-20, +20]`` survives model output that overshoots.
* Unknown metric keys are dropped (forward-compat — a future LLM emitting a
  novel metric must not poison the chart).
* Tag normalization (lowercase / snake_case / dedup).
* The analyzer threads through to ``run_typed`` (no manual JSON parsing).
* The mock provider's canned output is content-sensitive (so different
  contributions get distinguishable outputs in tests).
"""

from __future__ import annotations

import pytest

from quorum_llm.contribution_analyzer import (
    ContributionAnalysis,
    analyze_contribution,
)
from quorum_llm.models import LLMTier
from quorum_llm.providers.mock import MockLLMProvider


# ---------------------------------------------------------------------------
# Schema-level tests — validation + clamping
# ---------------------------------------------------------------------------


def test_analysis_tags_normalized():
    """Tags are lowercased, snake_cased, deduped — keeps the chart pills clean."""
    a = ContributionAnalysis(
        tags=["Safety", "IRB Oversight", "irb-oversight", "Consent"],
        score_deltas={},
        rationale="Tags normalize.",
    )
    # 'IRB Oversight' and 'irb-oversight' should both reduce to 'irb_oversight'.
    assert "irb_oversight" in a.tags
    # Dedup: irb_oversight appears once.
    assert a.tags.count("irb_oversight") == 1
    # Casing normalized.
    assert "safety" in a.tags
    assert "consent" in a.tags


def test_analysis_tags_min_length_enforced():
    """Pydantic enforces 3+ tags so the chart pill row never goes empty."""
    with pytest.raises(Exception):
        ContributionAnalysis(
            tags=["only_one"],
            score_deltas={},
            rationale="too few tags",
        )


def test_analysis_deltas_clamped_high():
    """LLM emitting +999 is clamped to +20 — single turn can't dominate chart."""
    a = ContributionAnalysis(
        tags=["a", "b", "c"],
        score_deltas={"consensus": 999.0, "blockers": -500.0},
        rationale="extreme deltas",
    )
    assert a.score_deltas["consensus"] == 20.0
    assert a.score_deltas["blockers"] == -20.0


def test_analysis_deltas_unknown_keys_dropped():
    """Future-proofing: unknown metric keys silently dropped, known ones kept."""
    a = ContributionAnalysis(
        tags=["a", "b", "c"],
        score_deltas={
            "consensus": 5.0,
            "completion": 3.0,
            "wibble": 99.0,            # unknown key
            "made_up_metric": -2.0,    # unknown key
        },
        rationale="forward-compat",
    )
    assert "consensus" in a.score_deltas
    assert "completion" in a.score_deltas
    assert "wibble" not in a.score_deltas
    assert "made_up_metric" not in a.score_deltas


def test_analysis_deltas_optional():
    """A contribution that moves nothing is allowed — score_deltas can be empty."""
    a = ContributionAnalysis(
        tags=["a", "b", "c"],
        score_deltas={},
        rationale="no movement",
    )
    assert a.score_deltas == {}


def test_analysis_rationale_max_length_enforced():
    """Rationale capped to 300 chars to prevent runaway hover popovers."""
    with pytest.raises(Exception):
        ContributionAnalysis(
            tags=["a", "b", "c"],
            score_deltas={},
            rationale="x" * 301,
        )


# ---------------------------------------------------------------------------
# End-to-end — analyze_contribution against MockLLMProvider
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_analyze_contribution_returns_typed_output():
    """End-to-end: analyzer threads through run_typed and returns a validated model."""
    provider = MockLLMProvider()
    analysis = await analyze_contribution(
        content="IRB requires a 6-week safety review checkpoint.",
        role_name="IRB",
        role_authority_rank=5,
        llm_provider=provider,
    )
    assert isinstance(analysis, ContributionAnalysis)
    # Mock canned output for safety/IRB inputs.
    assert any("safety" == t or "irb_oversight" == t for t in analysis.tags)
    assert len(analysis.tags) >= 3
    # All deltas in valid range
    for v in analysis.score_deltas.values():
        assert -20.0 <= v <= 20.0
    assert analysis.rationale  # non-empty

    # Verify the typed call hit run_typed with the right output_type.
    typed_calls = [
        c for c in provider.call_log
        if c.get("output_type") == "ContributionAnalysis"
    ]
    assert typed_calls, (
        "Expected at least one ContributionAnalysis typed call; got: "
        f"{provider.call_log}"
    )
    # AGENT_CHAT tier per spec.
    assert typed_calls[0]["tier"] == int(LLMTier.AGENT_CHAT)


@pytest.mark.asyncio
async def test_analyze_contribution_tags_non_empty_on_any_input():
    """Even a vanilla contribution gets non-empty tags."""
    provider = MockLLMProvider()
    analysis = await analyze_contribution(
        content="We should consider adopting a phased timeline next quarter.",
        role_name="Researcher",
        role_authority_rank=3,
        llm_provider=provider,
    )
    assert len(analysis.tags) >= 3
    assert all(isinstance(t, str) and t for t in analysis.tags)


@pytest.mark.asyncio
async def test_analyze_contribution_empty_body_short_circuits():
    """Empty content returns a minimal analysis without calling the LLM."""
    provider = MockLLMProvider()
    analysis = await analyze_contribution(
        content="   ",
        role_name="Researcher",
        role_authority_rank=3,
        llm_provider=provider,
    )
    assert isinstance(analysis, ContributionAnalysis)
    # Empty body must NOT have caused a run_typed call.
    typed_calls = [
        c for c in provider.call_log
        if c.get("output_type") == "ContributionAnalysis"
    ]
    assert not typed_calls, (
        "Empty contribution should short-circuit before LLM call."
    )
    assert len(analysis.tags) >= 3
    assert analysis.score_deltas == {}


@pytest.mark.asyncio
async def test_analyze_contribution_propagates_provider_errors():
    """If the provider raises, analyze_contribution re-raises (caller falls back)."""

    class _BoomProvider:
        async def run_typed(self, *_args, **_kwargs):
            raise RuntimeError("provider down")

    with pytest.raises(RuntimeError, match="provider down"):
        await analyze_contribution(
            content="real content here",
            role_name="Researcher",
            role_authority_rank=3,
            llm_provider=_BoomProvider(),
        )


# ---------------------------------------------------------------------------
# Rubric calibration — guards against accidental regression of the
# anti-saturation language Sophie asked for after every radar axis pegged at
# 100 on her demo quorum.  These tests assert the rubric STRING contains the
# concrete calibration anchors and the anti-hallucination clause; they do NOT
# validate model behaviour (the mock provider returns canned outputs that
# don't depend on the rubric).  If a future refactor strips these anchors the
# rubric will silently revert to "things are going well" language and the
# chart will saturate again — fail loudly here instead.
# ---------------------------------------------------------------------------


def test_rubric_includes_calibration_anchors():
    """The rubric must anchor 0/25/50/75/100 with concrete observable criteria."""
    from quorum_llm.contribution_analyzer import _ANALYZER_INSTRUCTIONS

    rubric = _ANALYZER_INSTRUCTIONS
    # The five anchor points must all appear so the LLM has fixed reference
    # values and doesn't drift back to vague "good progress = high score".
    for anchor in ("100 =", "75 =", "50 =", "25 =", "0 ="):
        assert anchor in rubric, f"Rubric missing anchor for {anchor!r}"
    # "Complete and final" is the explicit definition of 100 — a generic
    # "things are going well" rounding-up phrasing is what triggered the
    # original saturation bug.
    assert "COMPLETE AND FINAL" in rubric


def test_rubric_includes_anti_hallucination_clause():
    """The rubric must require concrete evidence to justify large positive deltas."""
    from quorum_llm.contribution_analyzer import _ANALYZER_INSTRUCTIONS

    rubric = _ANALYZER_INSTRUCTIONS
    # The anti-hallucination clause: large positive deltas require quotable
    # closure language.
    assert "quote" in rubric.lower() or "specific phrase" in rubric.lower()
    # The +5/+10 split is the calibration threshold Sophie called out:
    # without quotable evidence, the LLM must stay <=+5.
    assert "+5" in rubric
    assert "+10" in rubric


def test_rubric_covers_all_five_metrics():
    """Every metric the analyzer scores must have a per-axis rubric paragraph."""
    from quorum_llm.contribution_analyzer import _ANALYZER_INSTRUCTIONS

    rubric = _ANALYZER_INSTRUCTIONS.lower()
    for metric in ("consensus", "completion", "critical_path", "blockers", "role_coverage"):
        assert metric in rubric, f"Rubric missing per-metric anchor for {metric!r}"
