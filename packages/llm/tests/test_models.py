"""Tests for data models."""

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


def test_llm_tier_values():
    assert LLMTier.KEYWORD == 1
    assert LLMTier.CONFLICT == 2
    assert LLMTier.SYNTHESIS == 3


def test_llm_tier_ordering():
    assert LLMTier.KEYWORD < LLMTier.CONFLICT < LLMTier.SYNTHESIS


def test_role_defaults():
    role = Role(id="r1", name="IRB", authority_rank=3)
    assert role.capacity == "unlimited"


def test_contribution_defaults():
    c = Contribution(id="c1", role_id="r1", content="test")
    assert c.structured_fields == {}
    assert c.tier_processed == 1


def test_conflict():
    c = Conflict(
        contribution_ids=["c1", "c2"],
        field_name="diagnosis",
        description="Conflicting diagnoses",
        severity="high",
    )
    assert len(c.contribution_ids) == 2
    assert c.severity == "high"


def test_artifact_content():
    sections = [
        ArtifactSection(title="Summary", content="...", source_contribution_ids=["c1"]),
    ]
    artifact = ArtifactContent(sections=sections, content_hash="abc123")
    assert len(artifact.sections) == 1
    assert artifact.conflicts_resolved == []


def test_budget_exhausted_error():
    err = BudgetExhaustedError(provider="azure", tier=LLMTier.CONFLICT, detail="429")
    assert "azure" in str(err)
    assert "CONFLICT" in str(err)
    assert not err.event_owner_notified
