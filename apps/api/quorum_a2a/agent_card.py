"""A2A AgentCard generation for Quorum roles — spec-compliant via a2a-sdk.

Each role in a quorum is exposed as an A2A 1.0 agent. The AgentCard built here
uses the canonical `a2a.types.a2a_pb2.AgentCard` proto class shipped with
`a2a-sdk` 1.0.x, so the serialized JSON matches the Linux Foundation A2A 1.0
spec (the schema differs significantly from earlier 0.3 cards — `url` is now
inside `supported_interfaces`, capabilities use `push_notifications` not
`pushNotifications`, etc.).

Skill tags are derived from the role's `agent_configs.domain_tags` when one
exists (post-10.1) and fall back to a slug derived from the role name when
not. The architect-authored `system_prompt` is intentionally NOT exposed
through this card — see security audit notes inside `build_agent_card`.

This module is intentionally thin: it returns the typed `AgentCard` so the
FastAPI route can serialize it via `agent_card_to_dict` from the SDK helpers,
which guarantees the field name casing the spec expects.
"""

from __future__ import annotations

import logging
from typing import Any

from a2a.server.request_handlers.response_helpers import agent_card_to_dict
from a2a.types.a2a_pb2 import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    AgentSkill,
)

logger = logging.getLogger(__name__)

# The A2A 1.0 protocol_binding constant for HTTP+JSON transport.
# This matches the wire used by the SDK's REST routes.
PROTOCOL_BINDING_HTTP_JSON = "HTTP_JSON"
PROTOCOL_VERSION = "1.0"

# Skill ID exposed on every role.  Other agents can target this skill via the
# AgentSkill id field.  Sub-skills could be added per role in the future
# (e.g., "vote", "review_protocol") — we keep one canonical skill for now to
# minimise spec surface area while staying compliant.
_CONTRIBUTE_SKILL_ID = "contribute"


def build_agent_card(
    role: dict[str, Any],
    base_url: str = "http://localhost:8000",
    *,
    agent_config: dict[str, Any] | None = None,
) -> AgentCard:
    """Build a spec-compliant A2A 1.0 AgentCard for a role.

    Args:
        role: Roles row (id, name, authority_rank, capacity, quorum_id).
        base_url: Base URL of this quorum API.  The card's url interface points
            to ``{base_url}/a2a/agents/{role_id}`` — the per-role A2A endpoint.
        agent_config: Optional ``agent_configs`` row.  Only ``domain_tags`` is
            consumed (it populates the skill's ``tags`` field).  The
            ``system_prompt`` field is intentionally ignored — exposing any
            slice of the architect-authored persona via this unauthenticated
            public endpoint is a leak (audit PR #14).  Cards still validate
            when this is None.

    Returns:
        The typed ``AgentCard`` proto object.  Use ``card_to_dict`` to serialize.
    """
    role_id = str(role.get("id") or "unknown")
    role_name = str(role.get("name") or "agent")
    # NOTE: authority_rank is intentionally NOT included in the public card
    # (description, skill text, or x-quorum extension). The architect-authored
    # rank is sensitive metadata about the deliberation's authority hierarchy
    # and is only exposed via the access-gated authority MCP server
    # (`get_role_authority(role_id)`). See security audit fix in this PR.
    quorum_id = role.get("quorum_id")  # noqa: F841 — kept for future spec extensions

    # Domain tags drive the skill's `tags` field — they're how other agents
    # discover what this role specializes in.  We do NOT derive tags from the
    # architect-authored system prompt to avoid leaking persona context to
    # unauthenticated consumers of the .well-known/agent-card.json endpoint.
    domain_tags: list[str] = []
    # Generic description — gives no insight into the persona's behavior, the
    # architect's prompt, or the role's position in the authority hierarchy.
    description = (
        f"Role-specialized agent for {role_name} in a multi-stakeholder deliberation"
    )
    if agent_config:
        config_tags = agent_config.get("domain_tags") or []
        if isinstance(config_tags, list):
            domain_tags = [str(t) for t in config_tags if t]
        # NOTE: `agent_config["system_prompt"]` is intentionally NOT read here.
        # The architect-authored persona prompt is private deliberation context;
        # exposing even its first 280 chars via the unauthenticated AgentCard
        # endpoint leaks both behavior and substantive hints. Audit: PR #14.

    # Build the AgentCard proto.  Note: in v1.0 the top-level URL lives inside
    # `supported_interfaces` (one per transport binding), not at the root.
    card = AgentCard(
        name=f"quorum-role-{role_name}",
        description=description,
        version="1.0.0",
        # The URL the A2A REST dispatcher is mounted at.  See a2a_server.py.
        supported_interfaces=[
            AgentInterface(
                url=f"{base_url}/a2a/agents/{role_id}",
                protocol_binding=PROTOCOL_BINDING_HTTP_JSON,
                protocol_version=PROTOCOL_VERSION,
            ),
        ],
        capabilities=AgentCapabilities(
            streaming=False,
            push_notifications=False,
        ),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        skills=[
            AgentSkill(
                id=_CONTRIBUTE_SKILL_ID,
                name="Submit Contribution",
                description=(
                    # Generic skill description — no authority_rank, no
                    # persona text. The role name is already public (it
                    # appears on the card name and in routing URLs).
                    f"Submit a contribution as the {role_name} role within a quorum."
                ),
                tags=domain_tags or [role_name.lower().replace(" ", "_")],
                input_modes=["text/plain"],
                output_modes=["text/plain"],
            ),
        ],
    )
    return card


def build_agent_card_dict(
    role: dict[str, Any],
    base_url: str = "http://localhost:8000",
    *,
    agent_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Convenience wrapper returning the dict form of the card.

    This matches what gets served at ``.well-known/agent-card.json``.  We use
    the SDK's own ``agent_card_to_dict`` helper so the JSON field names and
    enum encodings match what the SDK's client expects on the consuming side
    (avoiding casing drift bugs that plagued the bespoke v0 implementation).

    The dict also includes a ``quorum_metadata`` key under ``additionalProperties``
    so the Quorum architect UI can inspect role-specific extras without
    parsing the URL.  This is permitted by the spec — protobuf round-trips
    unknown fields cleanly.
    """
    card = build_agent_card(role, base_url, agent_config=agent_config)
    card_dict = agent_card_to_dict(card)
    # Attach quorum-specific metadata under a non-conflicting key.  The A2A
    # spec doesn't reserve top-level extension keys, so we namespace ours.
    # x-quorum extension — deliberately excludes `authority_rank`.
    # Other agents that need rank for internal arbitration must fetch it via
    # the access-gated authority MCP server (`get_role_authority(role_id)`),
    # not via this unauthenticated public card.  Audit: PR #14.
    card_dict["x-quorum"] = {
        "role_id": str(role.get("id") or ""),
        "quorum_id": str(role.get("quorum_id") or "") if role.get("quorum_id") else None,
        "capacity": role.get("capacity") or "unlimited",
    }
    return card_dict
