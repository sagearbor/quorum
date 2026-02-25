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
