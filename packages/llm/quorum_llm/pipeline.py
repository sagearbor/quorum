"""Three-tier LLM synthesis pipeline.

Tier 1 (free):  Deterministic keyword extraction + dedup
Tier 2 (cheap): Conflict detection between overlapping contributions
Tier 3 (once):  Final artifact synthesis for the quorum
"""

from __future__ import annotations

import hashlib
import json
import logging

from quorum_llm.interface import LLMProvider
from quorum_llm.models import (
    ArtifactContent,
    ArtifactSection,
    BudgetExhaustedError,
    Conflict,
    Contribution,
    LLMTier,
    Quorum,
    Role,
)
from quorum_llm.tier1 import (
    deduplicate_contributions,
    extract_keywords,
    find_overlapping_fields,
)

logger = logging.getLogger(__name__)


async def synthesize_contributions(
    contributions: list[Contribution],
    roles: list[Role],
    tier: LLMTier,
    provider: LLMProvider,
) -> str:
    """Synthesize contributions at the given tier.

    Tier 1: Returns keyword summary (no LLM call).
    Tier 2/3: Sends formatted prompt to LLM.
    """
    if not contributions:
        return ""

    role_map = {r.id: r for r in roles}

    if tier == LLMTier.KEYWORD:
        all_keywords: list[str] = []
        for c in contributions:
            all_keywords.extend(extract_keywords(c.content))
        unique = list(dict.fromkeys(all_keywords))
        return ", ".join(unique[:20])

    # Build a structured prompt for Tier 2/3
    lines = ["Synthesize the following contributions from a multi-stakeholder quorum.\n"]
    lines.append("Contributions (by role, authority rank):\n")
    for c in contributions:
        role = role_map.get(c.role_id)
        role_label = f"{role.name} (rank {role.authority_rank})" if role else "Unknown"
        lines.append(f"- [{role_label}]: {c.content}")

    if tier == LLMTier.CONFLICT:
        lines.append(
            "\nIdentify areas of agreement and disagreement. "
            "Flag conflicts where higher-authority roles override lower ones."
        )
    else:
        lines.append(
            "\nProduce a unified synthesis that respects the authority hierarchy. "
            "Higher-ranked roles take precedence on conflicts. "
            "Output structured sections suitable for a formal artifact."
        )

    prompt = "\n".join(lines)
    return await provider.complete(prompt, tier)


async def detect_conflicts(
    contributions: list[Contribution],
    roles: list[Role],
    provider: LLMProvider,
) -> list[Conflict]:
    """Detect conflicts between contributions using Tier 2 (cheap LLM).

    First uses Tier 1 to find overlapping fields, then sends overlapping
    contributions to the LLM for conflict analysis.
    """
    if len(contributions) < 2:
        return []

    # Find fields addressed by multiple contributors
    fields_lists = [c.structured_fields for c in contributions]
    overlaps = find_overlapping_fields(fields_lists)

    if not overlaps:
        # No structured field overlap — check free-text for duplicates
        unique_indices = deduplicate_contributions(
            [c.content for c in contributions]
        )
        if len(unique_indices) == len(contributions):
            return []  # All unique, no obvious conflicts

    role_map = {r.id: r for r in roles}
    conflicts: list[Conflict] = []

    for field_name, contributor_indices in overlaps.items():
        # Build conflict detection prompt
        lines = [
            f"Analyze the following contributions for field '{field_name}' "
            "and determine if there are conflicts.\n"
        ]
        involved_ids = []
        for idx in contributor_indices:
            c = contributions[idx]
            role = role_map.get(c.role_id)
            role_label = (
                f"{role.name} (rank {role.authority_rank})" if role else "Unknown"
            )
            value = c.structured_fields.get(field_name, c.content)
            lines.append(f"- [{role_label}] (contribution {c.id}): {value}")
            involved_ids.append(c.id)

        lines.append(
            '\nRespond with JSON: {"has_conflict": bool, "description": str, '
            '"severity": "low"|"medium"|"high"}'
        )

        prompt = "\n".join(lines)
        try:
            result = await provider.complete(prompt, LLMTier.CONFLICT)
            parsed = _parse_conflict_json(result)
            if parsed and parsed.get("has_conflict"):
                conflicts.append(
                    Conflict(
                        contribution_ids=involved_ids,
                        field_name=field_name,
                        description=parsed.get("description", ""),
                        severity=parsed.get("severity", "medium"),
                    )
                )
        except BudgetExhaustedError:
            raise
        except Exception:
            logger.warning("Failed to parse conflict detection result for field '%s'", field_name)

    return conflicts


async def generate_artifact(
    quorum: Quorum,
    all_contributions: list[Contribution],
    provider: LLMProvider,
) -> ArtifactContent:
    """Generate the final artifact for a quorum using Tier 3 (expensive, once).

    Pipeline:
    1. Tier 1: Dedup + keyword extraction
    2. Tier 2: Conflict detection on overlapping fields
    3. Tier 3: Full artifact synthesis
    """
    if not all_contributions:
        return ArtifactContent(sections=[], content_hash=_hash(""))

    roles = quorum.roles

    # Step 1: Deduplicate
    unique_indices = deduplicate_contributions(
        [c.content for c in all_contributions]
    )
    unique_contributions = [all_contributions[i] for i in unique_indices]
    logger.info(
        "Dedup: %d -> %d contributions",
        len(all_contributions),
        len(unique_contributions),
    )

    # Step 2: Detect conflicts (Tier 2)
    conflicts = await detect_conflicts(unique_contributions, roles, provider)
    logger.info("Detected %d conflicts", len(conflicts))

    # Step 3: Build synthesis prompt (Tier 3)
    role_map = {r.id: r for r in roles}
    lines = [
        f"You are generating the final artifact for quorum: {quorum.title}\n",
        f"Description: {quorum.description}\n",
        "Contributions (deduplicated, by role and authority rank):\n",
    ]
    for c in unique_contributions:
        role = role_map.get(c.role_id)
        role_label = f"{role.name} (rank {role.authority_rank})" if role else "Unknown"
        lines.append(f"- [{role_label}]: {c.content}")

    if conflicts:
        lines.append("\nDetected conflicts:")
        for conf in conflicts:
            lines.append(
                f"- Field '{conf.field_name}' ({conf.severity}): {conf.description}"
            )
        lines.append(
            "\nResolve conflicts by deferring to higher-authority roles."
        )

    lines.append(
        "\nProduce the artifact as a JSON array of sections: "
        '[{"title": str, "content": str}]. '
        "Each section should be a logical component of the final document."
    )

    prompt = "\n".join(lines)
    result = await provider.complete(prompt, LLMTier.SYNTHESIS)

    sections = _parse_sections(result, unique_contributions)
    content_hash = _hash(json.dumps([{"title": s.title, "content": s.content} for s in sections]))

    return ArtifactContent(
        sections=sections,
        content_hash=content_hash,
        conflicts_resolved=conflicts,
    )


def _parse_conflict_json(text: str) -> dict | None:
    """Best-effort parse of JSON from LLM output."""
    # Try to find JSON in the response
    text = text.strip()
    start = text.find("{")
    end = text.rfind("}") + 1
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end])
        except json.JSONDecodeError:
            return None
    return None


def _parse_sections(
    text: str, contributions: list[Contribution]
) -> list[ArtifactSection]:
    """Parse artifact sections from LLM output."""
    all_ids = [c.id for c in contributions]

    # Try JSON array parse
    text = text.strip()
    start = text.find("[")
    end = text.rfind("]") + 1
    if start >= 0 and end > start:
        try:
            raw = json.loads(text[start:end])
            return [
                ArtifactSection(
                    title=s.get("title", "Untitled"),
                    content=s.get("content", ""),
                    source_contribution_ids=all_ids,
                )
                for s in raw
                if isinstance(s, dict)
            ]
        except json.JSONDecodeError:
            pass

    # Fallback: treat entire output as a single section
    return [
        ArtifactSection(
            title="Synthesis",
            content=text,
            source_contribution_ids=all_ids,
        )
    ]


def _hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()[:16]
