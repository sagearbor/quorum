"""AI Architect Agent — generates role suggestions for quorum deliberations."""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Literal

from pydantic import BaseModel, Field

from quorum_llm import get_llm_provider
from quorum_llm.interface import LLMProvider
from quorum_llm.models import LLMTier

from a2a.a2a_client import A2AClient
from database import get_supabase

logger = logging.getLogger(__name__)


class RoleSuggestion(BaseModel):
    name: str
    description: str
    authority_rank: int = Field(ge=1, le=5)
    capacity: str | int = "unlimited"
    suggested_prompt_focus: str


_MOCK_ROLES: list[dict[str, Any]] = [
    {
        "name": "Researcher",
        "description": "Domain expert who evaluates evidence quality, methodology, and scientific rigor.",
        "authority_rank": 3,
        "capacity": "unlimited",
        "suggested_prompt_focus": "Evaluate the evidence base and methodological soundness of proposed approaches.",
    },
    {
        "name": "Ethicist",
        "description": "Ethics specialist ensuring decisions align with moral principles and regulatory standards.",
        "authority_rank": 4,
        "capacity": 1,
        "suggested_prompt_focus": "Identify ethical implications, consent requirements, and regulatory compliance issues.",
    },
    {
        "name": "Administrator",
        "description": "Operations lead managing resources, timelines, and organizational feasibility.",
        "authority_rank": 2,
        "capacity": 1,
        "suggested_prompt_focus": "Assess resource requirements, budget constraints, and implementation timelines.",
    },
    {
        "name": "Patient Advocate",
        "description": "Representative ensuring participant welfare, accessibility, and community impact.",
        "authority_rank": 5,
        "capacity": "unlimited",
        "suggested_prompt_focus": "Champion participant safety, informed consent clarity, and equitable access.",
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
        "expertise, or stakeholder interest. Return a JSON array of objects with fields: "
        "name (string), description (string), authority_rank (integer 1-5, higher=more authority), "
        "capacity ('unlimited' or integer), suggested_prompt_focus (string)."
    )

    prompt = f"{system_prompt}\n\nProblem: {problem}"
    raw = await llm_provider.complete(prompt, tier=LLMTier.CONFLICT)

    # Extract JSON array from response (handle markdown fences)
    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        text = "\n".join(lines)

    parsed = json.loads(text)
    return [RoleSuggestion(**item) for item in parsed]


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
