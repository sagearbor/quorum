import type {
  Event,
  Quorum,
  Role,
  Contribution,
  ActiveRole,
} from "@quorum/types";

// ─── Seed Event ──────────────────────────────────────────────────────
export const mockEvent: Event = {
  id: "evt-001",
  name: "Duke Clinical Trial Expo 2026",
  slug: "duke-expo-2026",
  access_code: "DUKE2026",
  max_active_quorums: 5,
  created_by: "architect-001",
  created_at: "2026-02-25T09:00:00Z",
};

// ─── Quorum 1: IRB Protocol Review ──────────────────────────────────
export const quorum1: Quorum = {
  id: "q-001",
  event_id: "evt-001",
  title: "IRB Protocol Review — NCT-2026-4481",
  description:
    "Multi-site phase III trial safety protocol requires IRB sign-off, site PI clearance, and patient advocate input before enrollment opens.",
  status: "active",
  heat_score: 72,
  autonomy_level: 0,
  carousel_mode: "multi-view",
  dashboard_types: ["quorum_health_chart"],
  created_at: "2026-02-25T09:05:00Z",
};

export const quorum1Roles: Role[] = [
  {
    id: "r-001",
    quorum_id: "q-001",
    name: "IRB Chair",
    capacity: 1,
    authority_rank: 3,
    prompt_template: [
      { field_name: "safety_assessment", prompt: "Summarize safety concerns with the current protocol" },
      { field_name: "approval_conditions", prompt: "List conditions for IRB approval" },
    ],
    fallback_chain: ["r-002"],
    color: "#DC2626",
  },
  {
    id: "r-002",
    quorum_id: "q-001",
    name: "Site PI",
    capacity: 1,
    authority_rank: 2,
    prompt_template: [
      { field_name: "site_readiness", prompt: "Describe site readiness for enrollment" },
      { field_name: "staffing_plan", prompt: "Outline staffing and resource plan" },
    ],
    fallback_chain: [],
    color: "#2563EB",
  },
  {
    id: "r-003",
    quorum_id: "q-001",
    name: "Patient Advocate",
    capacity: "unlimited",
    authority_rank: 1,
    prompt_template: [
      { field_name: "patient_concerns", prompt: "What are the key patient concerns?" },
      { field_name: "informed_consent", prompt: "Feedback on the informed consent document" },
    ],
    fallback_chain: [],
    color: "#16A34A",
  },
];

// ─── Quorum 2: Data Safety Monitoring ───────────────────────────────
export const quorum2: Quorum = {
  id: "q-002",
  event_id: "evt-001",
  title: "DSMB Interim Analysis",
  description:
    "Data Safety Monitoring Board reviews interim results for futility and safety signals. Biostatistician presents unblinded data.",
  status: "active",
  heat_score: 45,
  autonomy_level: 0,
  carousel_mode: "multi-view",
  dashboard_types: ["quorum_health_chart"],
  created_at: "2026-02-25T10:00:00Z",
};

export const quorum2Roles: Role[] = [
  {
    id: "r-004",
    quorum_id: "q-002",
    name: "DSMB Chair",
    capacity: 1,
    authority_rank: 3,
    prompt_template: [
      { field_name: "safety_signal", prompt: "Describe any safety signals observed" },
      { field_name: "recommendation", prompt: "Continue, modify, or stop recommendation" },
    ],
    fallback_chain: [],
    color: "#9333EA",
  },
  {
    id: "r-005",
    quorum_id: "q-002",
    name: "Biostatistician",
    capacity: 1,
    authority_rank: 2,
    prompt_template: [
      { field_name: "interim_results", prompt: "Summarize interim efficacy and safety data" },
      { field_name: "futility_analysis", prompt: "Present futility boundary analysis" },
    ],
    fallback_chain: [],
    color: "#0891B2",
  },
  {
    id: "r-006",
    quorum_id: "q-002",
    name: "Clinical Monitor",
    capacity: "unlimited",
    authority_rank: 1,
    prompt_template: [
      { field_name: "site_compliance", prompt: "Report on site protocol compliance" },
      { field_name: "data_quality", prompt: "Assess data quality and completeness" },
    ],
    fallback_chain: [],
    color: "#CA8A04",
  },
];

// ─── Quorum 3: Enrollment Strategy ──────────────────────────────────
export const quorum3: Quorum = {
  id: "q-003",
  event_id: "evt-001",
  title: "Multi-Site Enrollment Strategy",
  description:
    "Coordinate enrollment targets across 12 sites. Address racial and geographic diversity requirements from sponsor.",
  status: "open",
  heat_score: 18,
  autonomy_level: 0,
  carousel_mode: "multi-view",
  dashboard_types: ["quorum_health_chart"],
  created_at: "2026-02-25T11:00:00Z",
};

export const quorum3Roles: Role[] = [
  {
    id: "r-007",
    quorum_id: "q-003",
    name: "Sponsor Representative",
    capacity: 1,
    authority_rank: 3,
    prompt_template: [
      { field_name: "enrollment_targets", prompt: "Define enrollment targets and timeline" },
      { field_name: "diversity_requirements", prompt: "Specify diversity and inclusion requirements" },
    ],
    fallback_chain: [],
    color: "#E11D48",
  },
  {
    id: "r-008",
    quorum_id: "q-003",
    name: "Site Coordinator",
    capacity: "unlimited",
    authority_rank: 1,
    prompt_template: [
      { field_name: "site_capacity", prompt: "Report current enrollment capacity" },
      { field_name: "recruitment_barriers", prompt: "Identify key recruitment barriers" },
    ],
    fallback_chain: [],
    color: "#7C3AED",
  },
  {
    id: "r-009",
    quorum_id: "q-003",
    name: "CRO Project Manager",
    capacity: 1,
    authority_rank: 2,
    prompt_template: [
      { field_name: "timeline_assessment", prompt: "Assess feasibility of enrollment timeline" },
      { field_name: "resource_plan", prompt: "Outline resource allocation across sites" },
    ],
    fallback_chain: [],
    color: "#059669",
  },
];

// ─── All data lookups ────────────────────────────────────────────────
export const mockQuorums: Quorum[] = [quorum1, quorum2, quorum3];

export const mockRolesByQuorum: Record<string, Role[]> = {
  "q-001": quorum1Roles,
  "q-002": quorum2Roles,
  "q-003": quorum3Roles,
};

// Alias for stream-i compatibility
export const mockRoles = mockRolesByQuorum;

export const mockActiveRoles: Record<string, ActiveRole[]> = {
  "q-001": [
    { role_id: "r-001", participant_count: 1 },
    { role_id: "r-002", participant_count: 1 },
    { role_id: "r-003", participant_count: 3 },
  ],
  "q-002": [
    { role_id: "r-004", participant_count: 1 },
    { role_id: "r-005", participant_count: 1 },
    { role_id: "r-006", participant_count: 2 },
  ],
  "q-003": [
    { role_id: "r-007", participant_count: 0 },
    { role_id: "r-008", participant_count: 0 },
    { role_id: "r-009", participant_count: 0 },
  ],
};

export const mockContributions: Contribution[] = [
  {
    id: "c-001",
    quorum_id: "q-001",
    role_id: "r-003",
    user_token: "anon-user-1",
    content: "Patients expressed confusion about the consent form language around adverse event reporting.",
    structured_fields: {
      patient_concerns: "Consent form language is too technical for lay participants",
      informed_consent: "Recommend plain-language summary on page 1",
    },
    tier_processed: 1,
    created_at: "2026-02-25T09:30:00Z",
  },
  {
    id: "c-002",
    quorum_id: "q-001",
    role_id: "r-002",
    user_token: "anon-user-2",
    content: "Duke site is ready for enrollment pending IRB approval. Staff trained on protocol v3.2.",
    structured_fields: {
      site_readiness: "All staff trained, pharmacy stocked, lab certified",
      staffing_plan: "2 RNs, 1 CRC, PI available 3 days/week",
    },
    tier_processed: 1,
    created_at: "2026-02-25T09:45:00Z",
  },
];

// Station-to-role default mapping (station N maps to role index)
export const stationRoleMap: Record<number, string> = {
  1: "r-001", // Station 1 → IRB Chair
  2: "r-002", // Station 2 → Site PI
  3: "r-003", // Station 3 → Patient Advocate
  4: "r-004", // Station 4 → DSMB Chair
  5: "r-005", // Station 5 → Biostatistician
};
