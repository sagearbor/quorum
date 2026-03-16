"""Pydantic models matching CONTRACT.md schemas."""

from __future__ import annotations

import enum
from typing import Any

from pydantic import BaseModel, Field


# --- Agent System Enums ---


class MessageRole(str, enum.Enum):
    user = "user"
    assistant = "assistant"
    system = "system"


class InsightType(str, enum.Enum):
    summary = "summary"
    conflict = "conflict"
    suggestion = "suggestion"
    question = "question"
    decision = "decision"
    escalation = "escalation"


class A2AStatus(str, enum.Enum):
    pending = "pending"
    acknowledged = "acknowledged"
    processing = "processing"
    resolved = "resolved"
    expired = "expired"


class A2ARequestType(str, enum.Enum):
    conflict_flag = "conflict_flag"
    input_request = "input_request"
    review_request = "review_request"
    doc_edit_notify = "doc_edit_notify"
    escalation = "escalation"
    negotiation = "negotiation"


class DocStatus(str, enum.Enum):
    active = "active"
    superseded = "superseded"
    canceled = "canceled"


class DocFormat(str, enum.Enum):
    json = "json"
    yaml = "yaml"
    csv = "csv"
    markdown = "markdown"


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
    # Optional: station_id ties the contribution to a specific physical station.
    # When provided, the agent engine fires a facilitator turn for that station.
    station_id: str | None = None
    # Optional: override the LLM model for this request, bypassing the agent
    # YAML default.  Useful for power users who want a more capable model for
    # a specific contribution without changing the global config.
    model_override: str | None = None


class ContributeResponse(BaseModel):
    contribution_id: str
    tier_processed: int
    # Agent facilitator reply — present when station_id was provided and the
    # agent engine ran successfully.  None when no station context or on error.
    facilitator_reply: str | None = None
    facilitator_message_id: str | None = None
    facilitator_tags: list[str] | None = None
    a2a_requests_triggered: int = 0


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


# ---------------------------------------------------------------------------
# Agent System Models
# ---------------------------------------------------------------------------


# GET /quorums/{id}/stations/{station_id}/messages
class StationMessageResponse(BaseModel):
    id: str
    quorum_id: str
    role_id: str
    station_id: str
    role: MessageRole
    content: str
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] | None = None
    created_at: str


# POST /quorums/{id}/stations/{station_id}/ask
class AskRequest(BaseModel):
    role_id: str
    content: str
    # Optional: override the LLM model for this ask, bypassing the agent
    # YAML default.  Mirrors ContributeRequest.model_override.
    model_override: str | None = None


class AskResponse(BaseModel):
    reply: str
    message_id: str
    tags: list[str] = Field(default_factory=list)


# GET /quorums/{id}/documents
# POST /quorums/{id}/documents
class DocumentCreateRequest(BaseModel):
    title: str
    doc_type: str
    format: DocFormat = DocFormat.json
    content: dict[str, Any]
    tags: list[str] = Field(default_factory=list)
    created_by_role_id: str | None = None


class DocumentResponse(BaseModel):
    id: str
    quorum_id: str
    title: str
    doc_type: str
    format: DocFormat
    content: dict[str, Any]
    status: DocStatus
    version: int
    tags: list[str] = Field(default_factory=list)
    created_by_role_id: str | None = None
    created_at: str
    updated_at: str


# PUT /documents/{doc_id}  (CAS update)
class DocumentUpdateRequest(BaseModel):
    content: dict[str, Any]
    expected_version: int
    changed_by_role: str
    rationale: str


class DocumentUpdateResponse(BaseModel):
    version: int
    merged: bool = False


# GET /quorums/{id}/insights
class InsightResponse(BaseModel):
    id: str
    quorum_id: str
    source_role_id: str
    insight_type: InsightType
    content: str
    tags: list[str] = Field(default_factory=list)
    document_id: str | None = None
    self_relevance: float = 0.5
    version: int = 1
    created_at: str


# POST /quorums/{id}/a2a/request
class A2ARequestCreate(BaseModel):
    from_role_id: str
    to_role_id: str
    request_type: A2ARequestType
    content: str
    tags: list[str] = Field(default_factory=list)
    document_id: str | None = None
    priority: int = 0


class A2ARequestResponse(BaseModel):
    id: str
    quorum_id: str
    from_role_id: str
    to_role_id: str
    request_type: A2ARequestType
    content: str
    tags: list[str] = Field(default_factory=list)
    document_id: str | None = None
    status: A2AStatus
    response: str | None = None
    response_tags: list[str] = Field(default_factory=list)
    priority: int = 0
    created_at: str
    resolved_at: str | None = None
    # Present when the target agent auto-responded during request creation
    target_response: str | None = None
