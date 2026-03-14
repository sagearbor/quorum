"""Data models for the Quorum LLM package."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any


class LLMTier(IntEnum):
    """LLM processing tiers — higher = more expensive.

    Integer values are stored in the database (tier_processed column) and
    used for cost accounting.  Do not reorder existing values; add new ones
    with non-conflicting integers.

    Agent conversation tiers use sub-values (21, 31) so they sort between the
    primary tiers and are excluded from existing pipeline logic that checks for
    specific tier values (CONFLICT, SYNTHESIS).
    """

    KEYWORD = 1     # Free: deterministic keyword extraction, no LLM call
    CONFLICT = 2    # Cheap: GPT-4o-mini for conflict detection
    AGENT_CHAT = 21 # Cheap: GPT-4o-mini for agent facilitator conversations
    SYNTHESIS = 3   # Expensive: GPT-4o for final artifact synthesis
    AGENT_REASON = 31  # Expensive: GPT-4o for agent deep reasoning (escalations)


@dataclass
class Role:
    """A role within a quorum."""

    id: str
    name: str
    authority_rank: int
    capacity: int | str = "unlimited"


@dataclass
class Contribution:
    """A single contribution from a participant."""

    id: str
    role_id: str
    content: str
    structured_fields: dict[str, str] = field(default_factory=dict)
    tier_processed: int = 1


@dataclass
class Conflict:
    """A detected conflict between contributions."""

    contribution_ids: list[str]
    field_name: str
    description: str
    severity: str = "medium"  # low, medium, high


@dataclass
class ArtifactSection:
    """A section of a generated artifact."""

    title: str
    content: str
    source_contribution_ids: list[str] = field(default_factory=list)


@dataclass
class ArtifactContent:
    """The full generated artifact."""

    sections: list[ArtifactSection]
    content_hash: str = ""
    conflicts_resolved: list[Conflict] = field(default_factory=list)


@dataclass
class Quorum:
    """Quorum context passed into artifact generation."""

    id: str
    title: str
    description: str
    roles: list[Role] = field(default_factory=list)
    status: str = "active"


@dataclass
class BudgetExhaustedError(Exception):
    """Raised when API budget is exhausted (rate limit hit)."""

    provider: str
    tier: LLMTier
    detail: str = ""
    event_owner_notified: bool = False

    def __str__(self) -> str:
        return (
            f"Budget exhausted for {self.provider} at tier {self.tier.name}: "
            f"{self.detail}"
        )
