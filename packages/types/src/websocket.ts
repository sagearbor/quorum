// WebSocket event payload types from CONTRACT.md
// WS /quorums/{quorum_id}/live

import type { Contribution, Artifact } from "./database";
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

export type WebSocketEvent =
  | WsContributionEvent
  | WsHealthUpdateEvent
  | WsArtifactUpdateEvent
  | WsRoleJoinEvent;
