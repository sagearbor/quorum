"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { QuorumHealthChart } from "@/components/dashboards/QuorumHealthChart";
import { AgentDocumentDashboard } from "@/components/dashboards/AgentDocumentDashboard";
import { AgentAffinityGraphPanel } from "@/components/dashboards/AgentAffinityGraphPanel";
import { RoleCoverageMap } from "@/components/dashboards/RoleCoverageMap";
import { ContributionTimeline } from "@/components/dashboards/ContributionTimeline";
import { ConflictTopologyMap } from "@/components/dashboards/ConflictTopologyMap";
import { DecisionWaterfall } from "@/components/dashboards/DecisionWaterfall";
import { AvatarPanel } from "@/components/avatar/AvatarPanel";
import { useShowAvatars } from "@/hooks/useShowAvatars";

export type CarouselMode = "multi-view" | "multi-quorum";

interface DashboardCarouselProps {
  eventSlug: string;
  quorumIds: string[];
  mode?: CarouselMode;
  intervalMs?: number;
}

type PanelType =
  | "health"
  | "facilitator"
  | "documents"
  | "affinity"
  | "role_coverage"
  | "timeline"
  | "conflict_topology"
  | "decision_waterfall";

interface PanelConfig {
  key: string;
  quorumId: string;
  label: string;
  type: PanelType;
}

const INTERVAL_OPTIONS = [15_000, 25_000, 45_000, 60_000];
const INTERVAL_LABELS = ["15s", "25s", "45s", "60s"];

export function DashboardCarousel({
  eventSlug,
  quorumIds,
  mode: modeProp,
  intervalMs = 25_000,
}: DashboardCarouselProps) {
  // Auto-detect mode: 1 quorum → multi-view, 3+ → multi-quorum
  const mode: CarouselMode = modeProp ?? (quorumIds.length >= 3 ? "multi-quorum" : "multi-view");

  const [slideIndex, setSlideIndex] = useState(0);
  const [activeInterval, setActiveInterval] = useState(intervalMs);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { showAvatars } = useShowAvatars();

  // Build panel pairs based on mode, then filter out facilitator-only slides
  // when the global avatar toggle is off so the carousel doesn't show empty
  // boxes where the avatar used to live.
  const rawPanelPairs = usePanelPairs(mode, quorumIds);
  const panelPairs = showAvatars
    ? rawPanelPairs
    : rawPanelPairs.filter((pair) => !pair.every((p) => p.type === "facilitator"))
        .map((pair) => pair.filter((p) => p.type !== "facilitator"))
        .filter((pair) => pair.length > 0);
  const totalSlides = panelPairs.length;

  const advance = useCallback(() => {
    setSlideIndex((prev) => (prev + 1) % Math.max(totalSlides, 1));
  }, [totalSlides]);

  const retreat = useCallback(() => {
    setSlideIndex((prev) => (prev - 1 + Math.max(totalSlides, 1)) % Math.max(totalSlides, 1));
  }, [totalSlides]);

  // Auto-advance timer — uses activeInterval so the pill selector takes effect.
  useEffect(() => {
    if (totalSlides <= 1) return;
    if (paused) return;
    timerRef.current = setInterval(advance, activeInterval);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [advance, activeInterval, totalSlides, paused]);

  // Keyboard controls — Space toggles paused, Arrow keys navigate.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (e.key === "ArrowLeft") {
        retreat();
      } else if (e.key === "ArrowRight") {
        advance();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, retreat]);

  return (
    <div className="w-full h-full flex flex-col">
      {/* Mode indicator */}
      <div className="flex items-center justify-between px-6 py-2">
        <div className="flex items-center gap-3">
          {INTERVAL_OPTIONS.map((ms, i) => (
            <button key={ms} onClick={() => setActiveInterval(ms)}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${activeInterval === ms ? "bg-white/20 text-white/70" : "text-white/30 hover:bg-white/10"}`}>
              {INTERVAL_LABELS[i]}
            </button>
          ))}
          <span className="mx-1 h-3 w-px bg-white/10" />
          <button
            type="button"
            onClick={retreat}
            disabled={totalSlides <= 1}
            aria-label="Previous slide"
            className="text-xs px-2 py-0.5 rounded text-white/30 hover:bg-white/10 hover:text-white/70 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-white/30"
          >
            ◀
          </button>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused ? "Play" : "Pause"}
            aria-pressed={paused}
            className={`text-xs px-2 py-0.5 rounded transition-colors ${paused ? "bg-white/20 text-white/70" : "text-white/30 hover:bg-white/10 hover:text-white/70"}`}
          >
            {paused ? "▶︎" : "❚❚"}
          </button>
          <button
            type="button"
            onClick={advance}
            disabled={totalSlides <= 1}
            aria-label="Next slide"
            className="text-xs px-2 py-0.5 rounded text-white/30 hover:bg-white/10 hover:text-white/70 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-white/30"
          >
            ▶
          </button>
        </div>
        <span className="text-xs text-white/30 uppercase tracking-widest">
          {mode === "multi-view" ? "Multi-View" : "Multi-Quorum"} — {eventSlug}
        </span>
        {totalSlides > 1 && (
          <div className="flex gap-1.5">
            {panelPairs.map((_, i) => (
              <div
                key={i}
                className={`w-1.5 h-1.5 rounded-full transition-colors duration-300 ${
                  i === slideIndex % totalSlides ? "bg-white/80" : "bg-white/20"
                }`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Dual-panel area — every pair stays mounted so panel data hooks don't
          re-fetch on rotation.  Only opacity (and a tiny x-offset for motion
          feel) changes between active/inactive.  Eliminates the "loading…"
          flash on every carousel tick. */}
      <div className="flex-1 min-h-0 px-6 pb-4 relative">
        {panelPairs.map((pair, idx) => {
          const isActive = idx === slideIndex % Math.max(panelPairs.length, 1);
          return (
            <motion.div
              key={`pair-${idx}`}
              initial={false}
              animate={{
                opacity: isActive ? 1 : 0,
                x: isActive ? 0 : 20,
              }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className={`grid grid-cols-2 gap-6 absolute inset-0 px-6 pb-4 ${isActive ? "z-10" : "z-0 pointer-events-none"}`}
              aria-hidden={!isActive}
            >
              {pair.map((panel) => (
                <div
                  key={panel.key}
                  className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 flex flex-col overflow-hidden"
                >
                  <div className="text-xs text-white/40 mb-2 truncate">{panel.label}</div>
                  <div className="flex-1 min-h-0">
                    {panel.type === "facilitator" ? (
                      <AvatarPanel quorumId={panel.quorumId} showDirectionIndicator={false} enableEmotionTracking={false} />
                    ) : panel.type === "documents" ? (
                      <AgentDocumentDashboard quorumId={panel.quorumId} />
                    ) : panel.type === "affinity" ? (
                      <AgentAffinityGraphPanel quorumId={panel.quorumId} />
                    ) : panel.type === "role_coverage" ? (
                      <RoleCoverageMap quorumId={panel.quorumId} />
                    ) : panel.type === "timeline" ? (
                      <ContributionTimeline quorumId={panel.quorumId} />
                    ) : panel.type === "conflict_topology" ? (
                      <ConflictTopologyMap quorumId={panel.quorumId} />
                    ) : panel.type === "decision_waterfall" ? (
                      <DecisionWaterfall quorumId={panel.quorumId} />
                    ) : (
                      <QuorumHealthChart quorumId={panel.quorumId} />
                    )}
                  </div>
                </div>
              ))}
              {/* If only one panel in pair, fill second slot */}
              {pair.length === 1 && (
                <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl flex items-center justify-center text-white/20 text-sm">
                  Awaiting next quorum…
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function usePanelPairs(mode: CarouselMode, quorumIds: string[]): PanelConfig[][] {
  if (quorumIds.length === 0) return [];

  if (mode === "multi-view") {
    const qId = quorumIds[0];
    return [
      // Slide 1 — Health × Facilitator (headline view)
      [
        { key: `${qId}-health-1`, quorumId: qId, label: "Quorum Health", type: "health" },
        { key: "avatar", quorumId: qId, label: "AI Facilitator", type: "facilitator" },
      ],
      // Slide 2 — Affinity × Conflict Map (who works together vs. who clashes)
      [
        { key: `${qId}-affinity`, quorumId: qId, label: "Agent Affinity", type: "affinity" },
        { key: `${qId}-conflict`, quorumId: qId, label: "Conflict Map", type: "conflict_topology" },
      ],
      // Slide 3 — Role Coverage × Decision Waterfall (who's covered, where decisions cascade)
      [
        { key: `${qId}-coverage`, quorumId: qId, label: "Role Coverage", type: "role_coverage" },
        { key: `${qId}-waterfall`, quorumId: qId, label: "Decision Waterfall", type: "decision_waterfall" },
      ],
      // Slide 4 — Timeline × Health (chronological + composite recap)
      [
        { key: `${qId}-timeline`, quorumId: qId, label: "Contribution Timeline", type: "timeline" },
        { key: `${qId}-health-2`, quorumId: qId, label: "Quorum Health", type: "health" },
      ],
      // Slide 5 — Documents × Affinity (evidence base + agent topology)
      [
        { key: `${qId}-documents`, quorumId: qId, label: "Reference Documents", type: "documents" },
        { key: `${qId}-affinity-2`, quorumId: qId, label: "Agent Affinity", type: "affinity" },
      ],
    ];
  }

  // Multi-quorum: pair quorums side by side as health charts
  const pairs: PanelConfig[][] = [];

  // All slides = health charts, two per slide
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
