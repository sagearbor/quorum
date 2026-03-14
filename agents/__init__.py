"""
Agent definition loader.

Agent definitions are YAML files in agents/definitions/.
Aligned with Azure Assistants API format (name, instructions, model, tools, metadata)
and Google A2A Agent Card for cross-agent discovery.

Static identity lives in YAML (version controlled).
Runtime state (conversation history, insights, document edits) lives in Supabase (local)
or Azure thread store (prod).

Usage:
    from agents import load_agent, list_agents

    agent = load_agent("safety_monitor")
    all_agents = list_agents()
"""

from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

import yaml


DEFINITIONS_DIR = Path(__file__).parent / "definitions"


@dataclass
class A2ASkill:
    id: str
    name: str
    description: str = ""


@dataclass
class ToolFunction:
    name: str
    description: str
    parameters: dict = field(default_factory=dict)


@dataclass
class Tool:
    type: str  # "function"
    function: ToolFunction = field(default_factory=lambda: ToolFunction(name="", description=""))


@dataclass
class Personality:
    tone: str = "conversational"
    verbosity: str = "moderate"
    initiative: str = "balanced"


@dataclass
class AgentDefinition:
    """Static agent identity loaded from YAML. Immutable at runtime.
    Field names match Azure Assistants API where possible."""

    name: str
    version: str
    description: str
    instructions: str  # Azure Assistants field name (was system_prompt)
    domain_tags: list[str]
    authority_rank: int
    model: str = "gpt-4o-mini"
    tools: list[Tool] = field(default_factory=list)
    auto_create_docs: bool = False
    escalation_model: str = "gpt-4o"
    personality: Personality = field(default_factory=Personality)
    a2a_skills: list[A2ASkill] = field(default_factory=list)
    azure_assistant_id: Optional[str] = None

    _source_path: Optional[str] = None

    def to_azure_assistant(self) -> dict:
        """Export as Azure Assistants API create/update payload."""
        return {
            "name": self.name,
            "description": self.description,
            "instructions": self.instructions,
            "model": self.model,
            "tools": [
                {"type": t.type, "function": {
                    "name": t.function.name,
                    "description": t.function.description,
                    "parameters": t.function.parameters,
                }}
                for t in self.tools
            ],
            "metadata": {
                "domain_tags": ",".join(self.domain_tags),
                "authority_rank": str(self.authority_rank),
                "auto_create_docs": str(self.auto_create_docs).lower(),
                "version": self.version,
            },
        }

    def to_agent_card(self) -> dict:
        """Export as Google A2A Agent Card JSON."""
        return {
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "capabilities": {
                "streaming": False,
                "pushNotifications": False,
            },
            "skills": [
                {"id": s.id, "name": s.name, "description": s.description}
                for s in self.a2a_skills
            ],
            "defaultInputModes": ["text"],
            "defaultOutputModes": ["text"],
        }


def _parse_definition(data: dict, source_path: str) -> AgentDefinition:
    # Parse metadata block
    metadata = data.get("metadata", {})
    personality_data = metadata.get("personality", {})
    personality = Personality(
        tone=personality_data.get("tone", "conversational"),
        verbosity=personality_data.get("verbosity", "moderate"),
        initiative=personality_data.get("initiative", "balanced"),
    )

    # Parse tools — supports both Azure Assistants format (dict with type/function)
    # and simple string shorthand (e.g., "edit_document")
    tools = []
    for t in data.get("tools", []):
        if isinstance(t, str):
            # Simple string shorthand → convert to Tool object
            tools.append(Tool(
                type="function",
                function=ToolFunction(name=t, description=t.replace("_", " ").title()),
            ))
        else:
            func_data = t.get("function", {})
            tools.append(Tool(
                type=t.get("type", "function"),
                function=ToolFunction(
                    name=func_data.get("name", ""),
                    description=func_data.get("description", ""),
                    parameters=func_data.get("parameters", {}),
                ),
            ))

    # Parse A2A skills
    a2a_data = data.get("a2a", {})
    skills = [
        A2ASkill(id=s["id"], name=s["name"], description=s.get("description", ""))
        for s in a2a_data.get("skills", [])
    ]

    azure_data = data.get("azure", {})

    return AgentDefinition(
        name=data["name"],
        version=str(data["version"]),
        description=data["description"],
        instructions=data["instructions"].strip(),
        domain_tags=data["domain_tags"],
        authority_rank=data["authority_rank"],
        model=data.get("model", "gpt-4o-mini"),
        tools=tools,
        auto_create_docs=metadata.get("auto_create_docs", False),
        escalation_model=metadata.get("escalation_model", "gpt-4o"),
        personality=personality,
        a2a_skills=skills,
        azure_assistant_id=azure_data.get("assistant_id"),
        _source_path=source_path,
    )


def load_agent(slug: str) -> AgentDefinition:
    """Load an agent definition by slug (filename without .yaml)."""
    path = DEFINITIONS_DIR / f"{slug}.yaml"
    if not path.exists():
        raise FileNotFoundError(f"Agent definition not found: {path}")

    with open(path) as f:
        data = yaml.safe_load(f)

    return _parse_definition(data, str(path))


def list_agents() -> list[AgentDefinition]:
    """Load all agent definitions from the definitions directory."""
    agents = []
    for path in sorted(DEFINITIONS_DIR.glob("*.yaml")):
        with open(path) as f:
            data = yaml.safe_load(f)
        agents.append(_parse_definition(data, str(path)))
    return agents


def load_agents_by_tags(tags: list[str]) -> list[AgentDefinition]:
    """Load agents whose domain_tags overlap with the given tags."""
    tag_set = set(tags)
    return [a for a in list_agents() if tag_set & set(a.domain_tags)]
