"""Tests for the three-tier synthesis pipeline."""

import json

import pytest

from quorum_llm.interface import LLMProvider
from quorum_llm.models import (
    ArtifactContent,
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


class MockProvider(LLMProvider):
    """Mock provider that returns predictable responses."""

    def __init__(self, responses: dict[LLMTier, str] | None = None):
        self._responses = responses or {}
        self.calls: list[tuple[str, LLMTier]] = []

    async def complete(self, prompt: str, tier: LLMTier) -> str:
        self.calls.append((prompt, tier))
        return self._responses.get(tier, "mock response")

    async def embed(self, text: str) -> list[float]:
        return [0.1] * 10


ROLES = [
    Role(id="r1", name="Physician", authority_rank=3),
    Role(id="r2", name="IRB", authority_rank=5),
    Role(id="r3", name="Patient", authority_rank=1),
]


@pytest.mark.asyncio
async def test_synthesize_tier1_no_llm():
    """Tier 1 synthesis should not call the LLM."""
    provider = MockProvider()
    contributions = [
        Contribution(id="c1", role_id="r1", content="Patient has severe migraine headache"),
        Contribution(id="c2", role_id="r2", content="Safety review completed for treatment protocol"),
    ]
    result = await synthesize_contributions(contributions, ROLES, LLMTier.KEYWORD, provider)
    assert len(provider.calls) == 0  # No LLM call for tier 1
    assert isinstance(result, str)
    assert len(result) > 0


@pytest.mark.asyncio
async def test_synthesize_tier2_calls_llm():
    """Tier 2 synthesis should call the LLM."""
    provider = MockProvider({LLMTier.CONFLICT: "Agreement on treatment, conflict on dosage"})
    contributions = [
        Contribution(id="c1", role_id="r1", content="Recommend 100mg dosage"),
        Contribution(id="c2", role_id="r2", content="Recommend 50mg dosage"),
    ]
    result = await synthesize_contributions(contributions, ROLES, LLMTier.CONFLICT, provider)
    assert len(provider.calls) == 1
    assert provider.calls[0][1] == LLMTier.CONFLICT
    assert "conflict on dosage" in result


@pytest.mark.asyncio
async def test_synthesize_empty():
    provider = MockProvider()
    result = await synthesize_contributions([], ROLES, LLMTier.KEYWORD, provider)
    assert result == ""


@pytest.mark.asyncio
async def test_detect_conflicts_no_overlap():
    """No structured field overlap — should return no conflicts."""
    provider = MockProvider()
    contributions = [
        Contribution(
            id="c1", role_id="r1", content="unique topic A",
            structured_fields={"field_a": "value"},
        ),
        Contribution(
            id="c2", role_id="r2", content="completely different topic B",
            structured_fields={"field_b": "value"},
        ),
    ]
    conflicts = await detect_conflicts(contributions, ROLES, provider)
    assert conflicts == []


@pytest.mark.asyncio
async def test_detect_conflicts_with_overlap():
    """Overlapping fields should trigger conflict detection."""
    conflict_response = json.dumps({
        "has_conflict": True,
        "description": "Disagreement on dosage",
        "severity": "high",
    })
    provider = MockProvider({LLMTier.CONFLICT: conflict_response})
    contributions = [
        Contribution(
            id="c1", role_id="r1", content="100mg",
            structured_fields={"dosage": "100mg"},
        ),
        Contribution(
            id="c2", role_id="r2", content="50mg",
            structured_fields={"dosage": "50mg"},
        ),
    ]
    conflicts = await detect_conflicts(contributions, ROLES, provider)
    assert len(conflicts) == 1
    assert conflicts[0].field_name == "dosage"
    assert conflicts[0].severity == "high"


@pytest.mark.asyncio
async def test_detect_conflicts_no_conflict_found():
    """LLM says no conflict — should return empty list."""
    no_conflict = json.dumps({
        "has_conflict": False,
        "description": "Both agree",
        "severity": "low",
    })
    provider = MockProvider({LLMTier.CONFLICT: no_conflict})
    contributions = [
        Contribution(
            id="c1", role_id="r1", content="agree",
            structured_fields={"field": "same thing"},
        ),
        Contribution(
            id="c2", role_id="r2", content="agree too",
            structured_fields={"field": "same thing basically"},
        ),
    ]
    conflicts = await detect_conflicts(contributions, ROLES, provider)
    assert conflicts == []


@pytest.mark.asyncio
async def test_generate_artifact():
    """Full pipeline: dedup -> conflict detect -> synthesis."""
    sections_json = json.dumps([
        {"title": "Treatment Plan", "content": "100mg sumatriptan approved by IRB"},
        {"title": "Safety Review", "content": "No contraindications found"},
    ])
    provider = MockProvider({
        LLMTier.CONFLICT: json.dumps({"has_conflict": False, "description": "", "severity": "low"}),
        LLMTier.SYNTHESIS: sections_json,
    })

    quorum = Quorum(
        id="q1",
        title="Clinical Trial Safety Review",
        description="Review safety data for Phase 2 trial",
        roles=ROLES,
    )
    contributions = [
        Contribution(id="c1", role_id="r1", content="Patient tolerating treatment well"),
        Contribution(id="c2", role_id="r2", content="Safety review shows no red flags"),
    ]

    artifact = await generate_artifact(quorum, contributions, provider)
    assert isinstance(artifact, ArtifactContent)
    assert len(artifact.sections) == 2
    assert artifact.sections[0].title == "Treatment Plan"
    assert artifact.content_hash != ""


@pytest.mark.asyncio
async def test_generate_artifact_empty():
    provider = MockProvider()
    quorum = Quorum(id="q1", title="Test", description="", roles=ROLES)
    artifact = await generate_artifact(quorum, [], provider)
    assert artifact.sections == []


@pytest.mark.asyncio
async def test_generate_artifact_fallback_parsing():
    """If LLM returns non-JSON, pipeline falls back to single section."""
    provider = MockProvider({
        LLMTier.CONFLICT: json.dumps({"has_conflict": False, "description": "", "severity": "low"}),
        LLMTier.SYNTHESIS: "This is a plain text synthesis result, not JSON.",
    })
    quorum = Quorum(id="q1", title="Test", description="", roles=ROLES)
    contributions = [
        Contribution(id="c1", role_id="r1", content="Some input"),
    ]
    artifact = await generate_artifact(quorum, contributions, provider)
    assert len(artifact.sections) == 1
    assert artifact.sections[0].title == "Synthesis"
