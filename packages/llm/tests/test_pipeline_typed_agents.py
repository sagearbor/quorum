"""Tests for checklist item 9.3 — typed Tier 2/3 pipeline agents.

Verifies that ``detect_conflicts`` and ``generate_artifact`` use the typed
``run_typed`` path when the provider supports it, and fall back to the
legacy ``complete`` + JSON-parse path when it doesn't.
"""

from __future__ import annotations

import pytest

from quorum_llm.models import (
    ArtifactContent,
    Contribution,
    LLMTier,
    Quorum,
    Role,
)
from quorum_llm.pipeline import detect_conflicts, generate_artifact
from quorum_llm.providers.mock import MockLLMProvider
from quorum_llm.typed_outputs import (
    ArtifactContentOutput,
    ConflictDetectionOutput,
)


ROLES = [
    Role(id="r1", name="Physician", authority_rank=3),
    Role(id="r2", name="IRB", authority_rank=5),
]


# ---------------------------------------------------------------------------
# detect_conflicts — typed path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_detect_conflicts_uses_typed_path_with_mock_provider():
    """MockLLMProvider overrides run_typed → pipeline uses typed output."""
    provider = MockLLMProvider()
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

    # The mock's canned ConflictDetectionOutput marks this as a conflict
    assert len(conflicts) >= 1
    assert conflicts[0].field_name == "dosage"  # fallback from loop context

    # Verify a typed call was made
    typed_calls = [
        c for c in provider.call_log
        if c.get("output_type") == "ConflictDetectionOutput"
    ]
    assert typed_calls, (
        "Expected at least one ConflictDetectionOutput typed call, got: "
        f"{provider.call_log}"
    )


# ---------------------------------------------------------------------------
# generate_artifact — typed path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_artifact_uses_typed_path_with_mock_provider():
    """MockLLMProvider overrides run_typed → pipeline returns a typed-validated
    ArtifactContent, with sections from the canned ArtifactContentOutput."""
    provider = MockLLMProvider()
    quorum = Quorum(
        id="q1",
        title="Mock Clinical Trial",
        description="Mock description",
        roles=ROLES,
    )
    contributions = [
        Contribution(id="c1", role_id="r1", content="Treatment well-tolerated"),
        Contribution(id="c2", role_id="r2", content="No red flags"),
    ]

    artifact = await generate_artifact(quorum, contributions, provider)
    assert isinstance(artifact, ArtifactContent)
    # MockLLMProvider's canned artifact has multiple sections
    assert len(artifact.sections) >= 2
    titles = [s.title for s in artifact.sections]
    assert "Protocol Summary" in titles
    assert artifact.content_hash != ""

    # Verify the typed synthesis call was made
    typed_calls = [
        c for c in provider.call_log
        if c.get("output_type") == "ArtifactContentOutput"
    ]
    assert typed_calls, (
        "Expected at least one ArtifactContentOutput typed call, got: "
        f"{provider.call_log}"
    )


# ---------------------------------------------------------------------------
# Schema validation — output models reject malformed payloads
# ---------------------------------------------------------------------------


def test_conflict_detection_output_schema_validates():
    """ConflictDetectionOutput must accept valid inputs and reject malformed."""
    from pydantic import ValidationError

    good = ConflictDetectionOutput(
        conflicts=[],
        confidence=0.5,
        notes="all aligned",
    )
    assert good.conflicts == []

    # Severity outside the literal set is rejected
    with pytest.raises(ValidationError):
        ConflictDetectionOutput.model_validate(
            {"conflicts": [{"description": "x", "severity": "extreme"}]}
        )

    # Confidence outside [0, 1] is rejected
    with pytest.raises(ValidationError):
        ConflictDetectionOutput(conflicts=[], confidence=1.5)


def test_artifact_content_output_requires_at_least_one_section():
    """ArtifactContentOutput.sections has min_length=1."""
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ArtifactContentOutput(sections=[])

    good = ArtifactContentOutput.model_validate(
        {"sections": [{"title": "T", "content": "C"}]}
    )
    assert len(good.sections) == 1


# ---------------------------------------------------------------------------
# Legacy MockProvider (test_pipeline.py) still works — backward compat
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_legacy_mockprovider_in_test_pipeline_still_works():
    """The MockProvider in test_pipeline.py only stubs ``complete`` — make
    sure the pipeline detects the ABC-default run_typed and falls back."""
    import json
    from quorum_llm.interface import LLMProvider

    class LegacyMockProvider(LLMProvider):
        def __init__(self):
            self.calls: list[tuple[str, LLMTier]] = []

        async def complete(self, prompt, tier):
            self.calls.append((prompt, tier))
            if tier == LLMTier.CONFLICT:
                return json.dumps({
                    "has_conflict": True,
                    "description": "Disagreement",
                    "severity": "high",
                })
            if tier == LLMTier.SYNTHESIS:
                return json.dumps([
                    {"title": "Summary", "content": "Body"},
                ])
            return ""

        async def embed(self, text):
            return [0.1] * 10

    provider = LegacyMockProvider()
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
    assert conflicts[0].severity == "high"

    quorum = Quorum(id="q1", title="t", description="d", roles=ROLES)
    artifact = await generate_artifact(quorum, contributions, provider)
    assert len(artifact.sections) == 1
    assert artifact.sections[0].title == "Summary"


# ---------------------------------------------------------------------------
# Pydantic AI auto-retry: malformed JSON is handled by the typed agent,
# not by our try/except.  We can't test the actual retry against a real
# provider here, but we can verify that a provider raising ValueError from
# run_typed propagates correctly.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_typed_validation_error_is_handled_by_pipeline():
    """If run_typed raises ValueError (validation failure), the pipeline
    logs a warning and skips the field — same shape as the legacy path."""
    from quorum_llm.interface import LLMProvider

    class FailingTypedProvider(LLMProvider):
        async def complete(self, prompt, tier):
            return ""

        async def embed(self, text):
            return [0.0] * 10

        async def run_typed(
            self, prompt, tier, *, output_type, instructions=None,
            temperature=None, max_tokens=None,
        ):
            raise ValueError("simulated validation failure")

    provider = FailingTypedProvider()
    contributions = [
        Contribution(
            id="c1", role_id="r1", content="x",
            structured_fields={"f": "a"},
        ),
        Contribution(
            id="c2", role_id="r2", content="y",
            structured_fields={"f": "b"},
        ),
    ]
    # The exception is caught and logged; no conflicts surface.
    conflicts = await detect_conflicts(contributions, ROLES, provider)
    assert conflicts == []
