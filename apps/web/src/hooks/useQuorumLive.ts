"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import type { AgentRequest, HealthMetrics, HealthSnapshot, StreamContribution, StreamState } from "@quorum/types";
import { getA2ARequests, subscribeToQuorumA2ARequests } from "@/lib/dataProvider";

export interface LLMMetricRationale {
  ts: number;
  metric: string;
  delta: number;
  why: string;
}

export interface QuorumLiveState {
  healthScore: number;
  metrics: HealthMetrics;
  history: HealthSnapshot[];
  recentContributions: StreamContribution[];
  artifact: { status: "draft" | "pending_ratification" | "final"; version: number } | null;
  connected: boolean;
  error: string | null;
  /** Cumulative LLM-driven deltas per metric key (e.g. "consensus", "blockers"). */
  llmDeltas: Record<string, number>;
  /** Recent rationale entries from `[scores-why: ...]` blocks. Newest last. */
  llmRationales: LLMMetricRationale[];
  /** All A2A (agent-to-agent) requests for this quorum, newest first. */
  a2aEvents: AgentRequest[];
}

const INITIAL_METRICS: HealthMetrics = {
  completion_pct: 0,
  consensus_score: 0,
  role_coverage_pct: 0,
  critical_path_score: 0,
  blocker_score: 0,
};

const INITIAL_STATE: QuorumLiveState = {
  healthScore: 0,
  metrics: INITIAL_METRICS,
  history: [],
  recentContributions: [],
  artifact: null,
  connected: false,
  error: null,
  llmDeltas: {},
  llmRationales: [],
  a2aEvents: [],
};

/** Merge an incoming A2A row into the events list (newest first, dedupe by id). */
function mergeA2AEvent(prev: AgentRequest[], incoming: AgentRequest): AgentRequest[] {
  const idx = prev.findIndex((r) => r.id === incoming.id);
  if (idx >= 0) {
    const next = prev.slice();
    next[idx] = { ...next[idx], ...incoming };
    return next;
  }
  return [incoming, ...prev].slice(0, 200);
}

function _coerceRationales(raw: unknown): LLMMetricRationale[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r): LLMMetricRationale | null => {
      if (!r || typeof r !== "object") return null;
      const rec = r as Record<string, unknown>;
      const metric = typeof rec.metric === "string" ? rec.metric : null;
      const delta = typeof rec.delta === "number" ? rec.delta : null;
      const why = typeof rec.why === "string" ? rec.why : "";
      const ts = typeof rec.ts === "number" ? rec.ts : 0;
      if (metric == null || delta == null) return null;
      return { ts, metric, delta, why };
    })
    .filter((x): x is LLMMetricRationale => x !== null);
}

function _coerceDeltas(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function isTestMode(): boolean {
  return process.env.NEXT_PUBLIC_QUORUM_TEST_MODE === "true";
}

/**
 * Subscribe to live quorum state. Uses Supabase realtime in production,
 * falls back to mockStream when NEXT_PUBLIC_QUORUM_TEST_MODE=true.
 */
export function useQuorumLive(quorumId: string): QuorumLiveState {
  const [state, setState] = useState<QuorumLiveState>(INITIAL_STATE);
  const unsubRef = useRef<(() => void) | null>(null);

  const handleUpdate = useCallback((update: StreamState) => {
    setState((prev) => ({
      healthScore: update.healthScore,
      metrics: update.metrics,
      history: update.history,
      recentContributions: update.recentContributions,
      artifact: update.artifact,
      connected: true,
      error: null,
      // Mock stream doesn't produce LLM deltas — preserve prior values.
      llmDeltas: prev.llmDeltas,
      llmRationales: prev.llmRationales,
      a2aEvents: prev.a2aEvents,
    }));
  }, []);

  useEffect(() => {
    if (isTestMode()) {
      import("@/lib/mockStream").then(({ createMockStream }) => {
        unsubRef.current = createMockStream(quorumId, handleUpdate);
      });
      return () => {
        unsubRef.current?.();
        unsubRef.current = null;
      };
    }

    // Production: Supabase realtime subscription
    let cancelled = false;

    async function subscribe() {
      try {
        const { supabase } = await import("@/lib/supabase");

        // Fetch initial state
        const { data: quorum } = await supabase
          .from("quorums")
          .select("*")
          .eq("id", quorumId)
          .single();

        const { data: contributions } = await supabase
          .from("contributions")
          .select("*")
          .eq("quorum_id", quorumId)
          .order("created_at", { ascending: true });

        if (cancelled) return;

        // Subscribe to realtime changes
        const channel = supabase
          .channel(`quorum-live-${quorumId}`)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "contributions", filter: `quorum_id=eq.${quorumId}` },
            (payload) => {
              if (cancelled) return;
              if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
                // Both events carry the row — UPDATE is used by the
                // contribution analyzer to backfill analysis_tags / deltas
                // / rationale moments after the initial INSERT.  We merge
                // on id so a single row never appears twice.
                setState((prev) => {
                  const row = payload.new as Record<string, unknown>;
                  const incoming = {
                    id: String(row.id),
                    role_id: String(row.role_id),
                    role_name: String(row.role_id), // Would need a join for real name
                    content: String(row.content ?? ""),
                    created_at: String(row.created_at ?? new Date().toISOString()),
                    analysis_tags: Array.isArray(row.analysis_tags)
                      ? (row.analysis_tags as string[])
                      : undefined,
                    analysis_deltas:
                      row.analysis_deltas && typeof row.analysis_deltas === "object"
                        ? (row.analysis_deltas as Record<string, number>)
                        : undefined,
                    analysis_rationale:
                      typeof row.analysis_rationale === "string"
                        ? (row.analysis_rationale as string)
                        : undefined,
                  };
                  const existingIdx = prev.recentContributions.findIndex(
                    (c) => c.id === incoming.id,
                  );
                  let next;
                  if (existingIdx >= 0) {
                    next = prev.recentContributions.slice();
                    next[existingIdx] = { ...next[existingIdx], ...incoming };
                  } else {
                    next = [...prev.recentContributions.slice(-19), incoming];
                  }
                  return { ...prev, recentContributions: next };
                });
              }
            },
          )
          .on(
            "postgres_changes",
            { event: "UPDATE", schema: "public", table: "quorums", filter: `id=eq.${quorumId}` },
            (payload) => {
              if (cancelled) return;
              const heatScore = payload.new.heat_score ?? 0;
              setState((prev) => {
                // The API now writes the full HealthMetrics dict to the new
                // `metrics` jsonb column alongside `heat_score`.  If present
                // we adopt it so the secondary lines on the Quorum Health
                // Chart update live; otherwise we fall back to the prior
                // metrics so existing rows without the column still work.
                const incomingMetrics: HealthMetrics = payload.new.metrics ?? prev.metrics;
                const snapshot: HealthSnapshot = {
                  timestamp: Date.now(),
                  score: heatScore,
                  metrics: incomingMetrics,
                };
                // LLM-driven deltas + rationales (added by 20260518000004).
                // Null/undefined → empty defaults so older rows still work.
                const incomingDeltas = _coerceDeltas(payload.new.llm_metric_deltas);
                const incomingRationales = _coerceRationales(payload.new.llm_metric_rationales);
                return {
                  ...prev,
                  metrics: incomingMetrics,
                  healthScore: heatScore,
                  history: [...prev.history.slice(-59), snapshot],
                  llmDeltas: incomingDeltas,
                  llmRationales: incomingRationales,
                };
              });
            },
          )
          .subscribe((status) => {
            if (!cancelled) {
              setState((prev) => ({ ...prev, connected: status === "SUBSCRIBED" }));
            }
          });

        // Set initial state from DB, seed history from contributions
        if (quorum && !cancelled) {
          const finalScore: number = quorum.heat_score ?? 0;
          const contribs = contributions ?? [];
          // Prefer the real `metrics` jsonb on the row — written by the API on
          // every /contribute and /ask and by the autonomy loop on each
          // auto-contribution.  Falls back to INITIAL_METRICS if the column
          // is empty (older rows from before the 20260518000003 migration).
          const rowMetrics: HealthMetrics =
            (quorum as Record<string, unknown>).metrics &&
            typeof (quorum as Record<string, unknown>).metrics === "object"
              ? ((quorum as Record<string, unknown>).metrics as HealthMetrics)
              : { ...INITIAL_METRICS };
          // Build history by interpolating scores across contribution timestamps.
          // For metrics on intermediate points, we don't have time-series history
          // in the DB so we use the current row metrics — secondary lines render
          // as a flat baseline until live UPDATE events arrive.
          const seedHistory: HealthSnapshot[] = contribs.map((c: Record<string, unknown>, i: number) => {
            const frac = (i + 1) / Math.max(contribs.length, 1);
            const score = Math.round(finalScore * frac * 10) / 10;
            return {
              timestamp: new Date(c.created_at as string).getTime(),
              score,
              metrics: rowMetrics,
            };
          });
          // Ensure the chart always has at least one data point on load —
          // otherwise Recharts renders an empty plot box even when heat_score
          // is non-zero.  This shows the current state immediately, with new
          // points appended via realtime UPDATEs as contributions/chats land.
          if (seedHistory.length === 0) {
            seedHistory.push({
              timestamp: Date.now(),
              score: finalScore,
              metrics: rowMetrics,
            });
          }
          const initialDeltas = _coerceDeltas(
            (quorum as Record<string, unknown>).llm_metric_deltas,
          );
          const initialRationales = _coerceRationales(
            (quorum as Record<string, unknown>).llm_metric_rationales,
          );
          setState((prev) => ({
            ...prev,
            healthScore: finalScore,
            metrics: rowMetrics,
            connected: true,
            // Don't clobber history if a realtime UPDATE has already appended
            // points before this initial-seed setState fires (race condition
            // observed when the channel subscribes faster than the initial
            // fetch completes).
            history: prev.history.length > seedHistory.length ? prev.history : seedHistory,
            recentContributions: contribs.slice(-20).map((c: Record<string, unknown>) => ({
              id: String(c.id),
              role_id: String(c.role_id),
              role_name: String(c.role_id),
              content: String(c.content ?? ""),
              created_at: String(c.created_at ?? ""),
              analysis_tags: Array.isArray(c.analysis_tags)
                ? (c.analysis_tags as string[])
                : undefined,
              analysis_deltas:
                c.analysis_deltas && typeof c.analysis_deltas === "object"
                  ? (c.analysis_deltas as Record<string, number>)
                  : undefined,
              analysis_rationale:
                typeof c.analysis_rationale === "string"
                  ? (c.analysis_rationale as string)
                  : undefined,
            })),
            llmDeltas: initialDeltas,
            llmRationales: initialRationales,
          }));
        }

        unsubRef.current = () => {
          supabase.removeChannel(channel);
        };
      } catch (err) {
        // Supabase not available — show disconnected state with error (no mock fallback)
        if (!cancelled) {
          console.error("[useQuorumLive] Supabase connection failed:", err);
          setState((prev) => ({ ...prev, connected: false, error: "Supabase unavailable" }));
        }
      }
    }

    subscribe();

    // A2A requests — fetch initial snapshot + subscribe to inserts/updates.
    // Runs alongside the main Supabase channel; safe in test mode (no-op via
    // dataProvider's isDemoMode guard).
    let a2aUnsub: (() => void) | null = null;
    getA2ARequests(quorumId)
      .then((rows) => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, a2aEvents: rows }));
      })
      .catch(() => {
        /* non-fatal — keep empty list */
      });
    a2aUnsub = subscribeToQuorumA2ARequests(quorumId, (req) => {
      if (cancelled) return;
      setState((prev) => ({
        ...prev,
        a2aEvents: mergeA2AEvent(prev.a2aEvents, req),
      }));
    });

    return () => {
      cancelled = true;
      unsubRef.current?.();
      unsubRef.current = null;
      a2aUnsub?.();
      a2aUnsub = null;
    };
  }, [quorumId, handleUpdate]);

  return state;
}
