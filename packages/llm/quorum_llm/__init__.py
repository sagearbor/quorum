"""quorum_llm — Pluggable LLM provider package for Quorum."""

from quorum_llm.budget import BudgetGuard, guarded_complete
from quorum_llm.factory import get_llm_provider
from quorum_llm.interface import LLMProvider
from quorum_llm.providers.mock import MockLLMProvider
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
from quorum_llm.pipeline import (
    detect_conflicts,
    generate_artifact,
    synthesize_contributions,
)
from quorum_llm.tier1 import (
    deduplicate_contributions,
    extract_keywords,
    find_overlapping_fields,
)
from quorum_llm.affinity import (
    build_affinity_graph,
    canonicalize_tag,
    compute_tag_affinity,
    extract_tags_from_text as extract_tags_from_text_affinity,
    find_relevant_agents,
    merge_tag_vocabularies,
)

__all__ = [
    # Interface
    "LLMProvider",
    "get_llm_provider",
    # Models
    "LLMTier",
    "Role",
    "Contribution",
    "Conflict",
    "ArtifactSection",
    "ArtifactContent",
    "Quorum",
    "BudgetExhaustedError",
    # Pipeline
    "synthesize_contributions",
    "detect_conflicts",
    "generate_artifact",
    # Tier 1
    "extract_keywords",
    "deduplicate_contributions",
    "find_overlapping_fields",
    # Affinity engine
    "compute_tag_affinity",
    "extract_tags_from_text_affinity",
    "find_relevant_agents",
    "build_affinity_graph",
    "canonicalize_tag",
    "merge_tag_vocabularies",
    # Budget
    "BudgetGuard",
    "guarded_complete",
    # Mock
    "MockLLMProvider",
]
