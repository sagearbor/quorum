import type { Event, Quorum, Role } from "@quorum/types";

export const mockEvent: Event = {
  id: "evt-001",
  name: "Duke Expo 2026",
  slug: "duke-expo-2026",
  access_code: "DUKE2026",
  max_active_quorums: 5,
  created_by: "architect-1",
  created_at: new Date().toISOString(),
};

export const mockRoles: Record<string, Role[]> = {
  "q-001": [
    {
      id: "r-001",
      quorum_id: "q-001",
      name: "Principal Investigator",
      capacity: 1,
      authority_rank: 3,
      prompt_template: [
        { field_name: "assessment", prompt: "Provide your clinical assessment" },
      ],
      fallback_chain: [],
      color: "#3B82F6",
    },
    {
      id: "r-002",
      quorum_id: "q-001",
      name: "IRB Representative",
      capacity: 1,
      authority_rank: 2,
      prompt_template: [
        { field_name: "review", prompt: "Provide your regulatory review" },
      ],
      fallback_chain: [],
      color: "#EF4444",
    },
    {
      id: "r-003",
      quorum_id: "q-001",
      name: "Site Coordinator",
      capacity: "unlimited",
      authority_rank: 1,
      prompt_template: [
        { field_name: "status", prompt: "Provide site status update" },
      ],
      fallback_chain: [],
      color: "#10B981",
    },
  ],
  "q-002": [
    {
      id: "r-004",
      quorum_id: "q-002",
      name: "Lead Physician",
      capacity: 1,
      authority_rank: 2,
      prompt_template: [
        { field_name: "diagnosis", prompt: "Enter diagnosis notes" },
      ],
      fallback_chain: [],
      color: "#8B5CF6",
    },
    {
      id: "r-005",
      quorum_id: "q-002",
      name: "Patient Advocate",
      capacity: "unlimited",
      authority_rank: 1,
      prompt_template: [
        { field_name: "concerns", prompt: "List patient concerns" },
      ],
      fallback_chain: [],
      color: "#F59E0B",
    },
  ],
  "q-003": [
    {
      id: "r-006",
      quorum_id: "q-003",
      name: "Data Safety Monitor",
      capacity: 1,
      authority_rank: 3,
      prompt_template: [
        { field_name: "findings", prompt: "Report safety findings" },
      ],
      fallback_chain: [],
      color: "#EC4899",
    },
    {
      id: "r-007",
      quorum_id: "q-003",
      name: "Biostatistician",
      capacity: 1,
      authority_rank: 2,
      prompt_template: [
        { field_name: "analysis", prompt: "Provide statistical analysis" },
      ],
      fallback_chain: [],
      color: "#06B6D4",
    },
    {
      id: "r-008",
      quorum_id: "q-003",
      name: "Clinical Research Associate",
      capacity: "unlimited",
      authority_rank: 1,
      prompt_template: [
        { field_name: "monitoring", prompt: "Enter monitoring report" },
      ],
      fallback_chain: [],
      color: "#84CC16",
    },
  ],
};

export const mockQuorums: Quorum[] = [
  {
    id: "q-001",
    event_id: "evt-001",
    title: "Protocol Amendment Review",
    description: "Review proposed amendments to the Phase III trial protocol",
    status: "active",
    heat_score: 78,
    carousel_mode: "multi-view",
    dashboard_types: ["quorum_health_chart", "authority_cascade_tree"],
    created_at: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: "q-002",
    event_id: "evt-001",
    title: "Adverse Event Assessment",
    description: "Evaluate reported adverse events from Site 12",
    status: "active",
    heat_score: 92,
    carousel_mode: "multi-view",
    dashboard_types: ["quorum_health_chart", "consensus_heat_ring"],
    created_at: new Date(Date.now() - 7200000).toISOString(),
  },
  {
    id: "q-003",
    event_id: "evt-001",
    title: "Data Safety Monitoring",
    description: "Quarterly DSMB review of unblinded interim data",
    status: "open",
    heat_score: 45,
    carousel_mode: "multi-quorum",
    dashboard_types: [
      "quorum_health_chart",
      "contribution_river",
      "role_coverage_map",
    ],
    created_at: new Date(Date.now() - 1800000).toISOString(),
  },
];
