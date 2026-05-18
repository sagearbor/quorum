/**
 * dataProvider — unified data access layer.
 *
 * All components import from here, never directly from supabase or demoMode.
 * Switches between DemoEngine (offline) and Supabase (live) based on env.
 */

import type {
  DemoQuorum,
  DemoRole,
  DemoContribution,
  DemoArtifact,
} from "./demoMode";
import { buildWsUrl } from "./wsUrl";

// Dynamic import() so demoMode.ts (and its seed JSON) are excluded from the
// production bundle when QUORUM_TEST_MODE is off. All calls gated by isDemoMode().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _cachedDemoModule: any = null;

async function loadDemoEngine() {
  if (!_cachedDemoModule) {
    _cachedDemoModule = await import("./demoMode");
  }
  return _cachedDemoModule.getDemoEngine();
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

export function isDemoMode(): boolean {
  // Demo mode is ONLY active when explicitly requested via env var.
  // Missing Supabase URL should yield empty state, not mock data.
  if (typeof window !== "undefined") {
    return process.env.NEXT_PUBLIC_QUORUM_TEST_MODE === "true";
  }
  return (
    process.env.QUORUM_TEST_MODE === "true" ||
    process.env.NEXT_PUBLIC_QUORUM_TEST_MODE === "true"
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventSummary {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  access_code?: string | null;
  max_active_quorums?: number | null;
  archived_at?: string | null;
}

/**
 * Fetch all events (newest first).
 * In demo mode returns two canned events so the UI works offline.
 * Pass includeArchived=true to surface soft-archived events.
 */
export async function getEvents(includeArchived = false): Promise<EventSummary[]> {
  if (isDemoMode()) {
    return [
      {
        id: "demo-evt-001",
        name: "BEACON-CV Clinical Trial Rescue",
        slug: "beacon-cv-rescue",
        created_at: "2026-02-25T09:00:00Z",
      },
      {
        id: "demo-evt-002",
        name: "Duke Health Expo 2026",
        slug: "duke-expo-2026",
        created_at: "2026-03-01T10:00:00Z",
      },
    ];
  }

  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const url = `${apiBase}/events${includeArchived ? "?include_archived=true" : ""}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    // API returns a list directly
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// API base — when set, data is fetched from the API instead of Supabase
// ---------------------------------------------------------------------------

function getApiBase(): string | null {
  return process.env.NEXT_PUBLIC_API_URL ?? null;
}

// ---------------------------------------------------------------------------
// Quorum data
// ---------------------------------------------------------------------------

export async function getQuorums(
  eventSlug: string
): Promise<DemoQuorum[]> {
  if (isDemoMode()) {
    const engine = await loadDemoEngine();
    return engine.getQuorums(eventSlug);
  }

  const apiBase = getApiBase();
  if (apiBase) {
    try {
      const idsRes = await fetch(`${apiBase}/events/${eventSlug}/quorum-ids`);
      if (!idsRes.ok) return [];
      const ids: string[] = await idsRes.json();
      if (!ids.length) return [];

      const quorums = await Promise.all(
        ids.map(async (id) => {
          try {
            const [stateRes, rolesJson] = await Promise.all([
              fetch(`${apiBase}/quorums/${id}/state`).then(r => r.ok ? r.json() : null),
              fetch(`${apiBase}/quorums/${id}/roles`).then(r => r.ok ? r.json() : []).catch(() => []),
            ]);
            if (!stateRes) return null;
            return {
              ...stateRes.quorum,
              roles: rolesJson ?? [],
              contributions: stateRes.contributions ?? [],
              artifact: stateRes.artifact ?? null,
            };
          } catch { return null; }
        })
      );
      return quorums.filter(Boolean) as DemoQuorum[];
    } catch {
      return [];
    }
  }

  // Supabase direct path
  const { supabase } = await import("./supabase");
  const { data: event } = await supabase
    .from("events")
    .select("id")
    .eq("slug", eventSlug)
    .single();

  if (!event) return [];

  const { data: quorums } = await supabase
    .from("quorums")
    .select("*")
    .eq("event_id", event.id)
    .order("created_at");

  if (!quorums) return [];

  const enriched = await Promise.all(
    quorums.map(async (q) => {
      const [rolesRes, contribsRes, artifactRes] = await Promise.all([
        supabase.from("roles").select("*").eq("quorum_id", q.id).order("authority_rank", { ascending: false }),
        supabase.from("contributions").select("*").eq("quorum_id", q.id).order("created_at"),
        supabase.from("artifacts").select("*").eq("quorum_id", q.id).limit(1),
      ]);

      return {
        ...q,
        roles: rolesRes.data ?? [],
        contributions: contribsRes.data ?? [],
        artifact: artifactRes.data?.[0] ?? null,
      };
    })
  );

  return enriched as DemoQuorum[];
}

export async function getQuorum(
  quorumId: string
): Promise<DemoQuorum | null> {
  if (isDemoMode()) {
    const engine = await loadDemoEngine();
    return engine.getQuorum(quorumId) ?? null;
  }

  const apiBase = getApiBase();
  if (apiBase) {
    try {
      const [stateRes, rolesJson] = await Promise.all([
        fetch(`${apiBase}/quorums/${quorumId}/state`).then(r => r.ok ? r.json() : null),
        fetch(`${apiBase}/quorums/${quorumId}/roles`).then(r => r.ok ? r.json() : []).catch(() => []),
      ]);
      if (!stateRes) return null;
      return {
        ...stateRes.quorum,
        roles: rolesJson ?? [],
        contributions: stateRes.contributions ?? [],
        artifact: stateRes.artifact ?? null,
      } as DemoQuorum;
    } catch { return null; }
  }

  const { supabase } = await import("./supabase");
  const { data: q } = await supabase
    .from("quorums")
    .select("*")
    .eq("id", quorumId)
    .single();

  if (!q) return null;

  const [rolesRes, contribsRes, artifactRes] = await Promise.all([
    supabase.from("roles").select("*").eq("quorum_id", q.id).order("authority_rank", { ascending: false }),
    supabase.from("contributions").select("*").eq("quorum_id", q.id).order("created_at"),
    supabase.from("artifacts").select("*").eq("quorum_id", q.id).limit(1),
  ]);

  return {
    ...q,
    roles: rolesRes.data ?? [],
    contributions: contribsRes.data ?? [],
    artifact: artifactRes.data?.[0] ?? null,
  } as DemoQuorum;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export async function getRoles(quorumId: string): Promise<DemoRole[]> {
  if (isDemoMode()) {
    const engine = await loadDemoEngine();
    return engine.getRoles(quorumId);
  }

  const apiBase = getApiBase();
  if (apiBase) {
    try {
      const res = await fetch(`${apiBase}/quorums/${quorumId}/roles`);
      if (!res.ok) return [];
      return await res.json();
    } catch { return []; }
  }

  const { supabase } = await import("./supabase");
  const { data } = await supabase
    .from("roles")
    .select("*")
    .eq("quorum_id", quorumId)
    .order("authority_rank", { ascending: false });

  return (data ?? []) as DemoRole[];
}

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

export async function getContributions(
  quorumId: string
): Promise<DemoContribution[]> {
  if (isDemoMode()) {
    const engine = await loadDemoEngine();
    return engine.getContributions(quorumId);
  }

  const apiBase = getApiBase();
  if (apiBase) {
    try {
      const res = await fetch(`${apiBase}/quorums/${quorumId}/state`);
      if (!res.ok) return [];
      const state = await res.json();
      return state.contributions ?? [];
    } catch { return []; }
  }

  const { supabase } = await import("./supabase");
  const { data } = await supabase
    .from("contributions")
    .select("*")
    .eq("quorum_id", quorumId)
    .order("created_at");

  return (data ?? []) as DemoContribution[];
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export async function getArtifact(
  quorumId: string
): Promise<DemoArtifact | null> {
  if (isDemoMode()) {
    const engine = await loadDemoEngine();
    return engine.getArtifact(quorumId);
  }

  const apiBase = getApiBase();
  if (apiBase) {
    try {
      const res = await fetch(`${apiBase}/quorums/${quorumId}/state`);
      if (!res.ok) return null;
      const state = await res.json();
      return state.artifact ?? null;
    } catch { return null; }
  }

  const { supabase } = await import("./supabase");
  const { data } = await supabase
    .from("artifacts")
    .select("*")
    .eq("quorum_id", quorumId)
    .limit(1);

  return (data?.[0] ?? null) as DemoArtifact | null;
}

// ---------------------------------------------------------------------------
// Health score
// ---------------------------------------------------------------------------

export async function getHealthScore(quorumId: string): Promise<number> {
  if (isDemoMode()) {
    const engine = await loadDemoEngine();
    return engine.getHealthScore(quorumId);
  }

  const { supabase } = await import("./supabase");
  const { data } = await supabase
    .from("quorums")
    .select("heat_score")
    .eq("id", quorumId)
    .single();

  return data?.heat_score ?? 0;
}

// ---------------------------------------------------------------------------
// Realtime subscriptions
// ---------------------------------------------------------------------------

/**
 * Subscribe to health updates for a quorum.
 * Returns an unsubscribe function.
 */
export function subscribeToHealth(
  quorumId: string,
  handler: (data: { score: number; metrics: Record<string, number> }) => void
): () => void {
  if (isDemoMode()) {
    let unsub: (() => void) | null = null;
    import("./demoMode").then(({ getDemoEngine }) => {
      unsub = getDemoEngine().subscribe("health_update", (raw) => {
        const data = raw as { quorum_id: string; score: number; metrics: Record<string, number> };
        if (data.quorum_id === quorumId) {
          handler({ score: data.score, metrics: data.metrics });
        }
      });
    });
    return () => { unsub?.(); };
  }

  // Live mode — Supabase realtime channel
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let channel: any = null;

  import("./supabase").then(({ supabase }) => {
    channel = supabase
      .channel(`health:${quorumId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "quorums",
          filter: `id=eq.${quorumId}`,
        },
        (payload) => {
          if (payload.new && typeof payload.new === "object" && "heat_score" in payload.new) {
            handler({
              score: (payload.new as Record<string, number>).heat_score,
              metrics: {},
            });
          }
        }
      )
      .subscribe();
  });

  return () => {
    if (channel) {
      import("./supabase").then(({ supabase }) => {
        supabase.removeChannel(channel!);
      });
    }
  };
}

/**
 * Subscribe to new contributions for a quorum.
 * Returns an unsubscribe function.
 */
export function subscribeToContributions(
  quorumId: string,
  handler: (contribution: DemoContribution) => void
): () => void {
  if (isDemoMode()) {
    let unsub: (() => void) | null = null;
    import("./demoMode").then(({ getDemoEngine }) => {
      unsub = getDemoEngine().subscribe("contribution", (raw) => {
        const c = raw as DemoContribution;
        if (c.quorum_id === quorumId) {
          handler(c);
        }
      });
    });
    return () => { unsub?.(); };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let channel: any = null;

  import("./supabase").then(({ supabase }) => {
    channel = supabase
      .channel(`contributions:${quorumId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "contributions",
          filter: `quorum_id=eq.${quorumId}`,
        },
        (payload) => {
          handler(payload.new as DemoContribution);
        }
      )
      .subscribe();
  });

  return () => {
    if (channel) {
      import("./supabase").then(({ supabase }) => {
        supabase.removeChannel(channel!);
      });
    }
  };
}

/**
 * Subscribe to artifact updates for a quorum.
 * Returns an unsubscribe function.
 */
export function subscribeToArtifact(
  quorumId: string,
  handler: (artifact: DemoArtifact) => void
): () => void {
  if (isDemoMode()) {
    let unsub: (() => void) | null = null;
    import("./demoMode").then(({ getDemoEngine }) => {
      unsub = getDemoEngine().subscribe("artifact_update", (raw) => {
        const a = raw as DemoArtifact & { quorum_id: string };
        if (a.quorum_id === quorumId) {
          handler(a);
        }
      });
    });
    return () => { unsub?.(); };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let channel: any = null;

  import("./supabase").then(({ supabase }) => {
    channel = supabase
      .channel(`artifact:${quorumId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "artifacts",
          filter: `quorum_id=eq.${quorumId}`,
        },
        (payload) => {
          handler(payload.new as DemoArtifact);
        }
      )
      .subscribe();
  });

  return () => {
    if (channel) {
      import("./supabase").then(({ supabase }) => {
        supabase.removeChannel(channel!);
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Station conversations
// ---------------------------------------------------------------------------

import type {
  StationMessage,
  AgentDocument,
  AgentRequest,
} from "@quorum/types";

/**
 * Response from the ask-facilitator endpoint.
 *
 * When the backend LLM call fails, ``paused`` is true and ``reply`` /
 * ``message_id`` are null. The frontend MUST NOT speak or render an
 * assistant message in that case — it should show the "reconnecting" pill
 * on the avatar and leave the thread untouched.
 */
export interface FacilitatorReply {
  reply: string | null;
  message_id: string | null;
  tags: string[];
  paused?: boolean;
  reason?: string | null;
}

/** Response from the contribute endpoint (extended for agent system). */
export interface ContributeAgentResponse {
  contribution_id: string;
  tier_processed: number;
  facilitator_reply: string | null;
  facilitator_message_id: string | null;
  facilitator_tags: string[] | null;
  a2a_requests_triggered: number;
  /** True when the facilitator turn was skipped because the LLM was unavailable. */
  facilitator_paused?: boolean;
  facilitator_paused_reason?: string | null;
}

/**
 * Fetch conversation history for a station.
 * In demo mode returns empty array (no backend for conversations in demo).
 */
export async function getStationMessages(
  quorumId: string,
  stationId: string,
  limit = 50
): Promise<StationMessage[]> {
  if (isDemoMode()) {
    return [];
  }

  const { supabase } = await import("./supabase");
  const { data } = await supabase
    .from("station_messages")
    .select("*")
    .eq("quorum_id", quorumId)
    .eq("station_id", stationId)
    .order("created_at", { ascending: true })
    .limit(limit);

  return (data ?? []) as StationMessage[];
}

/**
 * Ask the AI facilitator a direct question at a station.
 * Hits POST /quorums/{quorumId}/stations/{stationId}/ask.
 * In demo mode, returns a canned response so the UI remains functional offline.
 */
export async function askFacilitator(
  quorumId: string,
  stationId: string,
  roleId: string,
  content: string
): Promise<FacilitatorReply> {
  if (isDemoMode()) {
    const { DEMO_FACILITATOR_REPLIES } = await import("./demoMode");
    const idx = content.length % DEMO_FACILITATOR_REPLIES.length;
    const reply = DEMO_FACILITATOR_REPLIES[idx];
    return {
      reply,
      message_id: `demo-msg-${Date.now()}`,
      tags: ["demo", "facilitator"],
    };
  }

  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const res = await fetch(
    `${apiBase}/quorums/${quorumId}/stations/${stationId}/ask`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role_id: roleId, content }),
    }
  );
  if (!res.ok) {
    throw new Error(`askFacilitator: HTTP ${res.status}`);
  }
  return res.json() as Promise<FacilitatorReply>;
}

/**
 * Subscribe to new station messages via Supabase Realtime.
 * Returns an unsubscribe function.
 */
export function subscribeToStationMessages(
  quorumId: string,
  stationId: string,
  handler: (message: StationMessage) => void
): () => void {
  if (isDemoMode()) {
    // No-op in demo mode — conversations are synchronous
    return () => {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let channel: any = null;

  import("./supabase").then(({ supabase }) => {
    channel = supabase
      .channel(`station-messages:${quorumId}:${stationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "station_messages",
          filter: `quorum_id=eq.${quorumId}`,
        },
        (payload) => {
          const msg = payload.new as StationMessage;
          if (msg.station_id === stationId) {
            handler(msg);
          }
        }
      )
      .subscribe();
  });

  return () => {
    if (channel) {
      import("./supabase").then(({ supabase }) => {
        supabase.removeChannel(channel!);
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Agent documents
// ---------------------------------------------------------------------------

/**
 * Fetch all documents for a quorum (defaults to active status).
 */
export async function getAgentDocuments(
  quorumId: string,
  status?: "active" | "superseded" | "canceled"
): Promise<AgentDocument[]> {
  if (isDemoMode()) {
    const { getDemoDocuments } = await import("./demoMode");
    const docs = getDemoDocuments(quorumId) as AgentDocument[];
    return status ? docs.filter((d) => d.status === status) : docs;
  }

  const { supabase } = await import("./supabase");
  let query = supabase
    .from("agent_documents")
    .select("*")
    .eq("quorum_id", quorumId)
    .order("updated_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  } else {
    query = query.eq("status", "active");
  }

  const { data } = await query;
  return (data ?? []) as AgentDocument[];
}

/**
 * Subscribe to agent document inserts and updates via Supabase Realtime.
 * Returns an unsubscribe function.
 */
export function subscribeToAgentDocuments(
  quorumId: string,
  handler: (document: AgentDocument) => void
): () => void {
  if (isDemoMode()) {
    return () => {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let channel: any = null;

  import("./supabase").then(({ supabase }) => {
    channel = supabase
      .channel(`agent-documents:${quorumId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_documents",
          filter: `quorum_id=eq.${quorumId}`,
        },
        (payload) => {
          handler(payload.new as AgentDocument);
        }
      )
      .subscribe();
  });

  return () => {
    if (channel) {
      import("./supabase").then(({ supabase }) => {
        supabase.removeChannel(channel!);
      });
    }
  };
}

// ---------------------------------------------------------------------------
// A2A request subscriptions
// ---------------------------------------------------------------------------

/**
 * Subscribe to incoming A2A requests for a specific role.
 * Fires whenever a new agent_request row is inserted with to_role_id matching roleId.
 * In demo mode this is a no-op (A2A only happens with a live backend).
 */
export function subscribeToA2ARequests(
  quorumId: string,
  roleId: string,
  handler: (request: AgentRequest) => void
): () => void {
  if (isDemoMode()) {
    return () => {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let channel: any = null;

  import("./supabase").then(({ supabase }) => {
    channel = supabase
      .channel(`a2a-requests:${quorumId}:${roleId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "agent_requests",
          filter: `quorum_id=eq.${quorumId}`,
        },
        (payload) => {
          const req = payload.new as AgentRequest;
          // Only surface requests directed at the current role
          if (req.to_role_id === roleId) {
            handler(req);
          }
        }
      )
      .subscribe();
  });

  return () => {
    if (channel) {
      import("./supabase").then(({ supabase }) => {
        supabase.removeChannel(channel!);
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Facilitator narration (orchestrator-emitted WebSocket frame)
// ---------------------------------------------------------------------------

/**
 * Payload emitted by the backend orchestrator (checklist 11.3) at the start
 * of each autonomy round, BEFORE the chosen role-agent dispatch fires.
 *
 * The avatar consumes this as its ``synthesisText`` so the facilitator
 * narrates the turn ("Asking the biostatistician to weigh in on sample
 * size assumptions.") while the role-agent does its thinking.
 */
export interface FacilitatorNarration {
  /** One-sentence narration the avatar will speak. */
  narration: string;
  /** Role that is about to take the turn. */
  next_role_id: string;
  /** Role display name (optional — backend may omit on legacy paths). */
  next_role_name?: string | null;
  /** Orchestrator rationale (for debugging — not surfaced to the audience). */
  reason?: string | null;
}

/**
 * Subscribe to orchestrator-emitted ``facilitator_narration`` frames over the
 * existing per-quorum WebSocket channel.
 *
 * Returns an unsubscribe function. In demo mode this is a no-op (the demo
 * engine does not run a WebSocket server).
 *
 * Implementation note: this mirrors the WS-frame consumer in
 * ``apps/web/src/app/display/[slug]/page.tsx`` rather than going through
 * Supabase Realtime — narrations are emitted by the FastAPI WS manager, not
 * persisted to a table.
 */
export function subscribeToFacilitator(
  quorumId: string,
  handler: (frame: FacilitatorNarration) => void
): () => void {
  if (isDemoMode()) {
    return () => {};
  }
  // Server-side rendering: no window, no WebSocket. Bail gracefully.
  if (typeof window === "undefined") {
    return () => {};
  }

  let ws: WebSocket | null = null;
  let closed = false;

  try {
    ws = new WebSocket(buildWsUrl(`/quorums/${quorumId}/live`));

    ws.onmessage = (event) => {
      if (closed) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg && msg.type === "facilitator_narration") {
          handler({
            narration: msg.narration,
            next_role_id: msg.next_role_id,
            next_role_name: msg.next_role_name ?? null,
            reason: msg.reason ?? null,
          });
        }
      } catch {
        // Ignore non-JSON or malformed frames
      }
    };
  } catch {
    // WebSocket failed to construct — fall back to no-op
  }

  return () => {
    closed = true;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Facilitator observations (9.4 — meta-narration above the per-turn
// orchestrator narration). Distinct from the per-turn
// ``facilitator_narration`` frame above: ``facilitator_observation`` fires
// every Nth round (default 3) and carries audience-facing meta-narration
// ("Three roles flagged enrollment risk; IRB silent so far.") rather than
// per-turn speaker-election rationale.
//
// Wire shape (matches docs/CONTRACT.md WS frames):
//   {
//     type: "facilitator_observation",
//     summary: string,
//     severity: "info" | "notable" | "action_needed",
//     referenced_role_ids: string[],
//     suggested_tool_calls: string[],
//     round?: number
//   }
// ---------------------------------------------------------------------------

export type FacilitatorObservationSeverity =
  | "info"
  | "notable"
  | "action_needed";

/**
 * A higher-level meta-observation emitted by the facilitator agent
 * (apps/api/agents/facilitator.py) every Nth orchestrator round.
 */
export interface FacilitatorObservation {
  /** One sentence, audience-facing. */
  summary: string;
  /** Escalation cue for the UI. */
  severity: FacilitatorObservationSeverity;
  /** Role IDs the observation mentions (for avatar / panel highlighting). */
  referenced_role_ids: string[];
  /**
   * Tool names the agent suggests for follow-up. We do NOT auto-execute
   * these; they're surfaced for transparency / future operator UI.
   */
  suggested_tool_calls: string[];
  /** Orchestrator round number that produced this observation. */
  round?: number | null;
}

/**
 * Subscribe to facilitator-emitted ``facilitator_observation`` frames over
 * the per-quorum WebSocket channel.
 *
 * Mirrors ``subscribeToFacilitator`` for the per-turn narration frame —
 * same WS endpoint, different ``type`` discriminator. Returns an
 * unsubscribe function; no-op in demo mode and during SSR.
 */
export function subscribeToFacilitatorObservations(
  quorumId: string,
  handler: (frame: FacilitatorObservation) => void,
): () => void {
  if (isDemoMode()) {
    return () => {};
  }
  if (typeof window === "undefined") {
    return () => {};
  }

  let ws: WebSocket | null = null;
  let closed = false;

  try {
    ws = new WebSocket(
      buildWsUrl(`/quorums/${quorumId}/live`),
    );

    ws.onmessage = (event) => {
      if (closed) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg && msg.type === "facilitator_observation") {
          handler({
            summary: String(msg.summary ?? ""),
            severity: (msg.severity ?? "info") as FacilitatorObservationSeverity,
            referenced_role_ids: Array.isArray(msg.referenced_role_ids)
              ? msg.referenced_role_ids.map((r: unknown) => String(r))
              : [],
            suggested_tool_calls: Array.isArray(msg.suggested_tool_calls)
              ? msg.suggested_tool_calls.map((t: unknown) => String(t))
              : [],
            round: typeof msg.round === "number" ? msg.round : null,
          });
        }
      } catch {
        // Ignore non-JSON or malformed frames
      }
    };
  } catch {
    // WebSocket failed to construct — fall back to no-op
  }

  return () => {
    closed = true;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  };
}

// Arbitration / blackboard (11.7 — authority arbitration with dissents)
// ---------------------------------------------------------------------------

/**
 * One ``arbitration`` WS frame emitted by the autonomy loop after the
 * deterministic authority-arbitrator sweeps ``quorum_state.conflicts[]`` and
 * writes decisions + dissents.
 *
 * The frame is small on purpose — just the counters. Consumers that need
 * the full decisions/dissents arrays should re-fetch ``quorum_state`` (the
 * ``GET /quorums/{id}/blackboard`` route) or subscribe to the Supabase
 * realtime channel for that row.
 */
export interface ArbitrationFrame {
  /** Number of new decisions written this round (by authority_rank override). */
  decisions: number;
  /** Number of new dissent records written this round. */
  dissents: number;
  /** Number of conflicts left open due to tied authority_rank at the top. */
  ties_unresolved: number;
}

/**
 * Subscribe to orchestrator-emitted ``arbitration`` frames over the existing
 * per-quorum WebSocket channel.
 *
 * Returns an unsubscribe function. In demo mode this is a no-op (the demo
 * engine does not run a WebSocket server, and 11.7 arbitration is a
 * backend-only feature).
 *
 * Implementation mirrors ``subscribeToFacilitator`` — frames are emitted by
 * the FastAPI WS manager (autonomy loop Phase 2.5), NOT persisted to a
 * Supabase table; therefore Realtime is not the right transport here.
 *
 * Consumer pattern:
 * ```tsx
 * const [recent, setRecent] = useState<ArbitrationFrame | null>(null);
 * useEffect(() => subscribeToBlackboard(quorumId, setRecent), [quorumId]);
 * return recent && recent.dissents > 0 ? <DissentPill {...recent} /> : null;
 * ```
 *
 * TODO(11.7-followup): wire this into the quorum view page
 * (``apps/web/src/app/event/[slug]/quorum/[id]/page.tsx``) and the display
 * page to render a dissent pill / column. The full dissent list (role name
 * + reason) requires an additional ``GET /quorums/{id}/blackboard`` fetch
 * since the WS frame only carries counters. Backend is the load-bearing
 * change for this PR; the UI hookup is intentionally minimal here.
 */
export function subscribeToBlackboard(
  quorumId: string,
  handler: (frame: ArbitrationFrame) => void,
): () => void {
  if (isDemoMode()) {
    return () => {};
  }
  if (typeof window === "undefined") {
    return () => {};
  }

  let ws: WebSocket | null = null;
  let closed = false;

  try {
    ws = new WebSocket(
      buildWsUrl(`/quorums/${quorumId}/live`),
    );

    ws.onmessage = (event) => {
      if (closed) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg && msg.type === "arbitration") {
          handler({
            decisions: Number(msg.decisions) || 0,
            dissents: Number(msg.dissents) || 0,
            ties_unresolved: Number(msg.ties_unresolved) || 0,
          });
        }
      } catch {
        // Ignore non-JSON or malformed frames
      }
    };
  } catch {
    // WebSocket failed to construct — fall back to no-op
  }

  return () => {
    closed = true;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Participants (10.10 — presence dots)
// ---------------------------------------------------------------------------

/**
 * One row of the ``participants`` table — minted on QR scan or laptop
 * first-load and kept alive by ``POST /sessions/heartbeat`` every 30s.
 *
 * The presence-dots consumer (apps/web/src/hooks/usePresence.ts) buckets
 * these by ``role_id`` and decays them client-side based on
 * ``last_heartbeat_at`` (Supabase does not push UPDATEs as a row "ages out").
 */
export interface Participant {
  id: string;
  quorum_id: string;
  role_id: string | null;
  station_label: string | null;
  display_name: string;
  device_kind: "laptop" | "phone";
  last_heartbeat_at: string | null;
  created_at: string;
}

/**
 * Fetch the current participants snapshot for a quorum.
 * In demo mode returns an empty array — the demo engine doesn't simulate
 * humans connecting via QR.
 */
export async function getParticipants(
  quorumId: string,
): Promise<Participant[]> {
  if (isDemoMode()) return [];

  const { supabase } = await import("./supabase");
  const { data } = await supabase
    .from("participants")
    .select("*")
    .eq("quorum_id", quorumId);

  return (data ?? []) as Participant[];
}

/**
 * Subscribe to participant INSERT / UPDATE / DELETE for a quorum.
 *
 * Handler receives the new row on INSERT/UPDATE and the deleted row's id on
 * DELETE.  Returns an unsubscribe function.  In demo mode this is a no-op.
 *
 * NOTE: Supabase will not push events as rows "age out" (heartbeat goes
 * stale).  The consumer (``usePresence``) MUST re-bucket on its own timer.
 */
export function subscribeToParticipants(
  quorumId: string,
  handler: (event: {
    type: "INSERT" | "UPDATE" | "DELETE";
    participant: Participant | null;
    deletedId?: string;
  }) => void,
): () => void {
  if (isDemoMode()) {
    return () => {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let channel: any = null;

  import("./supabase").then(({ supabase }) => {
    channel = supabase
      .channel(`participants:${quorumId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "participants",
          filter: `quorum_id=eq.${quorumId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string } | null;
            handler({
              type: "DELETE",
              participant: null,
              deletedId: oldRow?.id,
            });
            return;
          }
          handler({
            type: payload.eventType as "INSERT" | "UPDATE",
            participant: payload.new as Participant,
          });
        },
      )
      .subscribe();
  });

  return () => {
    if (channel) {
      import("./supabase").then(({ supabase }) => {
        supabase.removeChannel(channel!);
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Engine control (demo mode only)
// ---------------------------------------------------------------------------

export function startDemo(): void {
  if (isDemoMode()) {
    import("./demoMode").then(({ getDemoEngine }) => {
      getDemoEngine().start();
    });
  }
}

export function stopDemo(): void {
  if (isDemoMode()) {
    import("./demoMode").then(({ getDemoEngine }) => {
      getDemoEngine().stop();
    });
  }
}
