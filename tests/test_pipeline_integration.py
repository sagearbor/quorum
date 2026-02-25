"""Integration tests for the LLM synthesis pipeline using MockLLMProvider.

Tests the full Tier 1 → Tier 2 → Tier 3 pipeline without any API calls.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from quorum_llm import (
    Contribution,
    LLMTier,
    Quorum,
    Role,
    detect_conflicts,
    extract_keywords,
    find_overlapping_fields,
    generate_artifact,
    synthesize_contributions,
)
from quorum_llm.providers.mock import MockLLMProvider

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture
def provider():
    return MockLLMProvider()


@pytest.fixture
def clinical_roles():
    return [
        Role(id="role-pi", name="Principal Investigator", authority_rank=2, capacity=1),
        Role(id="role-irb", name="IRB Representative", authority_rank=3, capacity=1),
        Role(id="role-biostat", name="Biostatistician", authority_rank=1, capacity="unlimited"),
    ]


@pytest.fixture
def clinical_contributions():
    return [
        Contribution(
            id="contrib-001",
            role_id="role-pi",
            content="Recommend 12-week dosing interval based on Phase I pharmacokinetics",
            structured_fields={
                "dosing_interval": "12 weeks between administrations",
                "rationale": "Phase I PK data shows adequate drug levels at 12-week trough",
            },
        ),
        Contribution(
            id="contrib-002",
            role_id="role-irb",
            content="Require 6-week safety review checkpoints for participant protection",
            structured_fields={
                "dosing_interval": "6-week mandatory safety review before re-dosing",
                "safety_requirements": "DSMB review required at each checkpoint",
            },
        ),
        Contribution(
            id="contrib-003",
            role_id="role-biostat",
            content="Power analysis indicates 240 participants needed for 0.82 power",
            structured_fields={
                "sample_size": "240 participants",
                "power": "0.82 at alpha=0.05",
            },
        ),
    ]


class TestTier1:
    def test_keyword_extraction(self):
        text = "Phase II clinical trial for treatment-resistant hypertension"
        keywords = extract_keywords(text)
        assert len(keywords) > 0
        assert "clinical" in keywords or "trial" in keywords

    def test_overlapping_fields_detected(self, clinical_contributions):
        fields_lists = [c.structured_fields for c in clinical_contributions]
        overlaps = find_overlapping_fields(fields_lists)
        assert "dosing_interval" in overlaps
        assert len(overlaps["dosing_interval"]) == 2

    @pytest.mark.asyncio
    async def test_tier1_synthesis(self, clinical_contributions, clinical_roles, provider):
        result = await synthesize_contributions(
            clinical_contributions, clinical_roles, LLMTier.KEYWORD, provider
        )
        assert isinstance(result, str)
        assert len(result) > 0


class TestTier2:
    @pytest.mark.asyncio
    async def test_conflict_detection(self, clinical_contributions, clinical_roles, provider):
        conflicts = await detect_conflicts(clinical_contributions, clinical_roles, provider)
        # Should detect conflict on dosing_interval
        assert len(conflicts) >= 1
        conflict = conflicts[0]
        assert conflict.field_name == "dosing_interval"
        assert conflict.severity == "high"

    @pytest.mark.asyncio
    async def test_golden_fixture_match(self, provider):
        with open(FIXTURES / "tier2_conflict.json") as f:
            fixture = json.load(f)

        inp = fixture["input"]
        roles = [Role(**r) for r in inp["roles"]]
        contribs = [Contribution(**c) for c in inp["contributions"]]

        conflicts = await detect_conflicts(contribs, roles, provider)
        assert len(conflicts) >= 1
        assert conflicts[0].severity == fixture["expected_output"]["severity"]

    @pytest.mark.asyncio
    async def test_no_conflict_with_unique_fields(self, provider):
        roles = [
            Role(id="r1", name="Role A", authority_rank=1),
            Role(id="r2", name="Role B", authority_rank=2),
        ]
        contribs = [
            Contribution(id="c1", role_id="r1", content="unique content A",
                         structured_fields={"field_a": "value A"}),
            Contribution(id="c2", role_id="r2", content="unique content B",
                         structured_fields={"field_b": "value B"}),
        ]
        conflicts = await detect_conflicts(contribs, roles, provider)
        assert len(conflicts) == 0


class TestTier3:
    @pytest.mark.asyncio
    async def test_artifact_generation(
        self, clinical_contributions, clinical_roles, provider
    ):
        quorum = Quorum(
            id="quorum-001",
            title="Phase II Clinical Trial Protocol",
            description="Multi-site trial for treatment-resistant hypertension",
            roles=clinical_roles,
        )
        artifact = await generate_artifact(quorum, clinical_contributions, provider)
        assert len(artifact.sections) >= 1
        assert artifact.content_hash != ""
        # Sections should have titles and content
        for section in artifact.sections:
            assert section.title
            assert section.content

    @pytest.mark.asyncio
    async def test_golden_fixture_match(self, provider):
        with open(FIXTURES / "tier3_artifact.json") as f:
            fixture = json.load(f)

        inp = fixture["input"]
        roles = [Role(**r) for r in inp["quorum"]["roles"]]
        contribs = [Contribution(**c) for c in inp["contributions"]]
        quorum = Quorum(
            id=inp["quorum"]["id"],
            title=inp["quorum"]["title"],
            description=inp["quorum"]["description"],
            roles=roles,
        )

        artifact = await generate_artifact(quorum, contribs, provider)
        expected_titles = {s["title"] for s in fixture["expected_output"]["sections"]}
        actual_titles = {s.title for s in artifact.sections}
        # Mock provider returns the same 4 sections
        assert expected_titles == actual_titles

    @pytest.mark.asyncio
    async def test_empty_contributions(self, clinical_roles, provider):
        quorum = Quorum(
            id="q1", title="Empty", description="No contributions", roles=clinical_roles,
        )
        artifact = await generate_artifact(quorum, [], provider)
        assert artifact.sections == []
        assert artifact.content_hash != ""

    @pytest.mark.asyncio
    async def test_artifact_content_hash_stable(
        self, clinical_contributions, clinical_roles, provider
    ):
        quorum = Quorum(
            id="q1", title="Test", description="Stability test", roles=clinical_roles,
        )
        a1 = await generate_artifact(quorum, clinical_contributions, provider)
        a2 = await generate_artifact(quorum, clinical_contributions, provider)
        assert a1.content_hash == a2.content_hash


class TestFullPipeline:
    @pytest.mark.asyncio
    async def test_end_to_end(self, clinical_contributions, clinical_roles, provider):
        """Full pipeline: Tier 1 → Tier 2 → Tier 3."""
        # Step 1: Tier 1 keyword extraction
        keywords = await synthesize_contributions(
            clinical_contributions, clinical_roles, LLMTier.KEYWORD, provider
        )
        assert len(keywords) > 0

        # Step 2: Tier 2 conflict detection
        conflicts = await detect_conflicts(
            clinical_contributions, clinical_roles, provider
        )
        assert len(conflicts) >= 1

        # Step 3: Tier 3 artifact generation
        quorum = Quorum(
            id="q1",
            title="Clinical Trial",
            description="Full pipeline test",
            roles=clinical_roles,
        )
        artifact = await generate_artifact(quorum, clinical_contributions, provider)
        assert len(artifact.sections) >= 1
        assert artifact.content_hash

        # Verify provider was called at Tier 2 and 3
        # (Tier 1 is deterministic and handled by the pipeline module directly,
        # so it won't appear in the provider's call log unless called explicitly)
        tiers_called = {entry["tier"] for entry in provider.call_log if isinstance(entry["tier"], int)}
        assert 2 in tiers_called, f"Tier 2 not called. Tiers seen: {tiers_called}"
        assert 3 in tiers_called, f"Tier 3 not called. Tiers seen: {tiers_called}"
