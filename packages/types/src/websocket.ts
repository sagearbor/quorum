// WebSocket event payload types from CONTRACT.md
// WS /quorums/{quorum_id}/live

import type { Contribution, Artifact, AgentInsight, AgentRequest, DocumentChange } from "./database";
import type { HealthMetrics } from "./health";

export interface WsContributionEvent {
  type: "contribution";
  data: Contribution;
}

export interface WsHealthUpdateEvent {
  type: "health_update";
  data: {
    score: number;
    metrics: HealthMetrics;
  };
}

export interface WsArtifactUpdateEvent {
  type: "artifact_update";
  data: Artifact;
}

export interface WsRoleJoinEvent {
  type: "role_join";
  data: {
    role_id: string;
    count: number;
  };
}

// ---------------------------------------------------------------------------
// Agent system WebSocket events (Phase 1 — Track C)
// ---------------------------------------------------------------------------

/**
 * Emitted after an AI facilitator agent responds to a human contribution or
 * an A2A request at a specific station.
 */
export interface WsFacilitatorReplyEvent {
  type: "facilitator_reply";
  data: {
    station_id: string;
    role_id: string;
    /** The agent's response text. */
    content: string;
    /** Tags extracted from the agent's response for affinity routing. */
    tags: string[];
    /** Supabase row ID from station_messages. */
    message_id: string;
  };
}

/**
 * Emitted when an agent publishes a new cross-station insight to the shared
 * bulletin board.
 */
export interface WsAgentInsightEvent {
  type: "agent_insight";
  data: AgentInsight;
}

/**
 * Emitted when an A2A request is created or its status changes (pending →
 * acknowledged → resolved, etc.).
 */
export interface WsAgentRequestEvent {
  type: "agent_request";
  data: AgentRequest;
}

/**
 * Emitted when an agent successfully applies a CAS write to an agent_document.
 * Consumers (DocumentPanel, etc.) should re-fetch the full document using
 * document_id and version to avoid applying partial diffs.
 */
export interface WsDocumentUpdateEvent {
  type: "document_update";
  data: {
    document_id: string;
    version: number;
    changed_by_role_id: string;
    diff: DocumentChange["diff"];
  };
}

/**
 * Emitted when the oscillation detector observes >= 2 A→B→A cycles on a
 * document field.  The frontend should surface an alert to the architect.
 */
export interface WsOscillationEvent {
  type: "oscillation";
  data: {
    document_id: string;
    quorum_id: string;
    field_path: string;
    cycle_count: number;
    involved_role_ids: string[];
    escalated: boolean;
  };
}

export type WebSocketEvent =
  | WsContributionEvent
  | WsHealthUpdateEvent
  | WsArtifactUpdateEvent
  | WsRoleJoinEvent
  | WsFacilitatorReplyEvent
  | WsAgentInsightEvent
  | WsAgentRequestEvent
  | WsDocumentUpdateEvent
  | WsOscillationEvent;
