/**
 * DemoEngine — fully offline demo mode using EventEmitter pattern.
 *
 * Manages 1 event with 3 quorums (clinical trial pre-seeded + 2 stubs).
 * tick() every 5s: picks a random role, adds a realistic fake contribution,
 * recalculates health score. Emits same events as Supabase realtime.
 */

import seedData from "../../../../seed/clinical-trial.json";

// Re-export seed types inline — avoids circular dep with @quorum/types
// which may not be resolvable from the web app in all setups.

type DemoEventType = "contribution" | "health_update" | "artifact_update";

type DemoHandler = (data: unknown) => void;

interface DemoContribution {
  id: string;
  quorum_id: string;
  role_id: string;
  user_token: string;
  content: string;
  structured_fields: Record<string, string>;
  tier_processed: number;
  created_at: string;
}

interface DemoRole {
  id: string;
  name: string;
  capacity: number | string;
  authority_rank: number;
  prompt_template: { field_name: string; prompt: string }[];
  fallback_chain: string[];
  color: string;
}

interface DemoArtifactSection {
  title: string;
  content: string;
  source_roles: string[];
  status: string;
}

interface DemoArtifact {
  id: string;
  quorum_id: string;
  version: number;
  content_hash: string;
  sections: DemoArtifactSection[];
  status: string;
  created_at: string;
}

interface DemoQuorum {
  id: string;
  event_id: string;
  title: string;
  description: string;
  status: string;
  heat_score: number;
  autonomy_level?: number;
  dashboard_types: string[];
  carousel_mode: string;
  roles: DemoRole[];
  contributions: DemoContribution[];
  artifact: DemoArtifact | null;
}

interface DemoEvent {
  id: string;
  name: string;
  slug: string;
  access_code: string;
  max_active_quorums: number;
  created_by: string;
  created_at: string;
}

interface DemoState {
  event: DemoEvent;
  quorums: DemoQuorum[];
}

// -- Realistic contribution templates for each role in the clinical trial --

const FAKE_CONTRIBUTIONS: Record<string, string[]> = {
  "Site Coordinator": [
    "Site enrollment improved 12% after adding evening clinic hours. Patient retention for visits 7-12 is still a concern. Requesting additional CRC staffing for weekend availability.",
    "New pre-screening protocol reducing screen-fail rate from 35% to 22%. Patients are responding well to the simplified consent summary sheet. Need translation support for Mandarin-speaking population.",
    "Our site can onboard 8 additional patients this month if telehealth visits are approved. Lab turnaround improved to 24h with new vendor. Parking reimbursement helping elderly patients significantly.",
    "Community outreach at local health fair generated 15 new leads. Faith-based partnerships producing referrals from 3 churches. Mobile clinic option could reach rural patients within our catchment.",
    "Post-amendment enrollment velocity up 40%. eGFR relaxation opened pool of 28 eligible patients we previously screened out. Weekend CRC hire starts next Monday.",
  ],
  "IRB Officer": [
    "Reviewing telehealth consent addendum — minor language clarification needed on data storage for video recordings. Otherwise meets 21 CFR 50.25 requirements. Expect approval within 5 business days.",
    "DSMB interim report at n=50 shows no safety signal in expanded eGFR cohort. Recommend proceeding to full enrollment under amended protocol. Formal letter to follow.",
    "Reviewed plain-language summary — reading level assessment shows 7.2 grade level, target is 6th. Recommend simplifying section on potential cardiac events. Spanish back-translation verified by independent reviewer.",
    "Expedited review completed for evening/weekend clinic hours amendment. No additional risk identified. Approved effective immediately. Next full board review in 30 days.",
  ],
  "Patient Advocate": [
    "Peer support group pilot at Durham site showing strong engagement — 8 of 10 trial participants attending monthly meetings. Patients report feeling less isolated in their experience.",
    "Survey of 50 community members: 72% would consider trial participation if consent process simplified. Top concerns: time commitment (45%), fear of side effects (30%), distrust (25%).",
    "Patient-facing website redesign mockup reviewed by 12 community members. Testimonial section rated most valuable. FAQ section needs more plain-language explanations of cardiac terminology.",
    "Childcare reimbursement program launched at 3 sites. First month: 6 participants used the benefit, all completed their scheduled visits. Expanding to remaining sites.",
  ],
  "Safety Monitor": [
    "Week 4 safety data: AE rates in expanded cohort comparable to original cohort. No renal-specific events above baseline. Pharmacovigilance team recommends continuing enrollment.",
    "Quarterly safety review complete. 2 SAEs reported, both unrelated to study drug per adjudication committee. DSMB has no concerns about continuing the trial.",
    "Enhanced renal monitoring at 24h intervals showing creatinine levels within expected range for expanded eGFR cohort. Safety profile favorable for continued enrollment.",
  ],
  "Sponsor": [
    "Budget approved for Phase 2 site support: $180K for CRC staffing, $50K translation, $30K patient materials. Vendor contracts executing this week. Q3 enrollment target revised to 72%.",
    "Board update delivered — enrollment trajectory now on track for 80% by Q1 2027. Cost per patient reduced 15% with telehealth visits. Recommending 2 additional community sites.",
    "Centralized recruitment campaign launched: digital ads in 3 metro areas, community radio in 2 rural markets. First week: 120 website visits, 18 pre-screening inquiries.",
  ],
};

// Artifact section updates that simulate progressive refinement
const ARTIFACT_UPDATES: DemoArtifactSection[][] = [
  // After a few more ticks, add a 4th section
  [
    {
      title: "Protocol Amendment Recommendations",
      content:
        "1. Relax eGFR inclusion criterion from >60 to >45 mL/min/1.73m²\n2. Add telehealth option for 4 of 12 follow-up visits\n3. Extend enrollment window by 4-6 months (hard stop Q2 2027)\n4. Add simplified consent summary in plain language + Spanish translation\n5. Phased rollout: 50-patient DSMB review before full enrollment under relaxed criteria",
      source_roles: ["Sponsor", "Safety Monitor", "Site Coordinator"],
      status: "approved",
    },
    {
      title: "IRB Conditions for Approval",
      content:
        "1. DSMB interim safety review at n=50 (phased) then n=200\n2. Telehealth consent addendum — approved with minor language clarification\n3. 24h renal AE reporting for expanded cohort\n4. Updated risk-benefit analysis — favorable\n5. Spanish materials via certified medical translation with back-translation",
      source_roles: ["IRB Officer"],
      status: "approved",
    },
    {
      title: "Site Support Plan",
      content:
        "1. Fund 5 additional CRC positions at top-enrolling sites\n2. Centralized recruitment campaign ($200K budget) — launched\n3. Patient travel reimbursement program — active at 8 sites\n4. Evening/weekend clinic hours at 5 sites\n5. Community outreach via faith-based partnerships and health fairs\n6. Mobile clinic pilot for rural catchment areas",
      source_roles: ["Safety Monitor", "Site Coordinator", "Sponsor"],
      status: "approved",
    },
    {
      title: "Patient Engagement Improvements",
      content:
        "1. Plain-language consent summary (6th grade reading level) — in review\n2. Spanish-language materials — certified translation in progress\n3. Peer support program piloted at Durham — expanding to all sites\n4. Childcare reimbursement active at 3 sites\n5. Patient-facing website redesign with testimonials and FAQ\n6. Community radio and digital recruitment campaign live",
      source_roles: ["Patient Advocate", "Site Coordinator"],
      status: "pending_review",
    },
  ],
];

let nextContribId = 100;

function generateContribId(): string {
  nextContribId++;
  return `c0000000-0000-0000-0000-${String(nextContribId).padStart(12, "0")}`;
}

class DemoEngine {
  private state: DemoState;
  private listeners: Map<string, Set<DemoHandler>> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  // Track which fake contributions have been used per role
  private usedContribIndices: Map<string, number> = new Map();

  constructor() {
    // Deep clone seed data so mutations don't affect the import
    this.state = JSON.parse(JSON.stringify(seedData)) as DemoState;
  }

  /** Get full current state. */
  getState(): DemoState {
    return this.state;
  }

  /** Get quorums for a specific event slug. */
  getQuorums(eventSlug: string): DemoQuorum[] {
    if (this.state.event.slug === eventSlug) {
      return this.state.quorums;
    }
    return [];
  }

  /** Get a single quorum by ID. */
  getQuorum(quorumId: string): DemoQuorum | undefined {
    return this.state.quorums.find((q) => q.id === quorumId);
  }

  /** Get roles for a quorum. */
  getRoles(quorumId: string): DemoRole[] {
    const q = this.getQuorum(quorumId);
    return q?.roles ?? [];
  }

  /** Get contributions for a quorum. */
  getContributions(quorumId: string): DemoContribution[] {
    const q = this.getQuorum(quorumId);
    return q?.contributions ?? [];
  }

  /** Get artifact for a quorum. */
  getArtifact(quorumId: string): DemoArtifact | null {
    const q = this.getQuorum(quorumId);
    return q?.artifact ?? null;
  }

  /** Get health score for a quorum. */
  getHealthScore(quorumId: string): number {
    const q = this.getQuorum(quorumId);
    return q?.heat_score ?? 0;
  }

  /** Subscribe to events. Returns unsubscribe function. */
  subscribe(event: DemoEventType, handler: DemoHandler): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => {
      this.listeners.get(event)?.delete(handler);
    };
  }

  /** Emit an event to all subscribers. */
  private emit(event: DemoEventType, data: unknown): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      Array.from(handlers).forEach((handler) => {
        try {
          handler(data);
        } catch {
          // Don't let subscriber errors crash the engine
        }
      });
    }
  }

  /** Start the demo engine — ticks every 5 seconds. */
  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => this.tick(), 5000);
  }

  /** Stop the demo engine. */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Single tick: add contribution to clinical trial quorum, update health. */
  private tick(): void {
    this.tickCount++;
    const clinicalQuorum = this.state.quorums[0];
    if (!clinicalQuorum) return;

    // Pick a random role
    const roles = clinicalQuorum.roles;
    const role = roles[Math.floor(Math.random() * roles.length)];

    // Get next contribution text for this role
    const templates = FAKE_CONTRIBUTIONS[role.name];
    if (!templates || templates.length === 0) return;

    const usedIdx = this.usedContribIndices.get(role.name) ?? 0;
    const contentIdx = usedIdx % templates.length;
    this.usedContribIndices.set(role.name, usedIdx + 1);

    const content = templates[contentIdx];

    // Build structured fields from the role's prompt template
    const structured_fields: Record<string, string> = {};
    for (const field of role.prompt_template) {
      structured_fields[field.field_name] = content.substring(0, 120) + "...";
    }

    const contribution: DemoContribution = {
      id: generateContribId(),
      quorum_id: clinicalQuorum.id,
      role_id: role.id,
      user_token: `demo-${role.name.toLowerCase().replace(/\s+/g, "-")}-${this.tickCount}`,
      content,
      structured_fields,
      tier_processed: 1,
      created_at: new Date().toISOString(),
    };

    // Add to state
    clinicalQuorum.contributions.push(contribution);

    // Emit contribution event
    this.emit("contribution", contribution);

    // Recalculate health score
    // Starts at 35, rises ~3pts per tick, caps at 88
    const baseScore = 35;
    const increment = 3 + (Math.random() - 0.5); // ~3 pts with jitter
    const newScore = Math.min(88, baseScore + this.tickCount * increment);
    clinicalQuorum.heat_score = Math.round(newScore * 10) / 10;

    // Compute metrics for the health_update event
    const totalRoles = clinicalQuorum.roles.length;
    const coveredRoleIds = new Set(
      clinicalQuorum.contributions.map((c) => c.role_id)
    );
    const roleCoverage = (coveredRoleIds.size / totalRoles) * 100;

    const artifactSections = clinicalQuorum.artifact?.sections.length ?? 0;
    const completionPct = Math.min(100, (artifactSections / 5) * 100);

    this.emit("health_update", {
      quorum_id: clinicalQuorum.id,
      score: clinicalQuorum.heat_score,
      metrics: {
        completion_pct: completionPct,
        consensus_score: Math.min(100, 40 + this.tickCount * 4),
        critical_path_score: Math.min(100, 30 + this.tickCount * 5),
        role_coverage_pct: roleCoverage,
        blocker_score: Math.min(100, 60 + this.tickCount * 3),
      },
    });

    // Every 6 ticks, update the artifact
    if (this.tickCount % 6 === 0 && clinicalQuorum.artifact) {
      const updateIdx = Math.min(
        Math.floor(this.tickCount / 6) - 1,
        ARTIFACT_UPDATES.length - 1
      );
      if (updateIdx >= 0 && ARTIFACT_UPDATES[updateIdx]) {
        clinicalQuorum.artifact.sections = ARTIFACT_UPDATES[updateIdx];
        clinicalQuorum.artifact.version += 1;
        clinicalQuorum.artifact.content_hash = `sha256:demo-v${clinicalQuorum.artifact.version}`;

        this.emit("artifact_update", {
          ...clinicalQuorum.artifact,
          quorum_id: clinicalQuorum.id,
        });
      }
    }
  }
}

// Singleton instance
let engine: DemoEngine | null = null;

export function getDemoEngine(): DemoEngine {
  if (!engine) {
    engine = new DemoEngine();
  }
  return engine;
}

// ---------------------------------------------------------------------------
// Demo facilitator replies (moved from dataProvider to keep mock data here)
// ---------------------------------------------------------------------------

export const DEMO_FACILITATOR_REPLIES = [
  "I'm running in demo mode. In a live session I would provide context-aware guidance based on the quorum's active documents, contribution history, and cross-station insights.",
  "Demo mode is active — no backend is connected. Try submitting a contribution to see how the quorum health score updates in real time.",
  "This is a demonstration of the Quorum facilitator. In production, I synthesize perspectives from all roles and help surface conflicts before they escalate.",
  "The facilitator agent system is designed to assist each station independently while maintaining a global view of the quorum's progress. Ask me anything in a live session.",
];

// ---------------------------------------------------------------------------
// Demo agent documents (moved from dataProvider to keep mock data here)
// ---------------------------------------------------------------------------

export function getDemoDocuments(quorumId: string): {
  id: string;
  quorum_id: string;
  title: string;
  doc_type: string;
  format: string;
  content: Record<string, unknown>;
  status: string;
  version: number;
  tags: string[];
  created_by_role_id: string;
  created_at: string;
  updated_at: string;
}[] {
  const now = new Date().toISOString();
  return [
    {
      id: "demo-doc-001",
      quorum_id: quorumId,
      title: "Protocol Amendment — eGFR Threshold",
      doc_type: "protocol",
      format: "json",
      content: {
        schema_version: "1.0",
        sections: {
          amendment: {
            original_criterion: "eGFR > 60 mL/min/1.73m²",
            proposed_criterion: "eGFR > 45 mL/min/1.73m²",
            rationale: "Expand eligible population by ~30%",
            dsmb_review_required: true,
          },
        },
        metadata: { last_editors: ["demo-irb", "demo-safety"], conflict_zones: [] },
      },
      status: "active",
      version: 3,
      tags: ["egfr", "protocol_amendment", "enrollment"],
      created_by_role_id: "demo-irb",
      created_at: now,
      updated_at: now,
    },
    {
      id: "demo-doc-002",
      quorum_id: quorumId,
      title: "Site Support Budget",
      doc_type: "budget",
      format: "json",
      content: {
        schema_version: "1.0",
        sections: {
          budget: {
            line_items: [
              { category: "CRC staffing", amount: 180000, status: "approved" },
              { category: "Translation services", amount: 50000, status: "approved" },
              { category: "Patient materials", amount: 30000, status: "pending" },
            ],
            total_approved: 230000,
            total_pending: 30000,
          },
        },
        metadata: { last_editors: ["demo-sponsor"], conflict_zones: [] },
      },
      status: "active",
      version: 2,
      tags: ["budget", "crc_staffing", "sponsor"],
      created_by_role_id: "demo-sponsor",
      created_at: now,
      updated_at: now,
    },
  ];
}

export type {
  DemoEngine,
  DemoState,
  DemoEvent,
  DemoQuorum,
  DemoRole,
  DemoContribution,
  DemoArtifact,
  DemoArtifactSection,
  DemoEventType,
  DemoHandler,
};
