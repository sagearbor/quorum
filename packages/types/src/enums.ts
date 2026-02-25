// Enums and literal types from CONTRACT.md

export type QuorumStatus = "open" | "active" | "resolved" | "archived";

export type RoleCapacity = number | "unlimited";

export type ArtifactStatus = "draft" | "pending_ratification" | "final";

export type DashboardType =
  | "authority_cascade_tree"
  | "quorum_health_chart"
  | "contribution_river"
  | "consensus_heat_ring"
  | "conflict_topology_map"
  | "decision_waterfall"
  | "resolution_radar"
  | "role_coverage_map"
  | "decision_dependency_dag"
  | "momentum_pulse"
  | "authority_weighted_gauge"
  | "contribution_timeline"
  | "artifact_lineage_graph"
  | "live_stance_board"
  | "voice_pulse_matrix";

export type CarouselMode = "multi-view" | "multi-quorum";

export type LLMTier = 1 | 2 | 3;

export type LLMProvider = "azure" | "anthropic" | "openai" | "local";
