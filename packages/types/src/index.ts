// @quorum/types — shared TypeScript types for the Quorum platform
// Generated from CONTRACT.md, ARCHITECTURE.md, and DASHBOARDS.md

export type {
  QuorumStatus,
  RoleCapacity,
  ArtifactStatus,
  DashboardType,
  CarouselMode,
  LLMTier,
  LLMProvider,
} from "./enums";

export type {
  PromptField,
  Event,
  Quorum,
  Role,
  Contribution,
  Artifact,
  ArtifactSection,
  ArtifactVersion,
  ArtifactDiff,
  // Agent system
  StationMessage,
  DocFormat,
  DocStatus,
  AgentDocument,
  DocumentChange,
  AgentInsight,
  AgentRequest,
} from "./database";

export type {
  CreateEventRequest,
  CreateEventResponse,
  CreateQuorumRoleInput,
  CreateQuorumRequest,
  CreateQuorumResponse,
  ContributeRequest,
  ContributeResponse,
  ActiveRole,
  QuorumStateResponse,
  ResolveRequest,
  ResolveResponse,
} from "./api";

export type { HealthMetrics, HealthSnapshot } from "./health";

export type { StreamContribution, StreamState } from "./stream";

export type {
  WsContributionEvent,
  WsHealthUpdateEvent,
  WsArtifactUpdateEvent,
  WsRoleJoinEvent,
  // Agent system WS events
  WsFacilitatorReplyEvent,
  WsAgentInsightEvent,
  WsAgentRequestEvent,
  WsDocumentUpdateEvent,
  WsOscillationEvent,
  WebSocketEvent,
} from "./websocket";

export type { LLMProviderInterface } from "./llm";

export type { DashboardProps } from "./dashboard";
