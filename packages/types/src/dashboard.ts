// Dashboard component props from DASHBOARDS.md

import type { Quorum, Contribution, Artifact, AgentDocument } from "./database";

export interface DashboardProps {
  quorum: Quorum;
  contributions: Contribution[];
  artifact: Artifact | null;
}

// ---------------------------------------------------------------------------
// Agent Document Viewer dashboard (agent_document_viewer)
// ---------------------------------------------------------------------------

/**
 * Props for the AgentDocumentDashboard.
 * Extends the standard DashboardProps with the list of agent documents so the
 * dashboard can render each one according to its doc_type.
 */
export interface AgentDocumentDashboardProps extends DashboardProps {
  /** Active agent documents for this quorum (from useAgentDocuments). */
  documents: AgentDocument[];
  /** Loading state from useAgentDocuments (shows skeleton while true). */
  documentsLoading?: boolean;
}

// ---------------------------------------------------------------------------
// Agent Affinity Graph dashboard (agent_affinity_graph)
// ---------------------------------------------------------------------------

/** A node in the affinity graph representing one agent/role. */
export interface AffinityNode {
  /** role_id */
  id: string;
  /** Human-readable role name */
  label: string;
  /** Number of messages/edits this agent has produced (controls node size). */
  activityCount: number;
  /** Whether this agent is currently processing an LLM turn. */
  active: boolean;
  /** Hex colour from the role definition. */
  color: string;
  /** Domain tags for this agent. */
  tags: string[];
}

/** An edge between two agents representing their tag-affinity relationship. */
export interface AffinityEdge {
  source: string;  // role_id
  target: string;  // role_id
  /** Jaccard similarity of the two agents' tag sets (0.0–1.0). */
  weight: number;
  /** Most recent interaction type between the two agents. */
  interactionType: "collaborative" | "conflicting" | "requesting" | "none";
}

/**
 * Props for the AgentAffinityGraph dashboard.
 * The component builds nodes/edges from agent configs and request history.
 */
export interface AgentAffinityGraphProps extends DashboardProps {
  nodes: AffinityNode[];
  edges: AffinityEdge[];
}
