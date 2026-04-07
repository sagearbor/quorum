"""Agent definitions — loads YAML files from agents/definitions/.

Each YAML file defines a role-specific agent with instructions, domain tags,
and optional model/temperature overrides. If no YAML exists for a role,
a generic definition is auto-generated from the role name.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

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


def load_agent(slug: str) -> AgentDefinition:
    """Load an agent definition by slug.

    Looks for agents/definitions/{slug}.yaml first. If not found,
    generates a generic definition so the system always has something
    to work with.
    """
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

    # Auto-generate from slug: "patient_advocate" → "Patient Advocate"
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
