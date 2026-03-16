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
