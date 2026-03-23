"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { QuorumHealthChart } from "@/components/dashboards/QuorumHealthChart";
import { AvatarPanel } from "@/components/avatar/AvatarPanel";
import { useQuorumLive, type QuorumLiveState } from "@/hooks/useQuorumLive";

export type CarouselMode = "multi-view" | "multi-quorum";

interface DashboardCarouselProps {
  eventSlug: string;
  quorumIds: string[];
  mode?: CarouselMode;
  intervalMs?: number;
}

type PanelType = "health" | "facilitator";

interface PanelConfig {
  key: string;
  quorumId: string;
  label: string;
  type: PanelType;
}

const slideVariants = {
  enter: { x: "-100%", opacity: 0 },
  center: { x: 0, opacity: 1 },
  exit: { x: "100%", opacity: 0 },
};

const slideTransition = {
  x: { type: "spring" as const, stiffness: 200, damping: 30 },
  opacity: { duration: 0.3 },
};

const INTERVAL_OPTIONS = [15_000, 25_000, 45_000, 60_000];
const INTERVAL_LABELS = ["15s", "25s", "45s", "60s"];

/**
 * Pre-fetches and caches live state for all quorums.
 * This runs continuously so cards render instantly when carousel cycles.
 */
function useAllQuorumStates(quorumIds: string[]): Record<string, QuorumLiveState> {
  const [states, setStates] = useState<Record<string, QuorumLiveState>>({});

  // Mount a hook per quorum — React requires hooks at top level so we use
  // a child component pattern via a dedicated inner component instead.
  // Here we poll the REST API as a simpler alternative that works for N quorums.
  useEffect(() => {
    if (quorumIds.length === 0) return;
    let cancelled = false;

    async function fetchAll() {
      const results: Record<string, QuorumLiveState> = {};
      await Promise.all(
        quorumIds.map(async (qId) => {
          try {
            const res = await fetch(`/api/quorums/${qId}/state`);
            if (!res.ok) return;
            const data = await res.json();
            const contribs = data.contributions ?? [];
            const currentScore = data.quorum?.heat_score ?? 0;
            const n = Math.max(contribs.length, 1);
            const history = contribs.map((c: Record<string, unknown>, i: number) => {
              const pct = (i + 1) / n;
              return {
                timestamp: new Date(c.created_at as string).getTime(),
                score: Math.round(currentScore * pct),
                metrics: {
                  completion_pct: Math.round(100 * pct),
                  // Consensus builds slowly — only meaningful with multiple views
                  consensus_score: Math.round(30 + 20 * pct),
                  // Critical path stays high, drops if blockers appear
                  critical_path_score: 100,
                  role_coverage_pct: Math.round(100 * pct),
                  // Blockers starts high, represents freedom from blocking
                  blocker_score: 100,
                },
              };
            });
            if (currentScore > 0) {
              history.push({
                timestamp: Date.now(),
                score: currentScore,
                metrics: {
                  completion_pct: Math.round(100 * (contribs.length / n)),
                  consensus_score: Math.round(30 + 20 * (contribs.length / n)),
                  critical_path_score: 100,
                  role_coverage_pct: Math.round(100 * (contribs.length / n)),
                  blocker_score: 100,
                },
              });
            }
            results[qId] = {
              healthScore: currentScore,
              history,
              metrics: {
                completion_pct: contribs.length > 0 ? 100 : 0,
                consensus_score: 50,
                critical_path_score: 100,
                role_coverage_pct: contribs.length > 0 ? 100 : 0,
                blocker_score: 100,
              },
              recentContributions: contribs.slice(-10),
              connected: true,
            };
          } catch {
            // keep previous state if fetch fails
          }
        })
      );
      if (!cancelled) setStates((prev) => ({ ...prev, ...results }));
    }

    fetchAll();
    const interval = setInterval(fetchAll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [quorumIds]);

  return states;
}

export function DashboardCarousel({
  eventSlug,
  quorumIds,
  mode: modeProp,
  intervalMs: initialIntervalMs = 25_000,
}: DashboardCarouselProps) {
  const mode: CarouselMode = modeProp ?? (quorumIds.length >= 3 ? "multi-quorum" : "multi-view");
  const [slideIndex, setSlideIndex] = useState(0);
  const [intervalMs, setIntervalMs] = useState(initialIntervalMs);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Pre-fetch all quorum states — cards use this cache for instant render
  const cachedStates = useAllQuorumStates(quorumIds);

  const panelPairs = usePanelPairs(mode, quorumIds);
  const totalSlides = panelPairs.length;

  const advance = useCallback(() => {
    setSlideIndex((prev) => (prev + 1) % Math.max(totalSlides, 1));
  }, [totalSlides]);

  useEffect(() => {
    if (totalSlides <= 1) return;
    timerRef.current = setInterval(advance, intervalMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [advance, intervalMs, totalSlides]);

  const currentPair = panelPairs[slideIndex % Math.max(panelPairs.length, 1)] ?? [];

  return (
    <div className="w-full h-full flex flex-col">
      {/* Header row */}
      <div className="flex items-center justify-between px-6 py-2">
        <span className="text-xs text-white/30 uppercase tracking-widest">
          {mode === "multi-view" ? "Multi-View" : "Multi-Quorum"} — {eventSlug}
        </span>
        <div className="flex items-center gap-4">
          {/* Interval toggle */}
          <div className="flex items-center gap-1.5 text-xs text-white/30">
            <span>Cycle:</span>
            {INTERVAL_OPTIONS.map((ms, i) => (
              <button
                key={ms}
                onClick={() => setIntervalMs(ms)}
                className={`px-2 py-0.5 rounded transition-colors ${
                  intervalMs === ms ? "bg-white/20 text-white/80" : "hover:bg-white/10"
                }`}
              >
                {INTERVAL_LABELS[i]}
              </button>
            ))}
          </div>
          {/* Slide dots */}
          {totalSlides > 1 && (
            <div className="flex gap-1.5">
              {panelPairs.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setSlideIndex(i)}
                  className={`w-1.5 h-1.5 rounded-full transition-colors duration-300 ${
                    i === slideIndex % totalSlides ? "bg-white/80" : "bg-white/20 hover:bg-white/40"
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Dual-panel area */}
      <div className="flex-1 min-h-0 px-6 pb-4">
        <AnimatePresence mode="wait">
          <motion.div
            key={slideIndex}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={slideTransition}
            className="grid grid-cols-2 gap-6 h-full"
          >
            {currentPair.map((panel) => (
              <div
                key={panel.key}
                className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 flex flex-col overflow-hidden"
              >
                <div className="text-xs text-white/40 mb-2 truncate">{panel.label}</div>
                <div className="flex-1 min-h-0">
                  {panel.type === "facilitator" ? (
                    <AvatarPanel quorumId={panel.quorumId} showDirectionIndicator={false} />
                  ) : (
                    <QuorumHealthChart
                      quorumId={panel.quorumId}
                      cachedState={cachedStates[panel.quorumId]}
                    />
                  )}
                </div>
              </div>
            ))}
            {currentPair.length === 1 && (
              <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl flex items-center justify-center text-white/20 text-sm">
                Awaiting next quorum…
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function usePanelPairs(mode: CarouselMode, quorumIds: string[]): PanelConfig[][] {
  if (quorumIds.length === 0) return [];

  if (mode === "multi-view") {
    const qId = quorumIds[0];
    return [
      [
        { key: `${qId}-health-1`, quorumId: qId, label: "Health Overview", type: "health" },
        { key: `${qId}-health-2`, quorumId: qId, label: "Role Activity", type: "health" },
      ],
      [
        { key: "avatar", quorumId: qId, label: "Facilitator", type: "facilitator" },
        { key: `${qId}-health-3`, quorumId: qId, label: "Health Overview", type: "health" },
      ],
    ];
  }

  const pairs: PanelConfig[][] = [];
  pairs.push([
    { key: "facilitator-main", quorumId: quorumIds[0], label: "Facilitator", type: "facilitator" },
    { key: `q-${quorumIds[0]}-health`, quorumId: quorumIds[0], label: "Quorum 1", type: "health" },
  ]);
  for (let i = 0; i < quorumIds.length; i += 2) {
    const pair: PanelConfig[] = [
      { key: `q-${quorumIds[i]}`, quorumId: quorumIds[i], label: `Quorum ${i + 1}`, type: "health" },
    ];
    if (i + 1 < quorumIds.length) {
      pair.push({
        key: `q-${quorumIds[i + 1]}`,
        quorumId: quorumIds[i + 1],
        label: `Quorum ${i + 2}`,
        type: "health",
      });
    }
    pairs.push(pair);
  }
  return pairs;
}
