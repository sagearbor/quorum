"""Health score calculation for quorums.

Composite score 0–100 from CONTRACT.md HealthMetrics:
  completion_pct, consensus_score, role_coverage_pct,
  critical_path_score, blocker_score.
"""

from __future__ import annotations

from typing import Any


def calculate_health_score(
    roles: list[dict[str, Any]],
    contributions: list[dict[str, Any]],
    artifact: dict[str, Any] | None,
) -> tuple[float, dict[str, float]]:
    """Compute composite health score and individual metrics.

    Returns (score, metrics_dict) where score is 0-100.
    """
    total_roles = len(roles)

    # --- role_coverage_pct: % of defined roles with >=1 contribution ---
    contributing_role_ids = {c["role_id"] for c in contributions}
    covered = sum(1 for r in roles if r["id"] in contributing_role_ids)
    role_coverage_pct = (covered / total_roles * 100) if total_roles > 0 else 0.0

    # --- completion_pct: based on artifact sections filled ---
    if artifact and artifact.get("sections"):
        sections = artifact["sections"]
        filled = sum(1 for s in sections if s.get("content", "").strip())
        completion_pct = (filled / len(sections) * 100) if sections else 0.0
    else:
        # No artifact yet — estimate from contribution density
        # Each role contributing at least once is ~progress toward completion
        completion_pct = role_coverage_pct * 0.5

    # --- consensus_score: authority-weighted agreement ---
    # Heuristic: if all covered roles contributed, consensus is high.
    # Penalize when high-authority roles are missing.
    if total_roles == 0:
        consensus_score = 0.0
    else:
        role_rank_map = {r["id"]: r.get("authority_rank", 0) for r in roles}
        max_rank = max(role_rank_map.values()) if role_rank_map else 1
        total_weight = sum(role_rank_map.values()) or 1
        covered_weight = sum(
            role_rank_map.get(rid, 0) for rid in contributing_role_ids
        )
        consensus_score = (covered_weight / total_weight * 100) if total_weight > 0 else 0.0
        # Bonus if highest-authority role is present
        highest_roles = [rid for rid, rank in role_rank_map.items() if rank == max_rank]
        if any(rid in contributing_role_ids for rid in highest_roles):
            consensus_score = min(100.0, consensus_score * 1.1)

    # --- critical_path_score: inverted estimated time to close (100 = done) ---
    # Approximation: more contributions + more role coverage = closer to done
    contrib_density = min(len(contributions) / max(total_roles * 2, 1), 1.0)
    critical_path_score = contrib_density * 100

    # --- blocker_score: inverted blocker count (100 = no blockers) ---
    # Blockers: roles with capacity=1 (single person) that have 0 contributions
    blockers = 0
    for r in roles:
        cap = r.get("capacity", "unlimited")
        if cap != "unlimited" and str(cap) == "1":
            if r["id"] not in contributing_role_ids:
                blockers += 1
    blocker_score = max(0.0, 100.0 - blockers * 25)

    # --- Composite score (weighted average) ---
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
