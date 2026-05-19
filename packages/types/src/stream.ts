// Stream types shared between useQuorumLive (production) and mockStream (test mode)

import type { HealthMetrics, HealthSnapshot } from "./health";

export interface StreamContribution {
  id: string;
  role_id: string;
  role_name: string;
  content: string;
  created_at: string;
  /** LLM-extracted snake_case domain tags (Tier-2 analyzer).  Optional —
   *  rows from before the 20260519000001 migration won't have these. */
  analysis_tags?: string[];
  /** Per-metric score deltas emitted by the analyzer.  Short keys
   *  (consensus, completion, critical_path, blockers, role_coverage). */
  analysis_deltas?: Record<string, number>;
  /** Plain-English audit-trail rationale string from the analyzer. */
  analysis_rationale?: string;
}

export interface StreamState {
  healthScore: number;
  metrics: HealthMetrics;
  history: HealthSnapshot[];
  recentContributions: StreamContribution[];
  artifact: { status: "draft" | "pending_ratification" | "final"; version: number } | null;
}
