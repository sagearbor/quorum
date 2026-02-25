// Dashboard component props from DASHBOARDS.md

import type { Quorum, Contribution, Artifact } from "./database";

export interface DashboardProps {
  quorum: Quorum;
  contributions: Contribution[];
  artifact: Artifact | null;
}
