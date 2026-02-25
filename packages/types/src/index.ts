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

export type { HealthMetrics } from "./health";

export type {
  WsContributionEvent,
  WsHealthUpdateEvent,
  WsArtifactUpdateEvent,
  WsRoleJoinEvent,
  WebSocketEvent,
} from "./websocket";

export type { LLMProviderInterface } from "./llm";

export type { DashboardProps } from "./dashboard";
