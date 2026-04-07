// Stream types shared between useQuorumLive (production) and mockStream (test mode)

import type { HealthMetrics, HealthSnapshot } from "./health";

export interface StreamContribution {
  id: string;
  role_id: string;
  role_name: string;
  content: string;
  created_at: string;
}

export interface StreamState {
  healthScore: number;
  metrics: HealthMetrics;
  history: HealthSnapshot[];
  recentContributions: StreamContribution[];
  artifact: { status: "draft" | "pending_ratification" | "final"; version: number } | null;
}
