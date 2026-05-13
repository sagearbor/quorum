/**
 * ObservationStrip — ambient sidebar that surfaces the facilitator agent's
 * meta-observations (`facilitator_observation` WS frames).
 *
 * Designed to sit BELOW the avatar (or anywhere ambient in the layout).
 * The avatar already speaks the per-turn narration (PR #14 / 11.3); this
 * strip is the higher-level meta-narration from the FacilitatorAgent
 * (9.4) — fires every Nth round and stays understated so the audience
 * already-watching-the-avatar isn't pulled away by it.
 *
 * Visual design:
 *   - One row, single line of text.
 *   - Severity drives a left-edge accent stripe + subtle background.
 *   - Soft fade-in when a new observation arrives (200ms).
 *   - No close button — the next observation replaces the current one.
 *
 * The component is purely presentational + subscribes via the
 * dataProvider channel. Hidden until the first observation lands (so it
 * doesn't take up vertical space on a fresh quorum).
 */

"use client";

import { useEffect, useState } from "react";
import {
  subscribeToFacilitatorObservations,
  type FacilitatorObservation,
  type FacilitatorObservationSeverity,
} from "@/lib/dataProvider";

interface ObservationStripProps {
  quorumId: string;
  /** Test-only: render a static observation instead of subscribing. */
  staticObservation?: FacilitatorObservation | null;
}

// Severity → Tailwind classes. Kept inline (not a lookup) so Tailwind's
// JIT picks the class names up at build time.
function severityStyles(severity: FacilitatorObservationSeverity): {
  accent: string;
  bg: string;
  label: string;
  labelText: string;
} {
  switch (severity) {
    case "action_needed":
      return {
        accent: "bg-amber-400",
        bg: "bg-amber-500/10",
        label: "Action",
        labelText: "text-amber-300",
      };
    case "notable":
      return {
        accent: "bg-sky-400",
        bg: "bg-sky-500/10",
        label: "Notable",
        labelText: "text-sky-300",
      };
    case "info":
    default:
      return {
        accent: "bg-zinc-500",
        bg: "bg-zinc-700/10",
        label: "Note",
        labelText: "text-zinc-400",
      };
  }
}

export function ObservationStrip({
  quorumId,
  staticObservation = null,
}: ObservationStripProps) {
  // Track WS-delivered observations separately from the prop so a parent
  // rerender with a new ``staticObservation`` always wins (predictable
  // behaviour for tests and Storybook).
  const [liveObservation, setLiveObservation] =
    useState<FacilitatorObservation | null>(null);

  useEffect(() => {
    if (!quorumId || staticObservation !== null) return;
    const unsubscribe = subscribeToFacilitatorObservations(quorumId, (frame) => {
      setLiveObservation(frame);
    });
    return unsubscribe;
  }, [quorumId, staticObservation]);

  const observation = staticObservation ?? liveObservation;

  // Hidden until the first observation arrives. Prevents an empty strip
  // taking up vertical space on a brand-new quorum.
  if (!observation || !observation.summary) {
    return null;
  }

  const styles = severityStyles(observation.severity);

  return (
    <div
      data-testid="observation-strip"
      data-severity={observation.severity}
      className={`w-full flex items-stretch overflow-hidden rounded-lg
                  border border-white/5 transition-opacity duration-200
                  ${styles.bg}`}
      role="status"
      aria-live="polite"
    >
      {/* Severity accent stripe */}
      <div className={`w-1 ${styles.accent}`} aria-hidden="true" />

      <div className="flex-1 flex items-center gap-3 px-3 py-2">
        <span
          className={`text-[10px] uppercase tracking-wider font-medium
                      ${styles.labelText}`}
          aria-label={`Severity: ${observation.severity}`}
        >
          {styles.label}
        </span>
        <p className="text-sm text-zinc-100 leading-snug flex-1 min-w-0 truncate">
          {observation.summary}
        </p>
      </div>
    </div>
  );
}
