"use client";

import { useEffect, useRef, useState } from "react";

interface DashboardInfoProps {
  /** Plain-language explanation rendered inside the popover. Supports basic
   *  formatting via the `**bold**` convention — converted at render time. */
  blurb: string;
  /** Optional className for the wrapping span (positioning hooks). */
  className?: string;
}

/**
 * Tiny "(?)" info icon next to a chart title. Clicking opens a popover with
 * a short, expo-visitor-friendly explanation of the chart. Closes on
 * Escape, outside-click, or clicking the icon again. Tailwind only.
 */
export function DashboardInfo({ blurb, className = "" }: DashboardInfoProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }

    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  // Render `**bold**` segments as <strong>; everything else as text.
  const segments = blurb.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);

  return (
    <span ref={containerRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        aria-label="What is this?"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/25 text-[10px] font-semibold text-white/50 transition-colors hover:border-white/60 hover:text-white/90 focus:outline-none focus:ring-1 focus:ring-white/40"
      >
        ?
      </button>
      {open && (
        <div
          role="dialog"
          className="absolute right-0 top-6 z-50 w-72 rounded-md border border-white/10 bg-black/90 p-3 text-xs leading-relaxed text-white/80 shadow-xl backdrop-blur-md"
        >
          {segments.map((seg, i) => {
            if (seg.startsWith("**") && seg.endsWith("**")) {
              return (
                <strong key={i} className="font-semibold text-white">
                  {seg.slice(2, -2)}
                </strong>
              );
            }
            return <span key={i}>{seg}</span>;
          })}
        </div>
      )}
    </span>
  );
}
