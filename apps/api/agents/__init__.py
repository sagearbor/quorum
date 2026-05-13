"""Agent definitions — loads per-role personas.

Resolution order (highest → lowest priority):
  1. ``agent_configs`` row keyed by ``role_id`` (Supabase / SQLite). This is
     where the architect writes one row per role at quorum creation time so
     each agent has a distinct persona, temperature, and domain_tags.
  2. ``agents/definitions/{slug}.yaml`` static fallback (rarely used in
     practice — kept for environments without a DB).
  3. Auto-generated generic definition built from the role name. Ensures the
     system always has *something* to work with, but produces homogeneous
     agents — which is the bug item 10.1 fixed by preferring (1).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

_DEFINITIONS_DIR = Path(__file__).parent / "definitions"


@dataclass
class AgentDefinition:
    """Runtime representation of an agent definition."""
    name: str
    instructions: str
    domain_tags: list[str] = field(default_factory=list)
    model: str = ""
    temperature: float = 0.4
    max_tokens: int = 1024


def _from_agent_configs_row(row: dict[str, Any], fallback_slug: str) -> AgentDefinition:
    """Build an AgentDefinition from an agent_configs row.

    The SQLite client returns domain_tags as a JSON string; Supabase returns
    a real list. Handle both shapes defensively.
    """
    import json as _json

    tags = row.get("domain_tags") or []
    if isinstance(tags, str):
        try:
            tags = _json.loads(tags)
        except Exception:
            tags = []
    if not isinstance(tags, list):
        tags = []

    name = row.get("agent_slug") or fallback_slug
    readable = name.replace("_", " ").title() if isinstance(name, str) else fallback_slug

    return AgentDefinition(
        name=readable,
        instructions=row.get("system_prompt") or "",
        domain_tags=list(tags),
        model=row.get("model") or "",
        temperature=float(row.get("temperature") or 0.4),
        max_tokens=int(row.get("max_tokens") or 1024),
    )


def _load_from_agent_configs(role_id: str, db: Any) -> AgentDefinition | None:
    """Read an agent_configs row by role_id. Returns None on miss or error."""
    if not role_id or db is None:
        return None
    try:
        result = (
            db.table("agent_configs")
            .select("system_prompt, temperature, max_tokens, domain_tags, agent_slug")
            .eq("role_id", role_id)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        if not rows:
            return None
        row = rows[0] if isinstance(rows, list) else rows
        if not row or not row.get("system_prompt"):
            return None
        return _from_agent_configs_row(row, fallback_slug=role_id)
    except Exception:
        logger.debug(
            "load_agent: agent_configs lookup failed for role_id=%s",
            role_id,
            exc_info=True,
        )
        return None


def load_agent(
    slug: str,
    role_id: str | None = None,
    db: Any | None = None,
) -> AgentDefinition:
    """Load an agent definition by slug.

    Resolution order:
      1. ``agent_configs`` row (preferred — has the architect-authored persona)
         — requires ``role_id`` and ``db`` to be supplied.
      2. ``agents/definitions/{slug}.yaml`` static fallback.
      3. Auto-generated generic from the slug.

    ``role_id`` and ``db`` are optional so the legacy single-arg signature
    keeps working; callers that have a DB handy should pass both so the
    architect-authored persona is preferred.
    """

    # --- 1. Prefer agent_configs (architect-written persona) ---
    if role_id and db is not None:
        cfg = _load_from_agent_configs(role_id, db)
        if cfg is not None:
            return cfg

    # --- 2. YAML fallback ---
    yaml_path = _DEFINITIONS_DIR / f"{slug}.yaml"

    if yaml_path.exists():
        try:
            data = yaml.safe_load(yaml_path.read_text())
            return AgentDefinition(
                name=data.get("name", slug),
                instructions=data.get("instructions", ""),
                domain_tags=data.get("domain_tags", []),
                model=data.get("model", ""),
                temperature=data.get("temperature", 0.4),
                max_tokens=data.get("max_tokens", 1024),
            )
        except Exception:
            logger.warning("Failed to parse %s, using generic", yaml_path, exc_info=True)

    # --- 3. Generic auto-generated fallback ---
    # "patient_advocate" → "Patient Advocate"
    readable_name = slug.replace("_", " ").title()
    return AgentDefinition(
        name=readable_name,
        instructions=(
            f"You are the AI facilitator for the {readable_name} role. "
            f"Provide expert analysis from the {readable_name} perspective. "
            "Be concise, identify conflicts with other roles, and propose "
            "actionable recommendations. Tag key points with [tags: ...] notation."
        ),
        domain_tags=_infer_tags(slug),
        model="",
    )


def _infer_tags(slug: str) -> list[str]:
    """Infer domain tags from the role slug."""
    tag_map: dict[str, list[str]] = {
        "researcher": ["research", "data", "methodology", "evidence"],
        "ethicist": ["ethics", "compliance", "fairness", "consent"],
        "administrator": ["operations", "logistics", "budget", "management"],
        "patient_advocate": ["patient", "safety", "advocacy", "welfare"],
        "safety_engineer": ["safety", "risk", "monitoring", "compliance"],
        "technical_lead": ["engineering", "architecture", "implementation"],
        "ethics_advisor": ["ethics", "fairness", "governance", "policy"],
        "legal": ["legal", "compliance", "regulation", "liability"],
        "clinician": ["clinical", "treatment", "diagnosis", "patient"],
        "data_scientist": ["data", "analysis", "statistics", "modeling"],
        "project_manager": ["timeline", "milestones", "coordination", "resources"],
    }
    return tag_map.get(slug, [slug.replace("_", " ")])
