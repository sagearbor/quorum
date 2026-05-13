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
from quorum_llm.interface import LLMProvider
from quorum_llm.models import LLMTier

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


async def generate_roles(
    problem: str, llm_provider: LLMProvider | None = None
) -> list[RoleSuggestion]:
    """Generate role suggestions for a quorum given a problem description.

    When QUORUM_TEST_MODE=true, returns 4 hardcoded mock roles.
    Otherwise uses the LLM to generate role suggestions.
    """
    if os.environ.get("QUORUM_TEST_MODE", "").lower() in ("true", "1", "yes"):
        return [RoleSuggestion(**r) for r in _MOCK_ROLES]

    if llm_provider is None:
        provider_name = os.environ.get("QUORUM_LLM_PROVIDER", "azure")
        llm_provider = get_llm_provider(provider_name)

    system_prompt = (
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
        "  - instructions to tag key points with [tags: ...] notation\n\n"
        "You must also supply 8-15 short snake_case domain_tags (used for "
        "affinity routing between agents) and a temperature in the range "
        "0.2-0.7 that fits the role (lower = more analytical, higher = more "
        "exploratory).\n\n"
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
        f"  model (string, default '{DEFAULT_PERSONA_MODEL}').\n\n"
        "Make ONE LLM call returning all roles at once — do not split into "
        "multiple round-trips."
    )

    # Try respond() first (works with gpt-5-nano Responses API),
    # fall back to chat() for older models (gpt-4o, gpt-4o-mini).
    user_content = f"Problem: {problem}\n\nReturn the JSON array now."
    raw = ""
    try:
        raw, _ = await llm_provider.respond(
            instructions=system_prompt,
            input_text=user_content,
            tier=LLMTier.CONFLICT,
        )
    except Exception:
        logger.info("respond() failed, falling back to chat()")

    if not raw or not raw.strip():
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]
        raw = await llm_provider.chat(messages, tier=LLMTier.CONFLICT)

    if not raw or not raw.strip():
        logger.warning("LLM returned empty response for role generation. raw=%r", raw)
        raise ValueError(f"LLM returned empty response. Check your model deployment and API configuration.")

    # Extract JSON array from response (handle markdown fences)
    text = raw.strip()
    # Strip markdown code fences
    text = re.sub(r"^```[a-z]*\n?", "", text)
    text = re.sub(r"\n?```$", "", text)
    text = text.strip()

    # Extract just the JSON array if there's surrounding text
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if match:
        text = match.group(0)

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        logger.error("Failed to parse LLM JSON response for role generation. Raw: %s", text[:200])
        raise ValueError(f"LLM returned unparseable JSON for role generation: {text[:200]}")

    return [RoleSuggestion(**item) for item in parsed]


def _slugify_role_name(name: str) -> str:
    """Convert a role name to the agent_configs.agent_slug format.

    Mirrors agent_engine._slugify but lives here to avoid importing
    agent_engine from the architect (which would create a cycle).
    """
    return name.lower().strip().replace(" ", "_").replace("-", "_")


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
            "domain_tags": list(suggestion.domain_tags or []),
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
