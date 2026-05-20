"""Before/After position synthesizer — Tier-2 LLM summary of group state.

Captures two snapshots per quorum:

* ``initial_position`` — fired after contribution #3 lands.  There is no
  "before" yet at this stage, so the system prompt instructs the model to
  set every ``before`` equal to ``after`` and ``changed=false``.
* ``final_position`` — fired in /resolve after the existing Tier-3
  synthesis completes.  The ``before`` reflects what the group said early
  on; ``after`` is the current state.

Each snapshot is a :class:`PositionSnapshot` containing:

* ``summary_sentences`` — exactly 3 plain-English sentences summarising the
  group's stance.  Drives the headline-rewrite visual on the frontend.
* ``headline`` — ≤80-char headline.  The "before vs after" headline change
  is the dominant visual on the Before/After dashboard.
* ``key_aspects`` — up to 12 :class:`FieldChange` rows showing field-level
  diffs.  ``drivers`` MUST be contribution IDs drawn from the supplied
  list; rows with unknown driver IDs are dropped during post-call
  validation rather than rejected wholesale (we keep the valid rows).
* ``unresolved`` — up to 6 short strings describing open questions /
  pending decisions.

The post-call validator is intentionally lenient: bad rows are dropped, not
the whole snapshot.  An expo-floor demo should never see a 500 because
the LLM hallucinated a contribution_id.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Literal

from pydantic import BaseModel, Field, field_validator

from quorum_llm.models import Contribution, LLMTier, Role

logger = logging.getLogger(__name__)


# Display caps — keep the frontend visual bounded.
_BEFORE_AFTER_MAX = 120
_HEADLINE_MAX = 80
_SUMMARY_COUNT = 3
_KEY_ASPECTS_MAX = 12
_UNRESOLVED_MAX = 6


class FieldChange(BaseModel):
    """One field-level diff in a PositionSnapshot."""

    field: str = Field(
        ...,
        min_length=1,
        description=(
            "Short field name, e.g. 'scope', 'cadence', 'consent_requirement'. "
            "snake_case preferred but not enforced."
        ),
    )
    before: str = Field(
        ...,
        max_length=_BEFORE_AFTER_MAX,
        description="What the group said early on (≤120 chars).",
    )
    after: str = Field(
        ...,
        max_length=_BEFORE_AFTER_MAX,
        description="Current state (≤120 chars).",
    )
    changed: bool = Field(
        default=False,
        description="True iff before != after.  Must be False for initial.",
    )
    drivers: list[str] = Field(
        default_factory=list,
        description=(
            "Contribution IDs that drove this change.  MUST be drawn from the "
            "contribution list supplied to the prompt; invalid IDs cause the "
            "row to be dropped at post-validation."
        ),
    )

    @field_validator("before", "after", mode="before")
    @classmethod
    def _coerce_string(cls, v: Any) -> str:
        """Coerce non-strings to strings and trim — keep the schema forgiving."""
        if v is None:
            return ""
        return str(v).strip()


class PositionSnapshot(BaseModel):
    """A typed snapshot of where the group stands at one moment in time."""

    summary_sentences: list[str] = Field(
        ...,
        min_length=_SUMMARY_COUNT,
        max_length=_SUMMARY_COUNT,
        description="Exactly 3 sentences summarising the group's stance.",
    )
    headline: str = Field(
        ...,
        max_length=_HEADLINE_MAX,
        description="≤80-char headline driving the headline-rewrite visual.",
    )
    key_aspects: list[FieldChange] = Field(
        default_factory=list,
        max_length=_KEY_ASPECTS_MAX,
        description="Up to 12 field-level diffs.",
    )
    unresolved: list[str] = Field(
        default_factory=list,
        max_length=_UNRESOLVED_MAX,
        description="Up to 6 short strings naming open questions.",
    )


_SYSTEM_INSTRUCTIONS = (
    "You are summarizing the group's position on a deliberation. For each "
    "key_aspect, the `before` is what the group said early on; the `after` "
    "is the current state. If `stage=initial`, set every `before` equal to "
    "`after` and `changed=false` — there is no prior state yet. Drivers "
    "MUST be contribution_ids drawn from the supplied list; never invent ids."
)


def _format_role(role: Role) -> str:
    cap = role.capacity if role.capacity is not None else "unlimited"
    return f"- {role.name} (rank {role.authority_rank}, capacity={cap})"


def _format_contribution(c: Contribution, role_lookup: dict[str, str]) -> str:
    """One line per contribution — ID is the load-bearing token."""
    role_name = role_lookup.get(c.role_id) or c.role_id
    body = (c.content or "").strip().replace("\n", " ")
    if len(body) > 320:
        body = body[:317] + "..."
    return f"- [{c.id}] ({role_name}) {body}"


def _format_chat(msg: Any) -> str | None:
    """Render a StationMessage-shaped dict or object as one prompt line.

    The chat list is best-effort: contributions are the load-bearing input;
    station chats add color.  We accept either dicts (as they come back from
    Supabase) or objects with ``role_id`` / ``content`` attributes.
    """
    if msg is None:
        return None
    if isinstance(msg, dict):
        content = msg.get("content")
        role = msg.get("role") or msg.get("role_name") or msg.get("role_id") or "?"
    else:
        content = getattr(msg, "content", None)
        role = (
            getattr(msg, "role_name", None)
            or getattr(msg, "role", None)
            or getattr(msg, "role_id", "?")
        )
    if not content:
        return None
    body = str(content).strip().replace("\n", " ")
    if len(body) > 240:
        body = body[:237] + "..."
    return f"- ({role}) {body}"


def _build_prompt(
    role_definitions: list[Role],
    contributions: list[Contribution],
    chats: list[Any],
    stage: Literal["initial", "final"],
) -> str:
    role_lookup = {r.id: r.name for r in role_definitions}
    role_block = "\n".join(_format_role(r) for r in role_definitions) or "(none)"
    contrib_block = (
        "\n".join(_format_contribution(c, role_lookup) for c in contributions)
        or "(none)"
    )
    chat_lines = [line for line in (_format_chat(m) for m in (chats or [])) if line]
    chat_block = "\n".join(chat_lines) if chat_lines else "(none)"

    stage_note = (
        "STAGE = initial. There is no prior 'before' state yet — for every "
        "key_aspect set before == after and changed=false."
        if stage == "initial"
        else "STAGE = final. The 'before' should reflect what the group said "
        "early on; 'after' should reflect the current state. Set changed=true "
        "only when before != after."
    )

    return (
        f"{stage_note}\n\n"
        "Roles:\n"
        f"{role_block}\n\n"
        "Contributions (use these IDs in `drivers`; do not invent any):\n"
        f"{contrib_block}\n\n"
        "Station chat (context only, no IDs):\n"
        f"{chat_block}\n\n"
        "Produce a PositionSnapshot summarising the group's position. "
        "summary_sentences must contain exactly 3 sentences. headline must be "
        f"≤{_HEADLINE_MAX} characters. key_aspects ≤{_KEY_ASPECTS_MAX} rows. "
        f"unresolved ≤{_UNRESOLVED_MAX} items."
    )


def _validate_snapshot(
    snapshot: PositionSnapshot,
    valid_contribution_ids: Iterable[str],
    stage: Literal["initial", "final"],
) -> PositionSnapshot:
    """Drop bad rows; never fail the whole snapshot.

    Rules:

    * ``field`` must be a non-empty stripped string.
    * Every entry in ``drivers`` must be in ``valid_contribution_ids``;
      unknown IDs are removed from the drivers list (we do NOT drop the
      whole row for one bad ID — keep as much signal as possible).
    * For ``stage == "initial"``: force ``changed = False`` and ``before =
      after`` so the contract is enforced even if the LLM ignored the
      system prompt.
    * Clamp ``key_aspects`` to ``_KEY_ASPECTS_MAX`` entries.
    """
    valid_ids = set(valid_contribution_ids)
    cleaned_aspects: list[FieldChange] = []
    for row in snapshot.key_aspects or []:
        field_name = (row.field or "").strip()
        if not field_name:
            continue
        # Filter drivers to known IDs; keep the row even if zero drivers
        # remain (caller can render "no attributed driver" gracefully).
        filtered_drivers = [d for d in (row.drivers or []) if d in valid_ids]
        before = row.before
        after = row.after
        changed = bool(row.changed)
        if stage == "initial":
            # Initial-stage contract: before == after, changed=False.
            before = after
            changed = False
        cleaned_aspects.append(
            FieldChange(
                field=field_name,
                before=before,
                after=after,
                changed=changed,
                drivers=filtered_drivers,
            )
        )
        if len(cleaned_aspects) >= _KEY_ASPECTS_MAX:
            break

    return PositionSnapshot(
        summary_sentences=list(snapshot.summary_sentences)[:_SUMMARY_COUNT]
        + [""] * max(0, _SUMMARY_COUNT - len(snapshot.summary_sentences)),
        headline=(snapshot.headline or "")[:_HEADLINE_MAX],
        key_aspects=cleaned_aspects,
        unresolved=list(snapshot.unresolved or [])[:_UNRESOLVED_MAX],
    )


async def synthesize_position(
    role_definitions: list[Role],
    contributions: list[Contribution],
    chats: list[Any],
    stage: Literal["initial", "final"],
    llm_provider: Any,
) -> PositionSnapshot:
    """Run one Tier-2 LLM call to produce a PositionSnapshot.

    Parameters
    ----------
    role_definitions
        All roles in the quorum (name + authority_rank + capacity).  Names
        are surfaced in the prompt so the LLM can reason about authority.
    contributions
        All contributions on the quorum.  IDs are passed through to the
        prompt and used as the allowlist for ``FieldChange.drivers``.
    chats
        Optional list of station messages — best-effort context, not load-
        bearing.  Pass an empty list when no chats are available.
    stage
        ``"initial"`` or ``"final"``.  Controls system-prompt wording and
        the post-call validator (initial forces ``changed=False``).
    llm_provider
        Anything implementing the ``LLMProvider`` ABC.

    Returns
    -------
    PositionSnapshot
        Validated, lenient-cleaned snapshot.  Never raises on bad LLM rows
        — invalid driver IDs are stripped, oversize aspect lists are
        clamped, and the initial-stage contract is enforced post-hoc.

    Raises
    ------
    Exception
        Propagates whatever the provider raises (network / parse / budget).
        Callers in routes.py wrap this in try/except so a failure never
        blocks /contribute or /resolve.
    """
    prompt = _build_prompt(role_definitions, contributions, chats, stage)
    raw = await llm_provider.run_typed(
        prompt,
        LLMTier.AGENT_CHAT,
        output_type=PositionSnapshot,
        instructions=_SYSTEM_INSTRUCTIONS,
    )
    valid_ids = [c.id for c in contributions]
    return _validate_snapshot(raw, valid_ids, stage)
