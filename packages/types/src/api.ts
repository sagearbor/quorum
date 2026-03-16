// API request/response types from CONTRACT.md routes

import type { DashboardType, CarouselMode, LLMTier } from "./enums";
import type {
  PromptField,
  Quorum,
  Contribution,
  Artifact,
} from "./database";
import type { HealthMetrics } from "./health";

// POST /events
export interface CreateEventRequest {
  name: string;
  slug: string;
  access_code: string;
  max_active_quorums: number;
}

export interface CreateEventResponse {
  id: string;
  slug: string;
  created_at: string;
}

// POST /events/{event_id}/quorums
export interface CreateQuorumRoleInput {
  name: string;
  capacity: number | "unlimited";
  authority_rank: number;
  prompt_template: PromptField[];
  fallback_chain: string[];
}

export interface CreateQuorumRequest {
  title: string;
  description: string;
  roles: CreateQuorumRoleInput[];
  dashboard_types: DashboardType[];
  carousel_mode: CarouselMode;
}

export interface CreateQuorumResponse {
  id: string;
  status: Quorum["status"];
  share_url: string;
}

// POST /quorums/{quorum_id}/contribute
export interface ContributeRequest {
  role_id: string;
  user_token: string;
  content: string;
  structured_fields: Record<string, string>;
  /** Station identifier. When present, triggers AI facilitator response. */
  station_id?: string;
  /**
   * Override the LLM model for this request.
   * When provided, takes precedence over the agent YAML's default model.
   * Supported values: "gpt-4o-mini" | "gpt-4o" | "gpt-5-nano"
   */
  model_override?: string;
}

export interface ContributeResponse {
  contribution_id: string;
  tier_processed: LLMTier;
}

// GET /quorums/{quorum_id}/state
export interface ActiveRole {
  role_id: string;
  participant_count: number;
}

export interface QuorumStateResponse {
  quorum: Quorum;
  contributions: Contribution[];
  artifact: Artifact | null;
  health_score: number;
  active_roles: ActiveRole[];
}

// POST /quorums/{quorum_id}/resolve
export interface ResolveRequest {
  sign_off_token: string;
}

export interface ResolveResponse {
  artifact_id: string;
  download_url: string;
}

// POST /quorums/{quorum_id}/stations/{station_id}/ask
export interface AskRequest {
  role_id: string;
  content: string;
  /**
   * Override the LLM model for this ask.
   * When provided, takes precedence over the agent YAML's default model.
   */
  model_override?: string;
}

export interface AskResponse {
  reply: string;
  message_id: string;
  tags: string[];
}
