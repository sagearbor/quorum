"""A2A Agent Card generation for Quorum roles.

Each role in a quorum can be represented as an A2A agent with
capabilities derived from the role's prompt_template and authority.
"""

from __future__ import annotations

from typing import Any


def build_agent_card(role: dict[str, Any], base_url: str = "") -> dict[str, Any]:
    """Build an A2A-compliant agent card for a role.

    Args:
        role: Role row from Supabase (id, name, authority_rank, etc.)
        base_url: Base URL for the agent's endpoint.

    Returns:
        A2A agent card dict.
    """
    role_id = role["id"]
    return {
        "name": f"quorum-role-{role['name']}",
        "description": f"Quorum role: {role['name']} (authority rank {role.get('authority_rank', 0)})",
        "url": f"{base_url}/a2a/agents/{role_id}",
        "version": "0.1.0",
        "capabilities": {
            "streaming": False,
            "pushNotifications": False,
        },
        "skills": [
            {
                "id": "contribute",
                "name": "Submit Contribution",
                "description": f"Submit a contribution as the {role['name']} role",
            },
        ],
        "metadata": {
            "quorum_id": role.get("quorum_id"),
            "role_id": role_id,
            "authority_rank": role.get("authority_rank", 0),
            "capacity": role.get("capacity", "unlimited"),
        },
    }
