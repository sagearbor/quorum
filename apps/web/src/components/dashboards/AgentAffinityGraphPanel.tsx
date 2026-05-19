"use client";

/**
 * AgentAffinityGraphPanel — wrapper exposing 3 view variants behind a toggle.
 *
 * Sophie wanted to A/B compare three independently-designed visualisations of
 * the same agent-network data on the live /display projection: Spring,
 * Heatmap, and River.  Each variant is a self-contained dashboard that takes
 * `{ quorumId }` and fetches its own data.  This wrapper renders a tiny pill
 * selector and the chosen variant.  Selection persists in localStorage so the
 * choice survives carousel rotations and page reloads.
 *
 * Building three components instead of one let three parallel agents work in
 * isolation and gave us A/B/C side-by-side ahead of the Duke expo.  Once a
 * winning variant is picked, the others can be deleted without touching the
 * carousel wiring — just point this wrapper at the survivor.
 */

import { useEffect, useState } from "react";
import { AgentAffinityGraphSpring } from "./AgentAffinityGraphSpring";
import { AgentAffinityGraphHeatmap } from "./AgentAffinityGraphHeatmap";
import { AgentAffinityGraphRiver } from "./AgentAffinityGraphRiver";

type AffinityView = "spring" | "heatmap" | "river";

interface AgentAffinityGraphPanelProps {
  quorumId: string;
  /** Default view when no localStorage preference exists. */
  defaultView?: AffinityView;
}

const STORAGE_KEY = "quorumAffinityView";

export function AgentAffinityGraphPanel({
  quorumId,
  defaultView = "spring",
}: AgentAffinityGraphPanelProps) {
  const [view, setView] = useState<AffinityView>(defaultView);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "spring" || stored === "heatmap" || stored === "river") {
        setView(stored);
      }
    } catch {
      // ignore
    }

    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY && (e.newValue === "spring" || e.newValue === "heatmap" || e.newValue === "river")) {
        setView(e.newValue);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function pick(next: AffinityView) {
    setView(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }

  return (
    <div className="w-full h-full flex flex-col">
      {/* View toggle pill */}
      <div className="flex items-center justify-end gap-1 mb-1.5 flex-shrink-0">
        {(["spring", "heatmap", "river"] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => pick(opt)}
            className={`text-[10px] uppercase tracking-widest px-2 py-0.5 rounded transition-colors ${
              view === opt
                ? "bg-white/15 text-white/90"
                : "text-white/40 hover:bg-white/5 hover:text-white/70"
            }`}
            aria-pressed={view === opt}
            title={`Show ${opt} view`}
          >
            {opt}
          </button>
        ))}
      </div>

      {/* Chosen variant */}
      <div className="flex-1 min-h-0">
        {view === "spring" && <AgentAffinityGraphSpring quorumId={quorumId} />}
        {view === "heatmap" && <AgentAffinityGraphHeatmap quorumId={quorumId} />}
        {view === "river" && <AgentAffinityGraphRiver quorumId={quorumId} />}
      </div>
    </div>
  );
}
