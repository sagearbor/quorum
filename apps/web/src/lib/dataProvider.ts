/**
 * dataProvider — unified data access layer.
 *
 * All components import from here, never directly from supabase or demoMode.
 * Switches between DemoEngine (offline) and Supabase (live) based on env.
 */

import {
  getDemoEngine,
  type DemoQuorum,
  type DemoRole,
  type DemoContribution,
  type DemoArtifact,
  type DemoEventType,
  type DemoHandler,
} from "./demoMode";

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

export function isDemoMode(): boolean {
  // NEXT_PUBLIC_ prefix so it's available in browser
  if (typeof window !== "undefined") {
    // Client-side: check injected env vars
    return (
      process.env.NEXT_PUBLIC_QUORUM_TEST_MODE === "true" ||
      !process.env.NEXT_PUBLIC_SUPABASE_URL
    );
  }
  // Server-side: check both prefixed and unprefixed
  return (
    process.env.QUORUM_TEST_MODE === "true" ||
    process.env.NEXT_PUBLIC_QUORUM_TEST_MODE === "true" ||
    !process.env.NEXT_PUBLIC_SUPABASE_URL
  );
}

// ---------------------------------------------------------------------------
// Quorum data
// ---------------------------------------------------------------------------

export async function getQuorums(
  eventSlug: string
): Promise<DemoQuorum[]> {
  if (isDemoMode()) {
    return getDemoEngine().getQuorums(eventSlug);
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
    return getDemoEngine().getQuorum(quorumId) ?? null;
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
    return getDemoEngine().getRoles(quorumId);
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
    return getDemoEngine().getContributions(quorumId);
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
    return getDemoEngine().getArtifact(quorumId);
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
    return getDemoEngine().getHealthScore(quorumId);
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
    return getDemoEngine().subscribe("health_update", (raw) => {
      const data = raw as { quorum_id: string; score: number; metrics: Record<string, number> };
      if (data.quorum_id === quorumId) {
        handler({ score: data.score, metrics: data.metrics });
      }
    });
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
    return getDemoEngine().subscribe("contribution", (raw) => {
      const c = raw as DemoContribution;
      if (c.quorum_id === quorumId) {
        handler(c);
      }
    });
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
    return getDemoEngine().subscribe("artifact_update", (raw) => {
      const a = raw as DemoArtifact & { quorum_id: string };
      if (a.quorum_id === quorumId) {
        handler(a);
      }
    });
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
// Engine control (demo mode only)
// ---------------------------------------------------------------------------

export function startDemo(): void {
  if (isDemoMode()) {
    getDemoEngine().start();
  }
}

export function stopDemo(): void {
  if (isDemoMode()) {
    getDemoEngine().stop();
  }
}
