"""Health score calculation for quorums.

Composite score 0–100 from CONTRACT.md HealthMetrics:
  completion_pct, consensus_score, role_coverage_pct,
  critical_path_score, blocker_score.

Design philosophy
-----------------
100 on any metric should mean **complete success**, not "we have a pulse".
Each formula is anchored to concrete final-state evidence and capped below
100 unless that evidence is present:

  * role_coverage_pct  →  ≥3 contributions per role AND highest-authority role
                          has weighed in
  * completion_pct     →  artifact present, status in {"final","resolved"},
                          ALL position-snapshot ``unresolved`` items empty,
                          AND ≥3 contributions per role
  * consensus_score    →  explicit closure signals: ≥2 shared structured_fields
                          keys converging across contributions; no 1.1x bonus
                          just for showing up
  * critical_path_score → A2A-resolved / A2A-total (approximated via
                          unresolved-items burndown in the position snapshot
                          since this function only receives roles + contribs +
                          artifact)
  * blocker_score      →  capped at 90 unless we have explicit closure
                          evidence (no unresolved + artifact final)

Why we don't add a new parameter
--------------------------------
Function signature is held stable (existing callers in routes.py pass exactly
roles/contributions/artifact/activity_count).  All new signals are derived from
artifact.initial_position / artifact.final_position (which carry an
``unresolved: list[str]`` field produced by the Tier-2 position synthesizer)
and from per-contribution structured_fields.

Saturation tightening — what changed vs. the previous implementation
--------------------------------------------------------------------
PR #87 already tightened the LLM rubric.  This file tightens the *deterministic
baseline* that is added to the LLM cumulative deltas elsewhere in routes.py.
Previously the baseline saturated at 100/100/100/100/100 on any quorum where
every role had contributed at least once — which immediately swamped the LLM's
modest +/- 30 deltas and produced visibly fake "we're perfect" dashboards.
"""

from __future__ import annotations

from typing import Any


# -- Caps applied when final-state evidence is absent --------------------------
# These are the documented ceilings each metric cannot exceed unless the
# corresponding evidence is present.  100 is reserved for unambiguous
# complete-success.
ROLE_COVERAGE_PARTIAL_CAP = 80.0
COMPLETION_NO_FINAL_ARTIFACT_CAP = 80.0
CONSENSUS_NO_CLOSURE_CAP = 75.0
CRITICAL_PATH_NO_A2A_CAP = 85.0
BLOCKER_NO_CLOSURE_CAP = 90.0

# Substantive engagement threshold: a role needs at least this many
# contributions before it is counted as "substantively engaged" for the purpose
# of role_coverage / completion bonuses.
SUBSTANTIVE_CONTRIB_PER_ROLE = 3


def fetch_activity_count(db, quorum_id: str) -> int:
    """Return total chat + insight activity count for a quorum.

    Used to feed `calculate_health_score(activity_count=...)` so the chart
    moves on every chat turn even though chats don't insert into the
    contributions table.  Falls back to 0 on any error so a counter-fetch
    failure never blocks a heat_score recompute.
    """
    try:
        msgs = (
            db.table("station_messages")
            .select("id", count="exact")
            .eq("quorum_id", quorum_id)
            .execute()
        )
        return int(getattr(msgs, "count", None) or len(msgs.data or []))
    except Exception:
        return 0


# -- Helpers -------------------------------------------------------------------


def _contributions_by_role(contributions: list[dict[str, Any]]) -> dict[str, int]:
    """Return {role_id: contribution_count}."""
    counts: dict[str, int] = {}
    for c in contributions:
        rid = c.get("role_id")
        if rid is None:
            continue
        counts[rid] = counts.get(rid, 0) + 1
    return counts


def _is_final_artifact(artifact: dict[str, Any] | None) -> bool:
    """True when the artifact represents a ratified / final state.

    Treats both 'final' and 'resolved' as final-state strings since callers
    have used both historically.  ``pending_ratification`` and ``draft`` do
    NOT qualify — there is missing signal we should reflect in the score.
    """
    if not artifact:
        return False
    status = (artifact.get("status") or "").lower()
    return status in {"final", "resolved", "ratified"}


def _all_unresolved_empty(artifact: dict[str, Any] | None) -> bool:
    """True iff the FINAL position snapshot exists AND its ``unresolved`` is empty.

    The initial snapshot intentionally captures open questions at quorum mid-
    flight — those are EXPECTED to be non-empty even on a fully-closed quorum.
    Closure is therefore measured against ``final_position`` only.

    Absence of a final snapshot is treated as "we don't know" → returns False
    (so the metric stays below its cap).
    """
    if not artifact:
        return False
    final = artifact.get("final_position")
    if not final:
        return False
    unresolved = final.get("unresolved") or []
    return len(unresolved) == 0


def _unresolved_burndown_ratio(artifact: dict[str, Any] | None) -> tuple[float, bool]:
    """Approximate A2A-resolved/A2A-total ratio from the position snapshots.

    The ``unresolved`` array on initial_position vs. final_position is our best
    in-function proxy for "open A2A questions over time" since this function
    intentionally does not take an a2a_requests parameter.

    Returns (ratio_0_to_1, has_a2a_traffic).  ``has_a2a_traffic`` is False when
    no position snapshot exists or when both snapshots report zero unresolved
    items from the start — in that case callers should apply the no-A2A cap.
    """
    if not artifact:
        return 0.0, False
    initial = artifact.get("initial_position") or {}
    final = artifact.get("final_position") or {}
    initial_unresolved = len(initial.get("unresolved") or [])
    final_unresolved = len(final.get("unresolved") or [])

    if not initial and not final:
        return 0.0, False

    # If we never had any unresolved items, treat as "no A2A traffic to
    # measure" — score is held at the cap rather than vacuously hitting 100.
    if initial_unresolved == 0 and final_unresolved == 0:
        return 1.0, False

    # Burndown: 1.0 when every unresolved item closed, 0.0 when none did.
    base = max(initial_unresolved, 1)
    closed = max(initial_unresolved - final_unresolved, 0)
    return min(closed / base, 1.0), True


def _consensus_closure_evidence(contributions: list[dict[str, Any]]) -> bool:
    """True when at least 2 structured_fields keys are shared (i.e. converging)
    across two or more contributions.

    This is our cheap deterministic proxy for "explicit agreement signal".
    The Tier-2 conflict detector elsewhere already flags overlap on
    structured_fields keys; we reuse that signal here.
    """
    key_counts: dict[str, int] = {}
    for c in contributions:
        fields = c.get("structured_fields") or {}
        if not isinstance(fields, dict):
            continue
        for k in fields.keys():
            key_counts[k] = key_counts.get(k, 0) + 1
    # "Shared on at least 2 keys" = at least 2 distinct keys each held by ≥2
    # different contributions.
    shared_keys = sum(1 for n in key_counts.values() if n >= 2)
    return shared_keys >= 2


def calculate_health_score(
    roles: list[dict[str, Any]],
    contributions: list[dict[str, Any]],
    artifact: dict[str, Any] | None,
    *,
    activity_count: int = 0,
) -> tuple[float, dict[str, float]]:
    """Compute composite health score and individual metrics.

    Args:
        roles: All roles defined for the quorum.
        contributions: Rows from the contributions table (structured submissions
            and autonomy auto-contributions).  Each row may carry a
            ``structured_fields`` jsonb that we use for consensus detection.
        artifact: Final artifact row if /resolve has been called, else None.
            May carry ``status``, ``sections``, ``initial_position`` and
            ``final_position`` (each position snapshot has an
            ``unresolved: list[str]``).
        activity_count: Total count of station_messages + agent_insights for the
            quorum.  Chats and agent reflections don't write to ``contributions``
            so without this signal the chart would be flat during live
            conversation.  Each activity bumps ``completion_pct`` modestly
            (capped) so the chart moves visibly during a demo even before any
            structured contributions land.

    Returns (score, metrics_dict) where score is 0-100.

    Reaching 100 on any individual metric requires complete-success evidence
    described in the module docstring.  A "thriving but mid-quorum" run lands
    in the 50-80 band.
    """
    total_roles = len(roles)
    final_artifact = _is_final_artifact(artifact)
    all_unresolved_empty = _all_unresolved_empty(artifact)
    closure_evidence = final_artifact and all_unresolved_empty
    contributing_role_ids = {c["role_id"] for c in contributions if c.get("role_id")}
    contribs_per_role = _contributions_by_role(contributions)

    # -------------------------------------------------------------------------
    # role_coverage_pct
    #   100 requires:
    #     • every role has ≥SUBSTANTIVE_CONTRIB_PER_ROLE contributions
    #     • highest-authority role has weighed in
    #   Otherwise capped at ROLE_COVERAGE_PARTIAL_CAP (80).
    # -------------------------------------------------------------------------
    if total_roles == 0:
        role_coverage_pct = 0.0
    else:
        # Raw coverage: % of roles with ≥1 contribution.
        raw_coverage = sum(1 for r in roles if r["id"] in contributing_role_ids) / total_roles * 100

        # Substantive coverage: % of roles with ≥SUBSTANTIVE_CONTRIB_PER_ROLE.
        substantive_roles = sum(
            1 for r in roles
            if contribs_per_role.get(r["id"], 0) >= SUBSTANTIVE_CONTRIB_PER_ROLE
        )
        substantive_coverage = substantive_roles / total_roles * 100

        # Highest-authority-role check.
        role_rank_map = {r["id"]: r.get("authority_rank", 0) for r in roles}
        max_rank = max(role_rank_map.values()) if role_rank_map else 0
        highest_role_ids = {rid for rid, rk in role_rank_map.items() if rk == max_rank}
        highest_in = any(rid in contributing_role_ids for rid in highest_role_ids)

        if substantive_roles == total_roles and highest_in:
            # Full substantive engagement from every role including the boss
            # → uncapped, can reach 100 (we use the substantive coverage which
            # is by definition 100 here).
            role_coverage_pct = 100.0
        else:
            # Blend: weight substantive coverage 60%, raw coverage 40%, but
            # never exceed the partial cap.  This still rewards getting
            # everyone to show up while reserving the top of the scale for
            # *substantive* participation.
            blended = substantive_coverage * 0.6 + raw_coverage * 0.4
            role_coverage_pct = min(blended, ROLE_COVERAGE_PARTIAL_CAP)

    # -------------------------------------------------------------------------
    # completion_pct
    #   100 requires:
    #     • artifact present and final/resolved/ratified
    #     • position snapshot ``unresolved`` is empty across all stages
    #     • every role has ≥SUBSTANTIVE_CONTRIB_PER_ROLE contributions
    #   Otherwise capped at COMPLETION_NO_FINAL_ARTIFACT_CAP (80).
    # -------------------------------------------------------------------------
    # Anchor: how full is the artifact?  If it exists, % of sections that have
    # non-empty content.  Else fall back to a small fraction of raw coverage so
    # the chart isn't flat during the in-flight phase.
    if artifact and artifact.get("sections"):
        sections = artifact["sections"]
        filled = sum(1 for s in sections if (s.get("content") or "").strip())
        section_completion = (filled / len(sections) * 100) if sections else 0.0
    else:
        section_completion = 0.0

    # In-flight signal: raw role coverage gets us partial credit when no
    # artifact has been written yet, but only up to 40 points so we never
    # outrun the "we don't even have a draft" reality.
    in_flight_signal = min(
        sum(min(c, SUBSTANTIVE_CONTRIB_PER_ROLE) for c in contribs_per_role.values())
        / max(total_roles * SUBSTANTIVE_CONTRIB_PER_ROLE, 1)
        * 60,
        60.0,
    )

    # Activity bonus: small constant per chat turn / agent insight, capped at
    # 10 points so chat alone can never push completion past 10.
    activity_bonus = min(activity_count * 0.5, 10.0)

    base_completion = max(section_completion, in_flight_signal) + activity_bonus

    substantive_roles_count = sum(
        1 for r in roles
        if contribs_per_role.get(r["id"], 0) >= SUBSTANTIVE_CONTRIB_PER_ROLE
    )
    full_substantive = total_roles > 0 and substantive_roles_count == total_roles

    if final_artifact and all_unresolved_empty and full_substantive:
        # Complete success — uncapped, can hit 100.
        completion_pct = min(base_completion + 100.0, 100.0)
    else:
        completion_pct = min(base_completion, COMPLETION_NO_FINAL_ARTIFACT_CAP)

    # -------------------------------------------------------------------------
    # consensus_score
    #   100 requires:
    #     • explicit closure: ≥2 shared structured_fields keys across contribs
    #     • artifact is final AND no unresolved items
    #   Otherwise capped at CONSENSUS_NO_CLOSURE_CAP (75).
    #   The previous 1.1x "highest-rank present" multiplier is removed —
    #   being present should never push us to 100.
    # -------------------------------------------------------------------------
    if total_roles == 0:
        consensus_score = 0.0
    else:
        role_rank_map = {r["id"]: r.get("authority_rank", 0) for r in roles}
        total_weight = sum(role_rank_map.values()) or 1
        covered_weight = sum(
            role_rank_map.get(rid, 0) for rid in contributing_role_ids
        )
        # Authority-weighted base coverage.
        base_consensus = (covered_weight / total_weight * 100) if total_weight > 0 else 0.0

        has_closure = _consensus_closure_evidence(contributions)
        if has_closure and final_artifact and all_unresolved_empty:
            # Full closure evidence — no cap, can reach 100.
            consensus_score = base_consensus
        else:
            consensus_score = min(base_consensus, CONSENSUS_NO_CLOSURE_CAP)

    # -------------------------------------------------------------------------
    # critical_path_score
    #   100 requires:
    #     • A2A traffic has occurred (unresolved items existed at some point)
    #     • every unresolved item is closed by the final snapshot
    #     • artifact is final
    #   When no A2A traffic exists, capped at CRITICAL_PATH_NO_A2A_CAP (85)
    #   regardless of contribution count.
    # -------------------------------------------------------------------------
    burndown, has_a2a = _unresolved_burndown_ratio(artifact)
    if has_a2a and final_artifact and burndown >= 1.0:
        critical_path_score = 100.0
    elif has_a2a:
        # Partial burndown — score it proportionally, but stay under cap until
        # the artifact actually finalizes.
        critical_path_score = min(burndown * 100.0, CRITICAL_PATH_NO_A2A_CAP)
    else:
        # No A2A traffic to measure → anchor on substantive engagement signal
        # but cap firmly so it cannot vacuously hit 100.
        contrib_density_signal = (
            sum(min(c, SUBSTANTIVE_CONTRIB_PER_ROLE) for c in contribs_per_role.values())
            / max(total_roles * SUBSTANTIVE_CONTRIB_PER_ROLE, 1)
            * CRITICAL_PATH_NO_A2A_CAP
        )
        critical_path_score = min(contrib_density_signal, CRITICAL_PATH_NO_A2A_CAP)

    # -------------------------------------------------------------------------
    # blocker_score
    #   100 requires:
    #     • no missing single-capacity roles (existing rule)
    #     • closure evidence: artifact final AND no unresolved items
    #   Without closure evidence we cap at BLOCKER_NO_CLOSURE_CAP (90) — we
    #   can't claim "no blockers" until we actually closed out the work.
    # -------------------------------------------------------------------------
    blockers = 0
    for r in roles:
        cap = r.get("capacity", "unlimited")
        if cap != "unlimited" and str(cap) == "1":
            if r["id"] not in contributing_role_ids:
                blockers += 1
    # Also count unresolved items in the final snapshot as latent blockers.
    if artifact:
        final_unresolved = (artifact.get("final_position") or {}).get("unresolved") or []
        blockers += len(final_unresolved)

    raw_blocker_score = max(0.0, 100.0 - blockers * 25)
    if closure_evidence:
        blocker_score = raw_blocker_score
    else:
        blocker_score = min(raw_blocker_score, BLOCKER_NO_CLOSURE_CAP)

    # -------------------------------------------------------------------------
    # Composite score (unchanged weights)
    # -------------------------------------------------------------------------
    score = (
        completion_pct * 0.3
        + consensus_score * 0.2
        + critical_path_score * 0.2
        + role_coverage_pct * 0.2
        + blocker_score * 0.1
    )

    metrics = {
        "completion_pct": round(completion_pct, 2),
        "consensus_score": round(consensus_score, 2),
        "critical_path_score": round(critical_path_score, 2),
        "role_coverage_pct": round(role_coverage_pct, 2),
        "blocker_score": round(blocker_score, 2),
    }

    return round(score, 2), metrics
