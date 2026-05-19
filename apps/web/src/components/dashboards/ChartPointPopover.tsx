"use client";

import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { StreamContribution } from "@quorum/types";

interface ChartPointPopoverProps {
  /** Viewport-space anchor: where the user clicked the data point. */
  anchor: { x: number; y: number };
  /** Timestamp of the clicked data point (ms epoch). */
  timestamp: number;
  /** Up to N contributions that landed within ±windowMs of the timestamp. */
  contributions: StreamContribution[];
  /** Called when the user dismisses the popover (Esc, outside-click, close). */
  onClose: () => void;
}

const DELTA_LABEL: Record<string, string> = {
  consensus: "consensus",
  completion: "completion",
  critical_path: "critical path",
  blockers: "blockers",
  role_coverage: "role coverage",
};

function formatDelta(metric: string, value: number): string {
  const label = DELTA_LABEL[metric] ?? metric;
  const sign = value > 0 ? "+" : value < 0 ? "" : "+";
  return `${label} ${sign}${Math.round(value * 10) / 10}`;
}

function truncate(s: string, max = 120): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function formatTimestamp(ts: number): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return String(ts);
  }
}

/**
 * Clickable popover anchored to a chart data point.  Shows up to 3
 * contributions that landed near the clicked timestamp, with tags + rationale
 * + per-metric delta strip.  Portaled to document.body so it escapes any
 * overflow:hidden ancestor and is clamped to the viewport.  Dismissable on
 * Escape, outside-click, or the close button.
 */
export function ChartPointPopover({
  anchor,
  timestamp,
  contributions,
  onClose,
}: ChartPointPopoverProps) {
  const [mounted, setMounted] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Position once on open + reposition on resize/scroll.
  useLayoutEffect(() => {
    function reposition() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Preferred width ~ 360px, clamped to viewport - 16px margin.
      const width = Math.min(360, vw - 16);
      // Place below the anchor by default; if it would spill off the bottom,
      // flip above.  Estimate height generously so we flip early when near
      // the bottom edge.
      const estimatedHeight = 280;
      let top = anchor.y + 12;
      if (top + estimatedHeight > vh - 8) {
        top = Math.max(8, anchor.y - estimatedHeight - 12);
      }
      // Center horizontally on the anchor, clamped to viewport.
      let left = anchor.x - width / 2;
      if (left < 8) left = 8;
      if (left + width > vw - 8) left = Math.max(8, vw - 8 - width);
      setRect({ top, left, width });
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchor.x, anchor.y]);

  // Dismiss on Escape + outside-click.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Element | null;
      // Walk up looking for our popover container.
      const inside = target?.closest?.("[data-chart-popover]");
      if (!inside) onClose();
    }
    window.addEventListener("keydown", onKey);
    // Defer the mousedown listener by one frame so the click that opened the
    // popover doesn't immediately close it.
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", onMouseDown);
    }, 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  if (!mounted || !rect) return null;

  const visibleContribs = contributions.slice(0, 3);

  const node: ReactNode = (
    <div
      data-chart-popover
      role="dialog"
      style={{
        position: "fixed",
        top: rect.top,
        left: rect.left,
        width: rect.width,
        zIndex: 1000,
      }}
      className="max-h-[70vh] overflow-auto rounded-md border border-white/10 bg-black/95 p-3 text-xs leading-relaxed text-white/85 shadow-xl backdrop-blur-md"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-white/90">
          {formatTimestamp(timestamp)}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded-full border border-white/15 px-1.5 py-0 text-[10px] text-white/60 hover:bg-white/10"
        >
          ×
        </button>
      </div>

      {visibleContribs.length === 0 ? (
        <div className="text-white/50 italic">
          No contributions within ±5s of this point.
        </div>
      ) : (
        <ul className="space-y-2.5 list-none p-0 m-0">
          {visibleContribs.map((c) => {
            const tags = c.analysis_tags ?? [];
            const deltas = c.analysis_deltas ?? {};
            const deltaEntries = Object.entries(deltas).filter(
              ([, v]) => typeof v === "number" && v !== 0,
            );
            return (
              <li key={c.id} className="border-l-2 border-white/10 pl-2">
                <div className="text-white/60 text-[10px] uppercase tracking-wide">
                  {c.role_name}
                </div>
                <div className="text-white/90 mt-0.5">{truncate(c.content, 120)}</div>
                {tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {tags.slice(0, 6).map((t) => (
                      <span
                        key={t}
                        className="inline-block rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-white/70"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {c.analysis_rationale && (
                  <div className="mt-1 text-white/55 italic">
                    {c.analysis_rationale}
                  </div>
                )}
                {deltaEntries.length > 0 && (
                  <div className="mt-1 text-[10px] text-white/55">
                    {deltaEntries
                      .map(([m, v]) => formatDelta(m, v as number))
                      .join(" · ")}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return createPortal(node, document.body);
}
