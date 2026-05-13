"""Pydantic output schemas for Tier 2 / Tier 3 typed agent calls (item 9.3).

Pydantic AI's ``Agent.run(..., output_type=...)`` validates the model's
response against a Pydantic ``BaseModel`` and retries on validation errors.
That replaces the manual ``json.loads`` + regex-strip-fences glue we used to
carry in ``architect_agent.generate_roles`` and ``pipeline.detect_conflicts`` /
``pipeline.generate_artifact``.

We define **new** Pydantic models here rather than reusing the dataclasses in
``quorum_llm.models``:

* The dataclasses in ``models.py`` are runtime-only payloads — they don't have
  Pydantic validators, JSON Schema generation, or the per-field metadata that
  Pydantic AI's tool-use mode needs.
* Keeping the typed-output schemas separate means callers that synthesise these
  outputs from scratch (tests, demo fixtures) can keep using the lightweight
  dataclasses.  Only the LLM round-trip goes through the Pydantic models, and
  we convert back to dataclasses at the call site.

The conversion helpers at the bottom of this file (``to_conflict``,
``to_artifact_content``) do that final dataclass conversion so the public
contract of ``detect_conflicts`` / ``generate_artifact`` is unchanged.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from quorum_llm.models import (
    ArtifactContent,
    ArtifactSection,
    Conflict,
)


# ---------------------------------------------------------------------------
# Tier 2 — conflict detection
# ---------------------------------------------------------------------------


class ConflictOutput(BaseModel):
    """A single conflict identified between contributions.

    Mirrors ``quorum_llm.models.Conflict`` (the runtime dataclass) but as a
    Pydantic BaseModel so Pydantic AI can validate the LLM response against it.
    """

    contribution_ids: list[str] = Field(
        default_factory=list,
        description=(
            "IDs of the contributions that are in conflict.  May be empty when "
            "the LLM cannot resolve which specific contributions overlap — the "
            "caller will then fall back to the field-level grouping."
        ),
    )
    field_name: str = Field(
        default="",
        description="The structured field where the conflict surfaces (e.g. 'dosage').",
    )
    description: str = Field(
        ...,
        description="A 1-2 sentence summary of the disagreement.",
    )
    severity: Literal["low", "medium", "high"] = Field(
        default="medium",
        description="Severity of the conflict for downstream prioritisation.",
    )


class ConflictDetectionOutput(BaseModel):
    """Typed output schema for the Tier 2 conflict-detection LLM call.

    The LLM is asked to inspect a set of overlapping contributions and produce
    zero-or-more ``ConflictOutput`` records in a single round-trip.  The public
    ``detect_conflicts`` function still loops per overlapping field so the
    cost-per-call shape is unchanged for the budget tracker; each typed call
    returns a ``ConflictDetectionOutput`` containing the conflicts (if any)
    the model identified for that field.

    ``confidence`` and ``notes`` are informational only; the public
    ``detect_conflicts`` function returns ``list[Conflict]`` to preserve its
    contract, and the extra fields are logged for observability.
    """

    conflicts: list[ConflictOutput] = Field(
        default_factory=list,
        description="The list of conflicts the model identified (may be empty).",
    )
    confidence: float = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        description="Model's self-reported confidence in the conflict assessment.",
    )
    notes: str | None = Field(
        default=None,
        description="Optional free-text notes — e.g. 'all contributions align'.",
    )


# ---------------------------------------------------------------------------
# Tier 3 — artifact synthesis
# ---------------------------------------------------------------------------


class ArtifactSectionOutput(BaseModel):
    """One section of the final artifact, validated by Pydantic."""

    title: str = Field(
        ...,
        description="Short section heading (e.g. 'Protocol Summary').",
    )
    content: str = Field(
        ...,
        description="Body text of the section, in plain markdown-compatible prose.",
    )


class ArtifactContentOutput(BaseModel):
    """Typed output for the Tier 3 synthesis call.

    Pydantic AI returns a fully-validated instance — no more manual
    ``json.loads(text[text.find('['):text.rfind(']')+1])`` defensive parsing.
    The wrapper-with-list shape is preferred over ``list[ArtifactSectionOutput]``
    directly because some Pydantic AI provider profiles do not yet support
    list-as-root for ``output_type`` (e.g. some Ollama models).  Wrapping in
    an object also gives us room to add ``summary`` / ``confidence`` fields
    later without breaking the contract.
    """

    sections: list[ArtifactSectionOutput] = Field(
        ...,
        min_length=1,
        description="Ordered list of artifact sections; must contain at least one.",
    )


# ---------------------------------------------------------------------------
# Conversion helpers — typed-output models → runtime dataclasses
# ---------------------------------------------------------------------------


def to_conflict(
    output: ConflictOutput,
    *,
    fallback_field: str = "",
    fallback_ids: list[str] | None = None,
) -> Conflict:
    """Convert a ``ConflictOutput`` Pydantic model into the runtime dataclass.

    ``fallback_field`` / ``fallback_ids`` are used when the LLM omitted these
    fields — common when the model can only see the field name once in the
    prompt and doesn't re-emit it in the structured output.
    """
    return Conflict(
        contribution_ids=list(output.contribution_ids or (fallback_ids or [])),
        field_name=output.field_name or fallback_field,
        description=output.description,
        severity=output.severity,
    )


def to_artifact_content(
    output: ArtifactContentOutput,
    source_contribution_ids: list[str],
) -> ArtifactContent:
    """Convert a ``ArtifactContentOutput`` Pydantic model into the dataclass.

    ``source_contribution_ids`` flows in from the caller so every section
    carries the full set of contribution IDs that fed the synthesis (matches
    the legacy behaviour where each section was attributed to all contributions).
    The ``content_hash`` is computed by the caller after this conversion so
    pipeline.py stays the single source of truth for hashing.
    """
    sections = [
        ArtifactSection(
            title=s.title,
            content=s.content,
            source_contribution_ids=list(source_contribution_ids),
        )
        for s in output.sections
    ]
    return ArtifactContent(sections=sections)
