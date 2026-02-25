"""Pydantic models matching CONTRACT.md schemas."""

from __future__ import annotations

import enum
from typing import Any

from pydantic import BaseModel, Field


# --- Enums ---


class QuorumStatus(str, enum.Enum):
    open = "open"
    active = "active"
    resolved = "resolved"
    archived = "archived"


class ArtifactStatus(str, enum.Enum):
    draft = "draft"
    pending_ratification = "pending_ratification"
    final = "final"


class CarouselMode(str, enum.Enum):
    multi_view = "multi-view"
    multi_quorum = "multi-quorum"


class DashboardType(str, enum.Enum):
    authority_cascade_tree = "authority_cascade_tree"
    quorum_health_chart = "quorum_health_chart"
    contribution_river = "contribution_river"
    consensus_heat_ring = "consensus_heat_ring"
    conflict_topology_map = "conflict_topology_map"
    decision_waterfall = "decision_waterfall"
    resolution_radar = "resolution_radar"
    role_coverage_map = "role_coverage_map"
    decision_dependency_dag = "decision_dependency_dag"
    momentum_pulse = "momentum_pulse"
    authority_weighted_gauge = "authority_weighted_gauge"
    contribution_timeline = "contribution_timeline"
    artifact_lineage_graph = "artifact_lineage_graph"
    live_stance_board = "live_stance_board"
    voice_pulse_matrix = "voice_pulse_matrix"


# --- Request / Response Models ---


# POST /events
class CreateEventRequest(BaseModel):
    name: str
    slug: str
    access_code: str
    max_active_quorums: int = 5


class CreateEventResponse(BaseModel):
    id: str
    slug: str
    created_at: str


# POST /events/{event_id}/quorums
class PromptField(BaseModel):
    field_name: str
    prompt: str


class RoleDefinition(BaseModel):
    name: str
    capacity: int | str = "unlimited"  # integer or "unlimited"
    authority_rank: int = 0
    prompt_template: list[PromptField] = Field(default_factory=list)
    fallback_chain: list[str] = Field(default_factory=list)  # role_id[]


class CreateQuorumRequest(BaseModel):
    title: str
    description: str
    roles: list[RoleDefinition]
    dashboard_types: list[DashboardType] = Field(default_factory=list)
    carousel_mode: CarouselMode = CarouselMode.multi_view


class CreateQuorumResponse(BaseModel):
    id: str
    status: QuorumStatus
    share_url: str


# POST /quorums/{quorum_id}/contribute
class ContributeRequest(BaseModel):
    role_id: str
    user_token: str
    content: str
    structured_fields: dict[str, str] = Field(default_factory=dict)


class ContributeResponse(BaseModel):
    contribution_id: str
    tier_processed: int


# GET /quorums/{quorum_id}/state
class HealthMetrics(BaseModel):
    completion_pct: float = 0.0
    consensus_score: float = 0.0
    critical_path_score: float = 100.0
    role_coverage_pct: float = 0.0
    blocker_score: float = 100.0


class ActiveRole(BaseModel):
    role_id: str
    participant_count: int


class QuorumStateResponse(BaseModel):
    quorum: dict[str, Any]
    contributions: list[dict[str, Any]]
    artifact: dict[str, Any] | None
    health_score: float
    active_roles: list[ActiveRole]


# POST /quorums/{quorum_id}/resolve
class ResolveRequest(BaseModel):
    sign_off_token: str


class ResolveResponse(BaseModel):
    artifact_id: str
    download_url: str


# --- WebSocket message types ---


class WSContributionMessage(BaseModel):
    type: str = "contribution"
    data: dict[str, Any]


class WSHealthUpdateMessage(BaseModel):
    type: str = "health_update"
    data: dict[str, Any]


class WSArtifactUpdateMessage(BaseModel):
    type: str = "artifact_update"
    data: dict[str, Any]


class WSRoleJoinMessage(BaseModel):
    type: str = "role_join"
    data: dict[str, Any]
