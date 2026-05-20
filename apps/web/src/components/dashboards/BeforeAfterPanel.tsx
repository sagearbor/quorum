"use client";

/**
 * BeforeAfterPanel — toggleable wrapper around the 3 before/after views:
 *
 *   Headline · Radar · Table
 *
 * Same underlying data source (the /quorums/{id}/before-after endpoint
 * shipped in PR #66).  Each view emphasizes a different facet of the
 * evolution:
 *   - Headline rewrite: the *framing* shift, screenshot-friendly.
 *   - Ghost-trail radar: the *shape* of agreement, glanceable at distance.
 *   - Moved-rows table:  the *attribution*, with driver pills per change.
 *
 * Selection persists in localStorage so the demo presenter can leave it
 * on their preferred view between page loads.
 */

import { useEffect, useState } from "react";
import { HeadlineRewrite } from "./HeadlineRewrite";
import { GhostRadar } from "./GhostRadar";
import { MovedRowsTable } from "./MovedRowsTable";

type ViewKey = "headline" | "radar" | "table";

const STORAGE_KEY = "quorumBeforeAfterView";

const VIEW_OPTIONS: ReadonlyArray<{ key: ViewKey; label: string; hint: string }> = [
  { key: "headline", label: "Headline", hint: "Newspaper-style framing diff" },
  { key: "radar", label: "Radar", hint: "Initial-state ghost behind current polygon" },
  { key: "table", label: "Table", hint: "Moved rows with driver attribution" },
];

function readInitialView(): ViewKey {
  if (typeof window === "undefined") return "headline";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "headline" || v === "radar" || v === "table") return v;
  } catch {
    // ignore
  }
  return "headline";
}

export interface BeforeAfterPanelProps {
  quorumId: string;
}

export function BeforeAfterPanel({ quorumId }: BeforeAfterPanelProps) {
  const [view, setView] = useState<ViewKey>(readInitialView);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, view);
    } catch {
      // ignore
    }
  }, [view]);

  return (
    <div className="flex flex-col h-full bg-black text-white">
      {/* Toggle bar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-white/10 flex-shrink-0">
        <span className="text-[10px] uppercase tracking-widest text-white/40 mr-2">
          View
        </span>
        {VIEW_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => setView(opt.key)}
            title={opt.hint}
            aria-pressed={view === opt.key}
            className={`text-xs px-2.5 py-1 rounded transition-colors ${
              view === opt.key
                ? "bg-white/15 text-white"
                : "text-white/50 hover:bg-white/5 hover:text-white/80"
            }`}
          >
            {opt.label}
          </button>
        ))}
        <span className="ml-auto text-[10px] uppercase tracking-widest text-white/30">
          {VIEW_OPTIONS.find((o) => o.key === view)?.hint}
        </span>
      </div>

      {/* Active view */}
      <div className="flex-1 min-h-0 overflow-auto">
        {view === "headline" && <HeadlineRewrite quorumId={quorumId} />}
        {view === "radar" && <GhostRadar quorumId={quorumId} />}
        {view === "table" && <MovedRowsTable quorumId={quorumId} />}
      </div>
    </div>
  );
}
