"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import type { HealthMetrics } from "@quorum/types";
import { createMockStream, type HealthSnapshot, type MockContribution, type MockStreamState } from "@/lib/mockStream";

export interface QuorumLiveState {
  healthScore: number;
  metrics: HealthMetrics;
  history: HealthSnapshot[];
  recentContributions: MockContribution[];
  artifact: { status: "draft" | "pending_ratification" | "final"; version: number } | null;
  connected: boolean;
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
};

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

  const handleUpdate = useCallback((update: MockStreamState) => {
    setState({
      healthScore: update.healthScore,
      metrics: update.metrics,
      history: update.history,
      recentContributions: update.recentContributions,
      artifact: update.artifact,
      connected: true,
    });
  }, []);

  useEffect(() => {
    if (isTestMode()) {
      unsubRef.current = createMockStream(quorumId, handleUpdate);
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
              if (payload.eventType === "INSERT") {
                setState((prev) => ({
                  ...prev,
                  recentContributions: [
                    ...prev.recentContributions.slice(-19),
                    {
                      id: payload.new.id,
                      role_id: payload.new.role_id,
                      role_name: payload.new.role_id, // Would need a join for real name
                      content: payload.new.content,
                      created_at: payload.new.created_at,
                    },
                  ],
                }));
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
                const snapshot: HealthSnapshot = {
                  timestamp: Date.now(),
                  score: heatScore,
                  metrics: prev.metrics,
                };
                return {
                  ...prev,
                  healthScore: heatScore,
                  history: [...prev.history.slice(-59), snapshot],
                };
              });
            },
          )
          .subscribe((status) => {
            if (!cancelled) {
              setState((prev) => ({ ...prev, connected: status === "SUBSCRIBED" }));
            }
          });

        // Set initial state from DB
        if (quorum && !cancelled) {
          setState((prev) => ({
            ...prev,
            healthScore: quorum.heat_score ?? 0,
            connected: true,
            recentContributions: (contributions ?? []).slice(-20).map((c: Record<string, string>) => ({
              id: c.id,
              role_id: c.role_id,
              role_name: c.role_id,
              content: c.content,
              created_at: c.created_at,
            })),
          }));
        }

        unsubRef.current = () => {
          supabase.removeChannel(channel);
        };
      } catch {
        // Supabase not available — show disconnected state (no mock fallback)
        if (!cancelled) {
          setState((prev) => ({ ...prev, connected: false }));
        }
      }
    }

    subscribe();

    return () => {
      cancelled = true;
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [quorumId, handleUpdate]);

  return state;
}
