// Health score metrics from CONTRACT.md

export interface HealthMetrics {
  /** % artifact sections resolved */
  completion_pct: number;
  /** authority-weighted agreement 0-100 */
  consensus_score: number;
  /** inverted est. time to close (100 = done) */
  critical_path_score: number;
  /** % defined roles with >= 1 contribution */
  role_coverage_pct: number;
  /** inverted blocker count (100 = no blockers) */
  blocker_score: number;
}
