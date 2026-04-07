// Supabase table row types from CONTRACT.md

import type {
  QuorumStatus,
  RoleCapacity,
  ArtifactStatus,
  CarouselMode,
  DashboardType,
} from "./enums";

export interface PromptField {
  field_name: string;
  prompt: string;
}

export interface Event {
  id: string;
  name: string;
  slug: string;
  access_code: string;
  max_active_quorums: number;
  created_by: string;
  created_at: string;
}

export interface Quorum {
  id: string;
  event_id: string;
  title: string;
  description: string;
  status: QuorumStatus;
  heat_score: number;
  carousel_mode: CarouselMode;
  dashboard_types: DashboardType[];
  autonomy_level: number;
  created_at: string;
}

export interface Role {
  id: string;
  quorum_id: string;
  name: string;
  capacity: RoleCapacity;
  authority_rank: number;
  prompt_template: PromptField[];
  fallback_chain: string[];
  color: string;
}

export interface Contribution {
  id: string;
  quorum_id: string;
  role_id: string;
  user_token: string;
  content: string;
  structured_fields: Record<string, string>;
  tier_processed: number;
  created_at: string;
}

export interface Artifact {
  id: string;
  quorum_id: string;
  version: number;
  content_hash: string;
  sections: ArtifactSection[];
  status: ArtifactStatus;
  created_at: string;
}

export interface ArtifactSection {
  title: string;
  content: string;
  source_contribution_ids: string[];
}

export interface ArtifactVersion {
  id: string;
  artifact_id: string;
  version: number;
  sections: ArtifactSection[];
  diff: ArtifactDiff[];
  created_at: string;
}

export interface ArtifactDiff {
  section_index: number;
  previous: string;
  current: string;
}

// ---------------------------------------------------------------------------
// Agent system types (Phase 1 — Track C)
// ---------------------------------------------------------------------------

/** A single message in a per-station conversation thread. */
export interface StationMessage {
  id: string;
  quorum_id: string;
  role_id: string;
  station_id: string;
  /** Perspective: 'user' = human input, 'assistant' = AI facilitator, 'system' = system event */
  role: "user" | "assistant" | "system";
  content: string;
  /** Extracted domain tags for affinity routing */
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_at: string;
}

/** Format of an agent-maintained document. */
export type DocFormat = "json" | "yaml" | "csv" | "markdown";

/** Lifecycle status of an agent document. */
export type DocStatus = "active" | "superseded" | "canceled";

/** A structured document collaboratively edited by AI agents. */
export interface AgentDocument {
  id: string;
  quorum_id: string;
  title: string;
  doc_type: string;
  format: DocFormat;
  /** Actual document payload — shape varies by doc_type. */
  content: Record<string, unknown>;
  status: DocStatus;
  version: number;
  tags?: string[];
  created_by_role_id?: string;
  created_at: string;
  updated_at: string;
}

/** An entry in the append-only document change log. */
export interface DocumentChange {
  id: string;
  document_id: string;
  version: number;
  changed_by_role: string;
  change_type: "create" | "edit" | "status_change";
  diff: Record<string, unknown>;
  rationale?: string;
  previous_content?: Record<string, unknown>;
  tags?: string[];
  created_at: string;
}

/** A cross-station insight surfaced by the agent system. */
export interface AgentInsight {
  id: string;
  quorum_id: string;
  source_role_id: string;
  insight_type: "summary" | "conflict" | "suggestion" | "question" | "decision" | "escalation";
  content: string;
  tags?: string[];
  document_id?: string;
  self_relevance: number;
  version: number;
  created_at: string;
}

/** An agent-to-agent request (A2A protocol). */
export interface AgentRequest {
  id: string;
  quorum_id: string;
  from_role_id: string;
  to_role_id: string;
  request_type:
    | "conflict_flag"
    | "input_request"
    | "review_request"
    | "doc_edit_notify"
    | "escalation"
    | "negotiation";
  content: string;
  tags?: string[];
  document_id?: string;
  status: "pending" | "acknowledged" | "processing" | "resolved" | "expired";
  response?: string;
  priority: number;
  created_at: string;
  resolved_at?: string;
}
