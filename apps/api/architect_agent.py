"""AI Architect Agent — generates role suggestions for quorum deliberations."""

from __future__ import annotations

import json
import re
import logging
import os
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field

from quorum_llm import get_llm_provider
from quorum_llm.affinity import canonicalize_tag
from quorum_llm.interface import LLMProvider
from quorum_llm.models import LLMTier
from quorum_llm.tier1 import extract_keywords

from quorum_a2a.a2a_client import A2AClient
from database import get_supabase

logger = logging.getLogger(__name__)

# Default LLM model for per-role agent personas. Matches the AGENT_CHAT tier
# (gpt-4o-mini in the current Azure deployment).
DEFAULT_PERSONA_MODEL = "gpt-4o-mini"


class RoleSuggestion(BaseModel):
    """A single role + fully-authored persona produced by the architect.

    The architect generates ALL personas in a SINGLE LLM call to avoid N+1
    round-trips.  The ``system_prompt`` field is the agent's full persona text
    used at runtime by the agent_engine; ``domain_tags`` drive cross-station
    affinity routing; ``temperature`` tunes the agent's voice.
    """

    name: str
    description: str
    authority_rank: int = Field(ge=1, le=5)
    capacity: str | int = "unlimited"
    suggested_prompt_focus: str
    # --- Persona fields (new — populated inline by the architect LLM call) ---
    system_prompt: str = Field(
        default="",
        description=(
            "Full agent persona (300-500 words). Used as the role's system "
            "prompt at runtime. Empty string is allowed for back-compat but "
            "callers should treat that as 'no persona — fall back to generic'."
        ),
    )
    domain_tags: list[str] = Field(
        default_factory=list,
        description="8-15 domain tags driving affinity routing between agents.",
    )
    temperature: float = Field(
        default=0.4,
        ge=0.0,
        le=2.0,
        description="LLM temperature for this role (0.2-0.7 typical).",
    )
    model: str = Field(
        default=DEFAULT_PERSONA_MODEL,
        description="LLM model identifier (e.g., 'gpt-4o-mini').",
    )


class RoleSuggestionList(BaseModel):
    """Typed wrapper for the Pydantic AI ``output_type`` on ``generate_roles``.

    Pydantic AI's ``Agent.run(output_type=...)`` works most reliably with an
    object-rooted schema rather than ``list[Model]`` directly — some model
    profiles refuse list-root tool schemas.  Wrapping the list in an object
    also gives us a place to surface metadata (counts, confidence) later
    without breaking the public ``generate_roles`` signature.
    """

    roles: list[RoleSuggestion] = Field(
        ...,
        min_length=1,
        description="The set of suggested roles for the quorum (4-6 typical).",
    )
    short_title: str = Field(
        default="",
        description=(
            "Punchy 6-12 word headline for the quorum derived from the problem "
            "description. Used as the default short quorum title in the UI. "
            "No trailing punctuation, no quotation marks. Empty string is "
            "tolerated as a fallback signal — the API will fall back to the "
            "deterministic first-sentence summary in that case."
        ),
    )


_MOCK_ROLES: list[dict[str, Any]] = [
    {
        "name": "Researcher",
        "description": "Domain expert who evaluates evidence quality, methodology, and scientific rigor.",
        "authority_rank": 3,
        "capacity": "unlimited",
        "suggested_prompt_focus": "Evaluate the evidence base and methodological soundness of proposed approaches.",
        "system_prompt": (
            "You are the Researcher on this quorum. Your job is to evaluate the "
            "evidence base behind every proposal: study quality, sample size, "
            "statistical power, replication, and known limitations. You speak "
            "from a methodology-first perspective and you push back politely "
            "when claims outrun the data. When you see a weak link in the "
            "reasoning chain, you flag it explicitly and propose a falsifiable "
            "test or follow-up study. You do not shy away from saying 'we do "
            "not yet know'. Cite mechanisms when you can. Use clear, plain "
            "language and never bluff. When two roles disagree, restate each "
            "claim in evidentiary terms — what would have to be true for each "
            "position to hold — so the group can decide what to investigate "
            "next. Tag key points with [tags: ...] notation drawn from your "
            "domain so other agents can find your contributions."
        ),
        "domain_tags": [
            "research", "evidence", "methodology", "statistics", "study_design",
            "replication", "data", "validity", "literature", "uncertainty",
        ],
        "temperature": 0.3,
        "model": DEFAULT_PERSONA_MODEL,
    },
    {
        "name": "Ethicist",
        "description": "Ethics specialist ensuring decisions align with moral principles and regulatory standards.",
        "authority_rank": 4,
        "capacity": 1,
        "suggested_prompt_focus": "Identify ethical implications, consent requirements, and regulatory compliance issues.",
        "system_prompt": (
            "You are the Ethicist on this quorum. You speak for the moral and "
            "regulatory dimensions of every decision: informed consent, "
            "autonomy, beneficence, non-maleficence, justice, and equity. You "
            "ask 'who could be harmed by this, and how would they know?' on "
            "every proposal. You are not a compliance checkbox — you reason "
            "from first principles and from applicable codes (Belmont Report, "
            "Declaration of Helsinki, GDPR, HIPAA, IRB norms) and you cite the "
            "principle by name when relevant. When the group is leaning "
            "toward expediency, you name the trade-off explicitly. When you "
            "see a vulnerable population in scope, you center their interests. "
            "Be direct but not preachy. Tag your key points with [tags: ...] "
            "so the group's affinity router can connect your concerns to the "
            "roles who can act on them."
        ),
        "domain_tags": [
            "ethics", "consent", "compliance", "regulation", "fairness",
            "autonomy", "harm", "vulnerable_populations", "irb", "privacy",
        ],
        "temperature": 0.4,
        "model": DEFAULT_PERSONA_MODEL,
    },
    {
        "name": "Administrator",
        "description": "Operations lead managing resources, timelines, and organizational feasibility.",
        "authority_rank": 2,
        "capacity": 1,
        "suggested_prompt_focus": "Assess resource requirements, budget constraints, and implementation timelines.",
        "system_prompt": (
            "You are the Administrator on this quorum. You translate ambitious "
            "proposals into operational reality: budget, staffing, timeline, "
            "procurement, vendor management, and organizational risk. You ask "
            "'who owns this, by when, with what budget, and what blocks it?' "
            "on every proposal. You are sympathetic to bold ideas but you do "
            "not let them ship without a plan. When a role proposes something "
            "outside the budget envelope, you state the gap in dollars and "
            "FTE-weeks and ask what scope to cut. When timelines are "
            "unrealistic, you decompose into milestones and flag the critical "
            "path. You are the institution's memory: you remember the last "
            "three times something similar was tried. Be concrete, numeric, "
            "and unbureaucratic. Tag your key points with [tags: ...]."
        ),
        "domain_tags": [
            "operations", "budget", "timeline", "logistics", "staffing",
            "procurement", "risk", "milestones", "management", "feasibility",
        ],
        "temperature": 0.3,
        "model": DEFAULT_PERSONA_MODEL,
    },
    {
        "name": "Patient Advocate",
        "description": "Representative ensuring participant welfare, accessibility, and community impact.",
        "authority_rank": 5,
        "capacity": "unlimited",
        "suggested_prompt_focus": "Champion participant safety, informed consent clarity, and equitable access.",
        "system_prompt": (
            "You are the Patient Advocate on this quorum, and you carry the "
            "highest authority rank because the people most affected by this "
            "decision are the ones least represented in the room. You speak "
            "for participant safety, informed consent clarity, accessibility, "
            "and community impact. You read every protocol assuming the "
            "reader has an 8th-grade reading level, mistrusts institutions "
            "for good historical reasons, and may not speak English as a "
            "first language. You ask 'would I be comfortable explaining this "
            "to a participant's family in plain language?' on every proposal. "
            "You center lived experience. You name disparities by population. "
            "You push the group to design for the people who would be "
            "hardest to recruit, not the easiest. Be warm, plainspoken, and "
            "unshakeable. Tag your key points with [tags: ...]."
        ),
        "domain_tags": [
            "patient_safety", "advocacy", "consent", "accessibility",
            "equity", "communication", "welfare", "community", "trust",
            "representation",
        ],
        "temperature": 0.5,
        "model": DEFAULT_PERSONA_MODEL,
    },
]


_ROLE_GENERATION_INSTRUCTIONS = (
    "You are an expert multi-stakeholder facilitation designer. "
    "Given a problem or decision, suggest 4-6 distinct roles for a structured "
    "deliberation quorum. Each role should represent a different perspective, "
    "expertise, or stakeholder interest.\n\n"
    "For EACH role you must ALSO author a complete persona — the system "
    "prompt that role's AI agent will use at runtime. The persona must be "
    "300-500 words, written in second person ('You are the X'), and must "
    "establish:\n"
    "  - the role's perspective and core priorities\n"
    "  - the questions this role asks on every proposal\n"
    "  - how this role behaves when other roles push back\n"
    "  - tone (direct, warm, skeptical, etc.)\n"
    "  - instructions to tag key points with [tags: ...] notation\n"
    "  - instructions to emit a [scores: ...] block when this turn moves\n"
    "    the agent's read of the quorum's health metrics (see below).\n\n"
    "Each persona's instructions MUST include this paragraph verbatim "
    "(or close paraphrase), so the runtime agent self-reports its read of "
    "the quorum after every reply:\n\n"
    "    After your reply, when this turn meaningfully changes how you read "
    "the quorum's health, emit a single [scores: ...] block on its own line. "
    "Valid keys: consensus, completion, role_coverage, critical_path, "
    "blockers. Each value is a signed integer in [-20, +20] representing "
    "how this turn moved that metric. Deltas accumulate into 0-100 absolute "
    "metrics, so be conservative.\n\n"
    "    Calibration on the resulting 0-100 scale: 100 = COMPLETE AND FINAL "
    "(no remaining work, no risk — rare and HARD to reach); 75 = very good "
    "but with open items; 50 = moderate progress, real questions remain; "
    "25 = early/weak; 0 = no progress or actively obstructed. Most working "
    "turns should keep the running total in the 50-80 band. If you cannot "
    "quote a specific phrase in your reply that justifies a delta of +10 "
    "or more, the delta must be +5 or lower on that metric.\n\n"
    "    Per-metric rules: consensus +large only on an EXPLICIT agreement "
    "that closes a prior disagreement (a non-disagreement is +1); "
    "completion +large only when this turn delivers a concrete, locked "
    "deliverable (a framework or DoD is +3 to +6, not +15); critical_path "
    "+large only when a named dependency is explicitly resolved (adding "
    "new requirements is near-zero or NEGATIVE); blockers POSITIVE only "
    "when this turn closes a SPECIFIC previously-recorded blocker "
    "(identifying a new risk is NEGATIVE); role_coverage +5 to +10 for a "
    "first substantive contribution from a new role, +0 to +2 for repeat "
    "contributions. Token acknowledgements are 0.\n\n"
    "    Use NEGATIVE numbers when this turn surfaced regressions — new "
    "conflicts, blockers, scope creep, missing evidence. Use 0 or omit "
    "keys that did not move. Optionally follow with [scores-why: ...] "
    "(< 100 chars) explaining the largest movement. Examples:\n"
    "      [scores: consensus=-12, blockers=-6]\n"
    "      [scores-why: IRB raised consent issue — new blocker, eroded agreement]\n"
    "    or:\n"
    "      [scores: completion=+4, role_coverage=+3, consensus=+2]\n"
    "      [scores-why: methodology now agreed; ethicist & researcher aligned]\n"
    "    Stay honest — if nothing moved, omit the block entirely. When in "
    "doubt, emit small deltas or omit the block. Saturating the chart at "
    "100 is a FAILURE mode, not a success.\n\n"
    "You must also supply 8-15 short snake_case domain_tags (used for "
    "affinity routing between agents) and a temperature in the range "
    "0.2-0.7 that fits the role (lower = more analytical, higher = more "
    "exploratory).\n\n"
    "ALSO produce a top-level ``short_title``: a punchy 6-12 word headline "
    "that captures the essence of the problem at a glance. Treat this as "
    "the quorum's name — Title Case, no trailing punctuation, no quotation "
    "marks, no leading 'A ' / 'The ' filler if it can be avoided. It must "
    "NOT simply repeat the first sentence of the problem — it must be a "
    "tighter, more memorable framing.\n\n"
    "Make ONE LLM call returning all roles at once — do not split into "
    "multiple round-trips."
)


async def generate_roles(
    problem: str, llm_provider: LLMProvider | None = None
) -> list[RoleSuggestion]:
    """Generate role suggestions for a quorum given a problem description.

    Backward-compatible signature: returns just ``list[RoleSuggestion]``.
    Callers that also want the LLM-produced ``short_title`` headline should
    use :func:`generate_roles_with_title` instead.
    """
    roles, _ = await generate_roles_with_title(problem, llm_provider=llm_provider)
    return roles


async def generate_roles_with_title(
    problem: str, llm_provider: LLMProvider | None = None
) -> tuple[list[RoleSuggestion], str]:
    """Generate roles + a short_title headline in a single LLM call.

    When QUORUM_TEST_MODE=true, returns 4 hardcoded mock roles and an empty
    short_title (the route falls back to the deterministic summary).

    Otherwise uses a typed Pydantic AI agent (output_type=RoleSuggestionList)
    so the LLM response is validated and retried automatically — no manual
    ``json.loads`` glue.  The short_title comes from the same payload, so
    there is no extra round-trip.

    Item 9.3 swap: previously called ``provider.respond`` / ``provider.chat``
    with a free-text prompt, then stripped markdown fences and ``json.loads``.
    Now it asks the provider for a typed instance via ``run_typed`` which
    delegates to ``pydantic_ai.Agent.run(output_type=RoleSuggestionList)``.
    Legacy MagicMock-based test fixtures continue to work via the fallback
    path that calls respond/chat directly (see ``_generate_roles_legacy``).
    """
    if os.environ.get("QUORUM_TEST_MODE", "").lower() in ("true", "1", "yes"):
        return [RoleSuggestion(**r) for r in _MOCK_ROLES], ""

    if llm_provider is None:
        provider_name = os.environ.get("QUORUM_LLM_PROVIDER", "azure")
        llm_provider = get_llm_provider(provider_name)

    user_content = (
        f"Problem: {problem}\n\n"
        "Return a RoleSuggestionList with 4-6 RoleSuggestion items "
        "(each carrying a fully-authored persona) AND a top-level "
        "short_title field (6-12 word punchy headline, Title Case, no "
        "trailing punctuation)."
    )

    # Detect legacy test doubles (MagicMock stubs of .respond / .chat only)
    # and route them through the original free-text + JSON-parse path so old
    # fixtures keep working without forcing every test to also stub
    # .run_typed.
    if _provider_supports_run_typed(llm_provider):
        try:
            # 4-6 personas × 300-500 words each easily blows past the CONFLICT
            # tier's 2048-token default, so override.  Seen in the wild: a
            # ~80-word multi-paragraph problem statement triggered "Model token
            # limit (2048) exceeded before any response was generated."
            output = await llm_provider.run_typed(
                user_content,
                tier=LLMTier.CONFLICT,
                output_type=RoleSuggestionList,
                instructions=_ROLE_GENERATION_INSTRUCTIONS,
                max_tokens=8192,
            )
            roles = list(output.roles)
            short_title = _sanitize_short_title(output.short_title)

            # The LLM call validated fine but may have returned a role with
            # ``domain_tags=[]`` — Pydantic permits that (default=[]).  Seen
            # in production on quorum 1ff1ac0b... where the "Data Modeling
            # & Architecture Strategist" role came back with zero tags,
            # breaking every affinity score touching it.
            #
            # Retry the FULL call once if any role is missing tags; the
            # combined call is the natural unit (cheaper than per-role
            # round-trips and gives the model a fresh sampling).
            missing_after_first = [r.name for r in roles if not r.domain_tags]
            if missing_after_first:
                logger.warning(
                    "architect: LLM returned %d/%d roles with empty "
                    "domain_tags (%s) — retrying full generate_roles call "
                    "once.",
                    len(missing_after_first),
                    len(roles),
                    missing_after_first,
                )
                try:
                    retry = await llm_provider.run_typed(
                        user_content,
                        tier=LLMTier.CONFLICT,
                        output_type=RoleSuggestionList,
                        instructions=_ROLE_GENERATION_INSTRUCTIONS,
                        max_tokens=8192,
                    )
                    retry_roles = list(retry.roles)
                    # Only swap in retry results if they're at least as
                    # complete (fewer empty-tag roles).  Avoid trading a
                    # mostly-good response for an entirely-worse one.
                    retry_missing = sum(
                        1 for r in retry_roles if not r.domain_tags
                    )
                    if retry_missing < len(missing_after_first):
                        roles = retry_roles
                        retry_title = _sanitize_short_title(retry.short_title)
                        if retry_title:
                            short_title = retry_title
                except Exception:
                    logger.warning(
                        "architect: retry of generate_roles failed — "
                        "proceeding with first-attempt results.",
                        exc_info=True,
                    )

            # Final safety net: any role still missing tags gets a
            # deterministic keyword-extracted set so it's at least visible
            # to affinity routing.
            _backfill_empty_tags(roles, label="generate_roles")
            return roles, short_title
        except ValueError:
            logger.warning(
                "Typed-agent path failed for generate_roles; falling back to "
                "respond/chat + manual JSON parse for compatibility.",
                exc_info=True,
            )

    # Legacy path doesn't surface short_title — caller falls back to the
    # deterministic first-sentence summary.
    roles = await _generate_roles_legacy(problem, llm_provider)
    _backfill_empty_tags(roles, label="generate_roles_legacy")
    return roles, ""


def _sanitize_short_title(raw: str) -> str:
    """Clean up an LLM-produced short title.

    Strips surrounding whitespace, leading/trailing quotation marks, and any
    trailing punctuation other than '?' (questions stay questions).
    """
    if not raw:
        return ""
    text = raw.strip()
    # Drop wrapping single/double/smart quotes that some models add.
    for quote in ("\"", "'", "“", "”", "‘", "’"):
        if text.startswith(quote) and text.endswith(quote) and len(text) > 1:
            text = text[1:-1].strip()
            break
    # Drop trailing punctuation except question marks.
    while text and text[-1] in ".,;:!":
        text = text[:-1].rstrip()
    return text


def _provider_supports_run_typed(provider: LLMProvider) -> bool:
    """Return True iff the provider overrides ``run_typed`` (item 9.3).

    Mirrors the pipeline-side heuristic so both call sites treat MagicMock /
    ABC-default providers the same way: the typed path is opt-in.
    """
    method = getattr(type(provider), "run_typed", None)
    if method is None:
        return False
    abc_method = getattr(LLMProvider, "run_typed", None)
    if abc_method is not None and method is abc_method:
        return False
    return True


async def _generate_roles_legacy(
    problem: str,
    llm_provider: LLMProvider,
) -> list[RoleSuggestion]:
    """Pre-9.3 free-text JSON path, kept for test-double compatibility.

    Identical to the old ``generate_roles`` body: tries ``respond()`` first,
    falls back to ``chat()`` if the provider doesn't support the Responses
    API, then strips fences + ``json.loads`` the result.  Validated via
    Pydantic at the end so the public return type matches the typed path.
    """
    schema_hint = (
        "Return ONLY a valid JSON array (no markdown, no explanation) of "
        "objects with fields:\n"
        "  name (string),\n"
        "  description (string, 1-2 sentences),\n"
        "  authority_rank (integer 1-5, higher=more authority),\n"
        "  capacity ('unlimited' or integer),\n"
        "  suggested_prompt_focus (string, 1 sentence),\n"
        "  system_prompt (string, 300-500 words — the full persona),\n"
        "  domain_tags (array of 8-15 snake_case strings),\n"
        "  temperature (number in [0.2, 0.7]),\n"
        f"  model (string, default '{DEFAULT_PERSONA_MODEL}').\n"
    )
    system_prompt = _ROLE_GENERATION_INSTRUCTIONS + "\n\n" + schema_hint
    legacy_user = f"Problem: {problem}\n\nReturn the JSON array now."
    raw = ""
    # See generate_roles(): 4-6 personas × 300-500 words blow past the
    # CONFLICT tier's 2048-token default.  respond() ignores max_tokens (no
    # parameter on the ABC), so the legacy path only gets the bump via chat().
    role_gen_max_tokens = 8192
    try:
        raw, _ = await llm_provider.respond(
            instructions=system_prompt,
            input_text=legacy_user,
            tier=LLMTier.CONFLICT,
        )
    except Exception:
        logger.info("respond() failed, falling back to chat()")

    if not raw or not raw.strip():
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": legacy_user},
        ]
        raw = await llm_provider.chat(
            messages, tier=LLMTier.CONFLICT, max_tokens=role_gen_max_tokens
        )

    if not raw or not raw.strip():
        logger.warning("LLM returned empty response for role generation. raw=%r", raw)
        raise ValueError(
            "LLM returned empty response. Check your model deployment and API configuration."
        )

    text = raw.strip()
    text = re.sub(r"^```[a-z]*\n?", "", text)
    text = re.sub(r"\n?```$", "", text).strip()
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if match:
        text = match.group(0)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        logger.error(
            "Failed to parse LLM JSON response for role generation. Raw: %s",
            text[:200],
        )
        raise ValueError(
            f"LLM returned unparseable JSON for role generation: {text[:200]}"
        )
    return [RoleSuggestion(**item) for item in parsed]


def _slugify_role_name(name: str) -> str:
    """Convert a role name to the agent_configs.agent_slug format.

    Mirrors agent_engine._slugify but lives here to avoid importing
    agent_engine from the architect (which would create a cycle).
    """
    return name.lower().strip().replace(" ", "_").replace("-", "_")


# Minimum tags we want to ship per role.  Below this, affinity routing returns
# 0.0 for any pair involving the under-tagged role (see live evidence: prod
# quorum 1ff1ac0b... had a role with domain_tags=[] that broke every affinity
# score touching it).  Keyword extraction over name + focus + prompt_template
# is deterministic and rarely yields fewer than 3 distinct tokens.
_MIN_FALLBACK_TAGS = 3
_MAX_FALLBACK_TAGS = 8


def _keyword_fallback_tags(
    name: str,
    focus: str = "",
    extra_text: str = "",
) -> list[str]:
    """Derive deterministic domain_tags from a role's free-text fields.

    Used when the architect LLM returns ``domain_tags=[]`` for a role even
    after a retry.  We pool the role's name, suggested_prompt_focus, and any
    extra prose (e.g. prompt_template field text), run
    :func:`quorum_llm.tier1.extract_keywords` to rank tokens by frequency,
    canonicalize each via :func:`quorum_llm.affinity.canonicalize_tag`, and
    return a deduplicated list of up to ``_MAX_FALLBACK_TAGS`` tags.

    This is heuristic by design — the goal is "any tags > 0 tags" so the
    role is visible to affinity routing, not "the perfect tag set the LLM
    would have produced".  When the LLM succeeds, this never fires.

    Args:
        name: Role name (e.g. "Data Modeling & Architecture Strategist").
        focus: ``suggested_prompt_focus`` sentence, if any.
        extra_text: Optional extra prose (e.g. prompt_template field text).

    Returns:
        List of canonical, deduplicated tags.  Empty only if the inputs
        contained no usable tokens; in practice almost always >= 3.
    """
    blob = " ".join(s for s in (name, focus, extra_text) if s and s.strip())
    if not blob.strip():
        return []
    raw_keywords = extract_keywords(blob, max_keywords=_MAX_FALLBACK_TAGS * 2)
    seen: set[str] = set()
    tags: list[str] = []
    for token in raw_keywords:
        canonical = canonicalize_tag(token)
        if not canonical or canonical in seen:
            continue
        seen.add(canonical)
        tags.append(canonical)
        if len(tags) >= _MAX_FALLBACK_TAGS:
            break
    return tags


def _backfill_empty_tags(
    roles: list[RoleSuggestion],
    *,
    label: str = "",
) -> int:
    """Fill ``domain_tags`` via keyword extraction for any role missing tags.

    Mutates each ``RoleSuggestion`` in place — empty/missing tag lists are
    replaced with the output of :func:`_keyword_fallback_tags`.  Emits one
    WARNING log per role that needed backfilling so the architect (and
    operators tailing logs) can see which roles the LLM dropped tags on.

    Returns the number of roles that were backfilled.
    """
    backfilled = 0
    for role in roles:
        if role.domain_tags:
            continue
        fallback = _keyword_fallback_tags(
            role.name or "", role.suggested_prompt_focus or ""
        )
        if not fallback:
            logger.warning(
                "architect: role=%r has empty domain_tags AND no usable "
                "name/focus text for keyword fallback (label=%s) — leaving "
                "tags empty; affinity routing will be degraded for this role.",
                role.name,
                label or "n/a",
            )
            continue
        role.domain_tags = fallback
        backfilled += 1
        logger.warning(
            "architect: role=%r had empty domain_tags from LLM (label=%s) — "
            "filled with %d keyword-extracted tags: %s",
            role.name,
            label or "n/a",
            len(fallback),
            fallback,
        )
    return backfilled


def _generic_persona_for(name: str, focus: str) -> str:
    """Generate a minimal default persona when the LLM omitted ``system_prompt``.

    Used so that EVERY architect-created role still gets an agent_configs row,
    even if the model didn't return a fully-authored persona.  Kept short on
    purpose so the architect's real personas dominate when present.
    """
    return (
        f"You are the AI facilitator for the {name} role. "
        f"Focus: {focus}. "
        "Provide expert analysis from your role's perspective. Be concise, "
        "identify conflicts with other roles, propose actionable "
        "recommendations, and tag key points with [tags: ...] notation."
    )


def persist_agent_configs(
    db: Any,
    quorum_id: str,
    role_assignments: list[tuple[str, RoleSuggestion]],
) -> list[dict[str, Any]]:
    """Insert one agent_configs row per role.

    ``role_assignments`` is a list of (role_id, RoleSuggestion) tuples so the
    caller controls the role UUID (it has already inserted the roles row).

    Returns the list of rows that were sent to the DB (handy for tests and
    logging).  Failures are logged but do not raise — agent_configs is
    additive and the rest of the quorum can still operate without it
    (falling back to the generic in agents/__init__.py).
    """
    rows: list[dict[str, Any]] = []
    for role_id, suggestion in role_assignments:
        system_prompt = (suggestion.system_prompt or "").strip()
        if not system_prompt:
            system_prompt = _generic_persona_for(
                suggestion.name, suggestion.suggested_prompt_focus
            )

        # Defense in depth: the ai-start route accepts RoleSuggestion objects
        # straight from the request body (the architect UI sends them after
        # the user reviews/edits), so a role with domain_tags=[] can reach
        # this function even if generate_roles_with_title already backfills.
        # Apply the same keyword fallback here so every persisted row has
        # tags or, at worst, an explicit WARNING log explaining why not.
        domain_tags = list(suggestion.domain_tags or [])
        if not domain_tags:
            domain_tags = _keyword_fallback_tags(
                suggestion.name or "",
                suggestion.suggested_prompt_focus or "",
            )
            if domain_tags:
                logger.warning(
                    "persist_agent_configs: role=%s (%r) arrived with empty "
                    "domain_tags — filled with %d keyword-extracted tags: %s",
                    role_id,
                    suggestion.name,
                    len(domain_tags),
                    domain_tags,
                )
            else:
                logger.warning(
                    "persist_agent_configs: role=%s (%r) arrived with empty "
                    "domain_tags AND no usable name/focus text for keyword "
                    "fallback — persisting empty tag list; affinity routing "
                    "will be degraded for this role.",
                    role_id,
                    suggestion.name,
                )

        row = {
            "id": str(uuid.uuid4()),
            "role_id": role_id,
            "quorum_id": quorum_id,
            "agent_slug": _slugify_role_name(suggestion.name),
            "system_prompt": system_prompt,
            "temperature": float(suggestion.temperature),
            "max_tokens": 1024,
            "doc_permissions": [],
            "auto_create_docs": False,
            "auto_suggest_dashboards": False,
            "domain_tags": domain_tags,
        }
        try:
            db.table("agent_configs").insert(row).execute()
            rows.append(row)
        except Exception:
            logger.warning(
                "persist_agent_configs: failed to insert config for role=%s",
                role_id,
                exc_info=True,
            )
    return rows


async def send_guidance(
    quorum_id: str,
    message: str,
    target_role_id: str | None = None,
) -> dict[str, Any]:
    """Send architect guidance to agents in a quorum via A2A.

    Falls back to storing in contributions table with role='_architect_guidance'
    if the agent is not reachable via A2A.
    """
    client = A2AClient()
    db = get_supabase()

    results: list[dict[str, Any]] = []

    if target_role_id:
        role_ids = [target_role_id]
    else:
        # Send to all roles in the quorum
        roles_result = db.table("roles").select("id").eq("quorum_id", quorum_id).execute()
        role_ids = [r["id"] for r in roles_result.data]

    for role_id in role_ids:
        a2a_message = {
            "type": "architect_guidance",
            "quorum_id": quorum_id,
            "content": message,
            "target_role_id": role_id,
        }

        response = await client.send_message(role_id, a2a_message)

        if response is not None:
            results.append({"role_id": role_id, "delivery": "a2a", "status": "sent"})
        else:
            # Fallback: store guidance as a contribution
            import uuid

            guidance_row = {
                "id": str(uuid.uuid4()),
                "quorum_id": quorum_id,
                "role_id": "_architect_guidance",
                "user_token": "architect_agent",
                "content": f"[Guidance for {role_id}] {message}",
                "structured_fields": {"target_role_id": role_id},
                "tier_processed": 0,
            }
            db.table("contributions").insert(guidance_row).execute()
            results.append({"role_id": role_id, "delivery": "supabase_fallback", "status": "stored"})

    return {"quorum_id": quorum_id, "deliveries": results}
