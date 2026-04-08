"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { QuorumHealthChart } from "@/components/dashboards/QuorumHealthChart";
import { AvatarPanel } from "@/components/avatar/AvatarPanel";

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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Build panel pairs based on mode
  const panelPairs = usePanelPairs(mode, quorumIds);
  const totalSlides = panelPairs.length;

  const advance = useCallback(() => {
    setSlideIndex((prev) => (prev + 1) % Math.max(totalSlides, 1));
  }, [totalSlides]);

  // Auto-advance timer
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
      {/* Mode indicator */}
      <div className="flex items-center justify-between px-6 py-2">
        <div className="flex items-center gap-3">
          {INTERVAL_OPTIONS.map((ms, i) => (
            <button key={ms} onClick={() => setActiveInterval(ms)}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${activeInterval === ms ? "bg-white/20 text-white/70" : "text-white/30 hover:bg-white/10"}`}>
              {INTERVAL_LABELS[i]}
            </button>
          ))}
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

      {/* Dual-panel area */}
      <div className="flex-1 min-h-0 px-6 pb-4">
        <AnimatePresence mode="popLayout">
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
                    <AvatarPanel quorumId={panel.quorumId} showDirectionIndicator={false} enableEmotionTracking={false} />
                  ) : (
                    <QuorumHealthChart quorumId={panel.quorumId} />
                  )}
                </div>
              </div>
            ))}
            {/* If only one panel in pair, fill second slot */}
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
      // Health Overview (dual health)
      [
        { key: `${qId}-health-1`, quorumId: qId, label: "Health Overview", type: "health" },
        { key: `${qId}-health-2`, quorumId: qId, label: "Role Activity", type: "health" },
      ],
      // Avatar Facilitator + Health
      [
        { key: "avatar", quorumId: qId, label: "Facilitator", type: "facilitator" },
        { key: `${qId}-health-3`, quorumId: qId, label: "Health Overview", type: "health" },
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
