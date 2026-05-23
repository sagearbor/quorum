"""Tier-2 contribution analyzer.

Runs one structured-output LLM call per contribution to extract:

1. **Domain tags** — 3-10 short snake_case tags drawn from the contribution.
   Replaces the stopword-based ``tier1.extract_keywords`` extractor for
   contribution flow specifically — Sophie flagged that stopword extraction
   was surfacing noise like ``"while"``, ``"introduction"``, ``"refined"`` as
   tag pills during her demo.
2. **Per-metric score deltas** — how this contribution moves the group toward
   (or away from) a finalized artifact.  Each value clamped to ``[-20, +20]``
   using the same delta semantics as the existing ``[scores: ...]`` block
   parser (``quorum_llm.metric_deltas``).  Positive = advances toward
   resolution; negative = surfaces regression / dissent / new blocker.
3. **Rationale** — one- to two-sentence plain-English explanation of why
   these deltas, used for the chart hover-popover audit trail.

The public entry point is :func:`analyze_contribution`.  It always returns
a :class:`ContributionAnalysis` — on LLM/parse failure the caller (the API)
catches the ``Exception`` and falls through to its existing deterministic
path.  We don't swallow errors at this layer because callers need to
distinguish "LLM said no movement" (empty deltas, present tags) from
"LLM call failed".
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import BaseModel, Field, field_validator

from quorum_llm.models import LLMTier

logger = logging.getLogger(__name__)


# Per-metric clamp range, matching ``quorum_llm.metric_deltas`` so the running
# accumulator on ``quorums.llm_metric_deltas`` stays consistent regardless of
# whether the delta source is an agent reply ``[scores: ...]`` block or this
# new analyzer.
_DELTA_MIN = -20.0
_DELTA_MAX = 20.0

# Canonical short metric keys the LLM is allowed to emit.  Anything outside
# this set is dropped silently during clamping — keeps the chart honest.
_ALLOWED_METRIC_KEYS: frozenset[str] = frozenset({
    "consensus",
    "completion",
    "critical_path",
    "blockers",
    "role_coverage",
})


class ContributionAnalysis(BaseModel):
    """Structured output for a single contribution's LLM analysis."""

    tags: list[str] = Field(
        ...,
        min_length=3,
        max_length=10,
        description=(
            "3-10 short snake_case domain tags drawn from this contribution. "
            "Use the role's vocabulary when it fits; otherwise pick concise, "
            "domain-meaningful words (NOT stopwords or filler)."
        ),
    )
    score_deltas: dict[str, float] = Field(
        default_factory=dict,
        description=(
            "Per-metric impact in [-20, +20].  Keys: consensus, completion, "
            "critical_path, blockers, role_coverage.  Positive = advances "
            "the group toward a finalized artifact.  Negative = surfaces "
            "regression / dissent / new blocker.  Omit a key to mean 'no "
            "change' on that metric."
        ),
    )
    rationale: str = Field(
        ...,
        max_length=300,
        description=(
            "One- to two-sentence plain-English explanation of why these "
            "deltas — used for hover-popover audit trail."
        ),
    )
    structured_fields: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Concrete claims, decisions, or parameters extracted from this "
            "contribution.  Keys are short snake_case names (e.g. 'timeline', "
            "'owner', 'budget', 'data_source', 'approval_required'); values "
            "are the corresponding short string the contribution actually "
            "asserts (e.g. 'Q3 2026', 'Data Governance team', '$50k', "
            "'Snowflake', 'no').  Used by the Conflict Topology Map to "
            "surface cases where two roles independently set the same key "
            "to different values.  Omit a key entirely if the contribution "
            "makes no concrete claim about it — empty values dilute the "
            "signal.  Keep total fields ≤ 6 per contribution; pick the most "
            "load-bearing claims."
        ),
    )

    @field_validator("tags")
    @classmethod
    def _normalize_tags(cls, v: list[str]) -> list[str]:
        """Trim whitespace, drop empties, lowercase + snake_case."""
        out: list[str] = []
        seen: set[str] = set()
        for raw in v or []:
            if not isinstance(raw, str):
                continue
            t = raw.strip().lower().replace(" ", "_").replace("-", "_")
            # Strip any leading/trailing underscores that come from the
            # whitespace -> underscore swap.
            t = t.strip("_")
            if t and t not in seen:
                seen.add(t)
                out.append(t)
        return out

    @field_validator("score_deltas")
    @classmethod
    def _clamp_deltas(cls, v: dict[str, float]) -> dict[str, float]:
        """Filter to allowed keys + clamp each to [-20, +20]."""
        out: dict[str, float] = {}
        if not isinstance(v, dict):
            return out
        for k, raw in v.items():
            if not isinstance(k, str):
                continue
            key = k.strip().lower()
            if key not in _ALLOWED_METRIC_KEYS:
                continue
            try:
                num = float(raw)
            except (TypeError, ValueError):
                continue
            if num != num:  # NaN check
                continue
            if num < _DELTA_MIN:
                num = _DELTA_MIN
            elif num > _DELTA_MAX:
                num = _DELTA_MAX
            out[key] = num
        return out


_ANALYZER_INSTRUCTIONS = (
    "You are scoring a single contribution from a multi-stakeholder quorum.\n"
    "\n"
    "For each contribution, decide:\n"
    "  1. What concise domain tags describe it? (3-10 snake_case tags; "
    "no stopwords or filler).\n"
    "  2. Per-metric deltas in [-20, +20] for how THIS turn moved each "
    "metric. Omit a metric to mean 'no change'.\n"
    "  3. Why?  One or two sentences, plain English, max 300 chars.\n"
    "  4. structured_fields: concrete claims as key/value pairs (e.g. "
    "{'timeline': 'Q3 2026', 'owner': 'Data Governance team', "
    "'budget': '$50k', 'data_source': 'Snowflake'}).  Use short "
    "snake_case keys.  Cap at 6 fields.  Omit a field entirely if "
    "the contribution makes no concrete claim about it — empty values "
    "dilute conflict-detection downstream.  If the contribution is "
    "purely affirmation / discussion with no concrete decisions, "
    "return an empty object.\n"
    "\n"
    "=== DELTA CALIBRATION (READ CAREFULLY) ===\n"
    "Deltas accumulate across the quorum into 0-100 absolute metrics. Be "
    "conservative. The 0-100 absolute scale anchors:\n"
    "   100 = COMPLETE AND FINAL. No remaining work, no open questions, "
    "no risk. Achieving 100 is HARD and rare.\n"
    "    75 = VERY GOOD but still has open items, follow-ups, or "
    "unresolved details. Typical strong outcome.\n"
    "    50 = MODERATE progress. Real questions remain. The most common "
    "landing zone for working deliberations.\n"
    "    25 = EARLY or WEAK. Sparse evidence, shallow engagement, or "
    "narrow participation.\n"
    "     0 = NO progress or actively obstructed.\n"
    "\n"
    "Most working deliberations should land in the 50-80 band, NOT at 100. "
    "If you cannot quote a specific phrase in this contribution that "
    "justifies a score above 85 on the resulting absolute metric, then "
    "your POSITIVE delta must be small enough that the running total "
    "stays below 85. When in doubt, emit 0 or a low single-digit delta.\n"
    "\n"
    "=== PER-METRIC RUBRICS (what each metric MEANS at 100) ===\n"
    "\n"
    "consensus (alignment between roles)\n"
    "  100 = every role with a stake has explicitly endorsed the same "
    "position; zero unresolved disagreements on record. Only emit a "
    "large POSITIVE delta when this turn contains an EXPLICIT agreement "
    "statement that closes a previously open disagreement. A constructive "
    "comment that merely doesn't disagree is +1 or +2, not +10. A turn "
    "that surfaces dissent or raises a counter-position is NEGATIVE.\n"
    "\n"
    "completion (fraction of expected work done)\n"
    "  100 = every original requirement has an explicit closure statement "
    "AND a final artifact is locked. A contribution that proposes a "
    "framework, DoD, or plan is +3 to +6, NOT +15 — the framework still "
    "needs execution. Only emit +10 or higher when this turn delivers a "
    "concrete deliverable (signed-off doc, locked spec, ratified plan) "
    "that demonstrably finishes a previously open requirement.\n"
    "\n"
    "critical_path (health of the dependency chain)\n"
    "  100 = no unresolved upstream dependencies; every prerequisite has "
    "a named owner and a confirmed status. Adding a new step to the "
    "dependency chain (even a constructive one) is at best +2: the path "
    "is longer now, not shorter. Only emit large POSITIVE deltas when "
    "this turn explicitly RESOLVES a dependency ('X confirmed, "
    "unblocked'). New cross-system requirements are usually NEGATIVE or "
    "near-zero.\n"
    "\n"
    "blockers (POSITIVE delta = blockers REMOVED, NEGATIVE = new blocker)\n"
    "  100 = zero open blockers, zero open risks, no caveats outstanding. "
    "Identifying a new risk or open issue is NEGATIVE. Saying 'this is "
    "fine' without resolving an existing blocker is 0. Only emit +10 or "
    "higher when this turn names a SPECIFIC previously-recorded blocker "
    "and closes it.\n"
    "\n"
    "role_coverage (breadth of role participation, weighted by authority)\n"
    "  100 = every defined role has made a substantive on-topic "
    "contribution AND the highest-authority role has explicitly weighed "
    "in. A new role joining for the first time with a substantive point "
    "is +5 to +10. A repeat contribution from an already-active role is "
    "+0 to +2. Token acknowledgements are 0.\n"
    "\n"
    "=== ANTI-HALLUCINATION CLAUSE ===\n"
    "If you cannot quote a specific phrase or commitment from this "
    "contribution that justifies a delta of +10 or more on a given "
    "metric, the delta must be +5 or lower on that metric. Vague positive "
    "vibes ('good progress', 'on track', 'looking strong') are NOT "
    "evidence. Only concrete closure language ('approved', 'signed off', "
    "'finalised', 'unblocked', 'agreed') justifies large positive deltas.\n"
    "\n"
    "Higher-authority roles outrank lower ones on conflict. A contribution "
    "that escalates disagreement should produce a NEGATIVE consensus "
    "delta and POSITIVE completion only if it actually advances substance."
)


async def analyze_contribution(
    content: str,
    role_name: str,
    role_authority_rank: int,
    llm_provider: Any,
) -> ContributionAnalysis:
    """Run one Tier-2 LLM call to score and tag a contribution.

    Parameters
    ----------
    content
        The raw contribution text.
    role_name
        Display name of the role that authored the contribution (e.g.
        ``"IRB"``, ``"Principal Investigator"``).  Used in the prompt so the
        LLM can reason about authority.
    role_authority_rank
        Integer authority rank (higher = more authoritative).
    llm_provider
        Anything implementing the ``LLMProvider`` ABC.  In production this
        is the package-level ``llm_provider`` instance; in tests, a mock
        with ``run_typed`` overridden.

    Returns
    -------
    ContributionAnalysis
        Validated + clamped analysis.  ``tags`` is guaranteed non-empty
        (the schema enforces ``min_length=3``).  ``score_deltas`` may be
        empty (= "no movement on any metric").

    Raises
    ------
    Exception
        Re-raises whatever the provider raises (network error, parse error,
        budget exhaustion).  The caller is responsible for catching this
        and falling through to its deterministic baseline path — we don't
        swallow at this layer because the API needs to distinguish
        "model said no movement" from "call failed".
    """
    body = (content or "").strip()
    if not body:
        # Edge case — empty contribution.  Don't burn a token; return a
        # minimal analysis with the role name as the sole tag (the schema
        # requires min 3 tags, so synthesise filler).  This path is hit
        # only by malformed requests; production validation should
        # reject empty bodies upstream.
        role_tag = (role_name or "unknown").strip().lower().replace(" ", "_")
        return ContributionAnalysis(
            tags=[role_tag or "unknown", "empty_contribution", "no_signal"],
            score_deltas={},
            rationale="Empty contribution — no analyzable content.",
        )

    prompt_lines = [
        f"Role: {role_name} (authority rank {role_authority_rank})",
        "",
        "Contribution:",
        body,
    ]
    prompt = "\n".join(prompt_lines)

    return await llm_provider.run_typed(
        prompt,
        LLMTier.AGENT_CHAT,
        output_type=ContributionAnalysis,
        instructions=_ANALYZER_INSTRUCTIONS,
    )
