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

  // Render inline `**bold**` segments as <strong>; plain text otherwise.
  function renderInline(text: string, lineKey: number) {
    const segments = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    return segments.map((seg, i) => {
      if (seg.startsWith("**") && seg.endsWith("**")) {
        return (
          <strong key={`${lineKey}-${i}`} className="font-semibold text-white">
            {seg.slice(2, -2)}
          </strong>
        );
      }
      return <span key={`${lineKey}-${i}`}>{seg}</span>;
    });
  }

  // Split blurb into lines.  Lines that start with "- " become bullets;
  // everything else renders as a paragraph.  Adjacent bullets are grouped
  // into a single <ul> so spacing looks right.
  const lines = blurb.split(/\n/);
  const blocks: Array<
    | { type: "p"; text: string }
    | { type: "ul"; items: string[] }
  > = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith("- ")) {
      const item = line.slice(2);
      const last = blocks[blocks.length - 1];
      if (last && last.type === "ul") {
        last.items.push(item);
      } else {
        blocks.push({ type: "ul", items: [item] });
      }
    } else {
      blocks.push({ type: "p", text: line });
    }
  }

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
          className="absolute right-0 top-6 z-50 w-[min(28rem,calc(100vw-2rem))] max-h-[70vh] overflow-auto rounded-md border border-white/10 bg-black/95 p-4 text-sm leading-relaxed text-white/85 shadow-xl backdrop-blur-md"
        >
          {blocks.map((block, bi) => {
            if (block.type === "p") {
              return (
                <p key={bi} className={bi > 0 ? "mt-2" : ""}>
                  {renderInline(block.text, bi)}
                </p>
              );
            }
            return (
              <ul key={bi} className="mt-2 space-y-1 list-disc pl-4 marker:text-white/40">
                {block.items.map((item, ii) => (
                  <li key={ii}>{renderInline(item, bi * 100 + ii)}</li>
                ))}
              </ul>
            );
          })}
        </div>
      )}
    </span>
  );
}
