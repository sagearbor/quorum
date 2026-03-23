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
}

/**
 * Fetch all events (newest first).
 * In demo mode returns two canned events so the UI works offline.
 */
export async function getEvents(): Promise<EventSummary[]> {
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
  try {
    const res = await fetch(`${apiBase}/events`);
    if (!res.ok) return [];
    const data = await res.json();
    // API returns a list directly
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
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

  // Live mode — fetch from Supabase
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

  // Enrich with roles, contributions, artifact for each quorum
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

/** Response from the ask-facilitator endpoint. */
export interface FacilitatorReply {
  reply: string;
  message_id: string;
  tags: string[];
}

/** Response from the contribute endpoint (extended for agent system). */
export interface ContributeAgentResponse {
  contribution_id: string;
  tier_processed: number;
  facilitator_reply: string | null;
  facilitator_message_id: string | null;
  facilitator_tags: string[] | null;
  a2a_requests_triggered: number;
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
