"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  ResponsiveContainer,
} from "recharts";
import { useReducedMotion } from "framer-motion";
import { useQuorumLive } from "@/hooks/useQuorumLive";
import { DashboardInfo } from "./DashboardInfo";
import type { HealthSnapshot } from "@quorum/types";

/* ────────────────────────────────────────────────────────────────────────── *
 * GhostRadar — translucent "initial" polygon behind the live polygon.
 *
 * One of three before/after dashboard variants being built in parallel ahead
 * of Sophie's expo. Self-contained: does NOT modify QuorumHealthChart, the
 * dashboards index, the carousel, or the selector. Wiring up the toggle to
 * pick between variants happens later.
 *
 * Visual:
 *   - Ghost polygon: translucent grey, drawn from history[0] (first snapshot)
 *   - Current polygon: full-color, modulated by liveSignalsOn (LLM deltas)
 *   - Delta pills: per-axis (current − initial), green for + / red for −
 *   - Optional scrub slider: reconstructs intermediate values from history
 * ────────────────────────────────────────────────────────────────────────── */

const GHOST_RADAR_BLURB = `**Ghost-Trail Radar.** Translucent grey polygon = the quorum's initial state. Filled colored polygon = right now. The shape difference is the deliberation's impact at a glance. Delta pills below show per-axis change.
- **Ghost** is captured from the first snapshot at mount and never changes.
- **Current** is the live polygon — modulated by AI signals when Live Signals are ON.
- **Scrub** drag the slider to replay intermediate states; your position is sticky until you hit "Live" to return to now.
- **Play / Pause** animates through history. **Loop** rewinds to the start when it reaches the end.`;

const LIVE_SIGNALS_STORAGE_KEY = "quorumLiveSignals";

function readInitialLiveSignals(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(LIVE_SIGNALS_STORAGE_KEY);
    if (raw == null) return true;
    return raw === "on";
  } catch {
    return true;
  }
}

function clamp01_100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** Short delta keys emitted by the LLM `[scores: ...]` block keyed by metric. */
const DELTA_KEY_BY_METRIC: Record<
  "completion_pct" | "consensus_score" | "role_coverage_pct" | "critical_path_score" | "blocker_score",
  string
> = {
  consensus_score: "consensus",
  completion_pct: "completion",
  role_coverage_pct: "role_coverage",
  critical_path_score: "critical_path",
  blocker_score: "blockers",
};

const RADAR_AXES: ReadonlyArray<{
  axis: string;
  key: keyof typeof DELTA_KEY_BY_METRIC;
}> = [
  { axis: "Completion", key: "completion_pct" },
  { axis: "Consensus", key: "consensus_score" },
  { axis: "Role Coverage", key: "role_coverage_pct" },
  { axis: "Critical Path", key: "critical_path_score" },
  { axis: "Path Clear", key: "blocker_score" },
] as const;

const ZERO_METRICS = {
  completion_pct: 0,
  consensus_score: 0,
  role_coverage_pct: 0,
  critical_path_score: 0,
  blocker_score: 0,
} as const;

interface GhostRadarProps {
  quorumId: string;
  threshold?: number;
  /** Pre-computed history for testing / storybook (bypasses hook). */
  staticHistory?: HealthSnapshot[];
  /** Pre-computed LLM deltas (short keys e.g. `{ consensus: -8 }`). */
  staticDeltas?: Record<string, number>;
}

/** Color a delta pill green for positive, red for negative, neutral for zero. */
function pillColors(delta: number): { bg: string; border: string; fg: string } {
  if (delta > 0) {
    return {
      bg: "rgba(52,211,153,0.12)",
      border: "rgba(52,211,153,0.35)",
      fg: "#34d399",
    };
  }
  if (delta < 0) {
    return {
      bg: "rgba(248,113,113,0.12)",
      border: "rgba(248,113,113,0.35)",
      fg: "#f87171",
    };
  }
  return {
    bg: "rgba(255,255,255,0.04)",
    border: "rgba(255,255,255,0.12)",
    fg: "rgba(255,255,255,0.55)",
  };
}

/** Pick the accent color for the current polygon, mirroring QuorumHealthChart. */
function scoreColor(score: number, threshold: number): { hex: string } {
  if (score >= threshold) return { hex: "#34d399" };
  if (score >= 50) return { hex: "#fbbf24" };
  return { hex: "#f87171" };
}

/** "3:42 ago" / "12s ago" / "just now" — relative time from a unix-ms timestamp. */
function formatRelativeTime(ts: number, now: number): string {
  const diffMs = Math.max(0, now - ts);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}:${remSec.toString().padStart(2, "0")} ago`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m ago`;
}

/** Total step duration for the Play animation, in ms. ~6s feel regardless of length. */
const PLAY_TOTAL_MS = 6000;
/** Floor on per-step duration (so very long histories don't blur past). */
const PLAY_MIN_STEP_MS = 80;
/** Ceiling on per-step duration (so very short histories don't crawl). */
const PLAY_MAX_STEP_MS = 600;
/** Fallback step for prefers-reduced-motion (no interpolation, just steps). */
const PLAY_REDUCED_MOTION_STEP_MS = 400;

export function GhostRadar({
  quorumId,
  threshold = 75,
  staticHistory,
  staticDeltas,
}: GhostRadarProps) {
  const live = useQuorumLive(quorumId);
  const history = staticHistory ?? live.history;
  const score = live.healthScore;
  const llmDeltas = staticDeltas ?? live.llmDeltas;

  const prefersReducedMotion = useReducedMotion();

  // Live Signals toggle — shared key with QuorumHealthChart so the user's
  // preference persists across dashboard variants.
  const [liveSignalsOn, setLiveSignalsOn] = useState<boolean>(readInitialLiveSignals);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(LIVE_SIGNALS_STORAGE_KEY, liveSignalsOn ? "on" : "off");
    } catch {
      // ignore persistence errors
    }
  }, [liveSignalsOn]);

  // Scrub slider — 0 means earliest snapshot, history.length-1 means newest.
  // `null` means "follow live" (track the latest snapshot as it arrives).
  // IMPORTANT: scrubIdx is sticky. Once the user moves the slider, their
  // position is honoured across re-renders (including realtime history
  // appends from useQuorumLive) until they hit the "Live" button or Play
  // walks them back to null at the end of the timeline.
  const [scrubIdx, setScrubIdx] = useState<number | null>(null);

  // Play/pause + auto-loop controls.
  const [playing, setPlaying] = useState(false);
  const [autoLoop, setAutoLoop] = useState(false);
  // We use a ref for the animation handle so the effect that drives playback
  // doesn't capture a stale setTimeout id across rerenders.
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether the current Play session has snapped to its starting
  // position yet. Reset when Play is toggled off. This prevents an infinite
  // "snap to 0" loop when the user starts playback from the end frame.
  const playSeededRef = useRef(false);

  // Clamp scrubIdx if history shrinks (rare, but defensive). Never NULL it
  // out automatically when history grows — that's the snap-back bug.
  useEffect(() => {
    if (scrubIdx == null) return;
    if (history.length === 0) {
      setScrubIdx(null);
      return;
    }
    if (scrubIdx > history.length - 1) {
      setScrubIdx(history.length - 1);
    }
  }, [history.length, scrubIdx]);

  // ── Play animation driver ───────────────────────────────────────────────
  // When `playing` flips to true, walk scrubIdx forward one step at a time
  // until we hit `history.length - 1`. Then either loop back to 0 (auto-loop
  // ON) or stop and return to live (auto-loop OFF).
  useEffect(() => {
    if (!playing) {
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
      // Reset the "seeded" flag so the next Play session re-evaluates its
      // start position fresh.
      playSeededRef.current = false;
      return;
    }
    if (history.length < 2) {
      setPlaying(false);
      return;
    }

    // Pick a step duration that targets ~6s total but clamps for very short
    // or very long histories. Reduced motion users get a fixed step.
    const stepMs = prefersReducedMotion
      ? PLAY_REDUCED_MOTION_STEP_MS
      : Math.max(
          PLAY_MIN_STEP_MS,
          Math.min(PLAY_MAX_STEP_MS, Math.floor(PLAY_TOTAL_MS / history.length)),
        );

    // First tick of a fresh play session — seed the start position.
    // If the user is at "live" (null) or already parked on the last frame,
    // start from the beginning so they can actually see the playback.
    // Otherwise resume from wherever they scrubbed to.
    if (!playSeededRef.current) {
      playSeededRef.current = true;
      const currentPos = scrubIdx ?? history.length - 1;
      const startPos = currentPos >= history.length - 1 ? 0 : currentPos;
      if (scrubIdx !== startPos) {
        setScrubIdx(startPos);
        return; // re-run effect with the new scrubIdx
      }
    }

    playTimerRef.current = setTimeout(() => {
      const cur = scrubIdx ?? 0;
      const end = history.length - 1;
      if (cur >= end) {
        // We're already on the last frame. Loop or stop.
        if (autoLoop) {
          setScrubIdx(0);
        } else {
          // Return to live (slider snaps to the right edge) and stop.
          setScrubIdx(null);
          setPlaying(false);
        }
        return;
      }
      setScrubIdx(cur + 1);
    }, stepMs);

    return () => {
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [playing, scrubIdx, history.length, autoLoop, prefersReducedMotion]);

  // Pressing Play while at "live" should start from the beginning of history,
  // not stay parked at the end. We seed scrubIdx in the effect above.
  const handleTogglePlay = () => {
    if (history.length < 2) return;
    setPlaying((p) => !p);
  };

  const handleReturnToLive = () => {
    setPlaying(false);
    setScrubIdx(null);
  };

  const handleToggleAutoLoop = () => {
    setAutoLoop((v) => !v);
  };

  const handleScrubChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Manual scrub interrupts playback so the user is in control again.
    if (playing) setPlaying(false);
    setScrubIdx(Number(e.target.value));
  };

  /** Apply the cumulative LLM delta for a metric, clamping to [0, 100]. */
  const modulate = (key: keyof typeof DELTA_KEY_BY_METRIC, raw: number): number => {
    if (!liveSignalsOn) return clamp01_100(raw);
    const delta = llmDeltas[DELTA_KEY_BY_METRIC[key]] ?? 0;
    return clamp01_100(raw + delta);
  };

  /** Initial baseline = first snapshot in history. */
  const initial: HealthSnapshot | null = history.length > 0 ? history[0] : null;
  /** "Now" snapshot for the live polygon — either latest or scrubbed. */
  const currentSnapshot: HealthSnapshot | null = useMemo(() => {
    if (history.length === 0) return null;
    if (scrubIdx == null) return history[history.length - 1];
    const clamped = Math.max(0, Math.min(history.length - 1, scrubIdx));
    return history[clamped];
  }, [history, scrubIdx]);

  /** A single ghost is visible only when we have ≥2 snapshots — otherwise
   *  initial === current and the polygons overlap perfectly. */
  const ghostVisible = history.length >= 2;

  /** Recharts data — one row per axis with both ghost + current values. */
  const radarData = useMemo(() => {
    const baseInitial = initial?.metrics ?? ZERO_METRICS;
    const baseCurrent = currentSnapshot?.metrics ?? ZERO_METRICS;
    return RADAR_AXES.map(({ axis, key }) => ({
      axis,
      // Ghost is the un-modulated first-snapshot value (no LLM deltas applied
      // — the baseline is meant to be the "as-it-arrived" deterministic state).
      ghost: Math.round(clamp01_100(baseInitial[key]) * 10) / 10,
      // Current may have LLM modulation when Live Signals are ON.
      current: Math.round(modulate(key, baseCurrent[key]) * 10) / 10,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, currentSnapshot, llmDeltas, liveSignalsOn]);

  /** Per-axis deltas (current − initial), used for the pills row. */
  const deltas = useMemo(() => {
    return radarData.map((row) => ({
      axis: row.axis,
      delta: Math.round((row.current - row.ghost) * 10) / 10,
    }));
  }, [radarData]);

  const accent = scoreColor(score, threshold);

  return (
    <div
      className="w-full h-full flex flex-col"
      style={{ minHeight: 0 }}
      data-testid="ghost-radar"
    >
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-1 mb-1">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
            Ghost-Trail Radar
          </h3>
          <DashboardInfo blurb={GHOST_RADAR_BLURB} />
          <button
            type="button"
            onClick={() => setLiveSignalsOn((v) => !v)}
            aria-pressed={liveSignalsOn}
            title={
              liveSignalsOn
                ? "Live signals ON — AI agents are modulating the radar based on conversation."
                : "Live signals OFF — showing deterministic baseline only."
            }
            className="ml-1 inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-white/70 hover:bg-white/10 transition-colors"
          >
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                background: liveSignalsOn ? "#34d399" : "rgba(255,255,255,0.35)",
                boxShadow: liveSignalsOn ? "0 0 6px rgba(52,211,153,0.7)" : "none",
              }}
            />
            <span>Live signals: {liveSignalsOn ? "ON" : "OFF"}</span>
          </button>
        </div>
        {!live.connected && !staticHistory && (
          <span className="text-[10px] text-yellow-400/80 animate-pulse uppercase tracking-wider">
            connecting…
          </span>
        )}
      </div>

      {/* ── Caption ───────────────────────────────────────────────────── */}
      <div className="px-2 mb-1">
        <span className="text-[10px] uppercase tracking-[0.22em] text-white/40">
          {ghostVisible
            ? "Initial baseline vs. current state"
            : "Ghost will appear as the quorum evolves"}
        </span>
      </div>

      {/* ── Radar ─────────────────────────────────────────────────────── */}
      <div className="relative flex-1 min-h-0" data-testid="ghost-radar-wrap">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart
            data={radarData}
            cx="50%"
            cy="50%"
            outerRadius="72%"
            margin={{ top: 8, right: 28, bottom: 8, left: 28 }}
          >
            <PolarGrid
              stroke="rgba(255,255,255,0.08)"
              strokeDasharray="2 3"
              gridType="polygon"
            />
            <PolarAngleAxis
              dataKey="axis"
              tick={{
                fill: "rgba(255,255,255,0.55)",
                fontSize: 10,
                letterSpacing: 1,
              }}
              tickLine={false}
            />
            <PolarRadiusAxis
              angle={90}
              domain={[0, 100]}
              tick={false}
              axisLine={false}
            />
            {/* Ghost (initial) — drawn first so the current polygon paints on top. */}
            <Radar
              name="Initial"
              dataKey="ghost"
              stroke="rgba(255,255,255,0.35)"
              strokeWidth={1}
              strokeDasharray="3 3"
              fill="rgba(255,255,255,0.05)"
              isAnimationActive={false}
              dot={false}
            />
            {/* Current — the live polygon. */}
            <Radar
              name="Current"
              dataKey="current"
              stroke={accent.hex}
              strokeWidth={2}
              fill={accent.hex}
              fillOpacity={0.22}
              dot={{ r: 3, fill: accent.hex, strokeWidth: 0 }}
              activeDot={{ r: 5, fill: accent.hex, stroke: "#0b0b14", strokeWidth: 2 }}
              isAnimationActive={!prefersReducedMotion}
              animationDuration={500}
              animationEasing="ease-out"
            />
          </RadarChart>
        </ResponsiveContainer>
        {/* Corner label */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1 left-2 text-[9px] uppercase tracking-[0.22em] text-white/30"
        >
          Ghost · then vs. now
        </div>
      </div>

      {/* ── Delta pills ───────────────────────────────────────────────── */}
      <div
        className="flex flex-wrap items-center gap-1.5 px-2 pt-2 pb-1 border-t border-white/[0.06]"
        style={{ flex: "0 0 auto" }}
        data-testid="ghost-radar-pills"
      >
        {deltas.map(({ axis, delta }) => {
          const c = pillColors(delta);
          const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
          const absDelta = Math.abs(delta);
          const display =
            Number.isInteger(absDelta) ? `${absDelta}` : absDelta.toFixed(1);
          return (
            <span
              key={axis}
              data-testid={`pill-${axis}`}
              data-sign={delta > 0 ? "pos" : delta < 0 ? "neg" : "zero"}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums"
              style={{
                background: c.bg,
                border: `1px solid ${c.border}`,
                color: c.fg,
              }}
            >
              <span className="text-white/55">{axis}</span>
              <span style={{ color: c.fg }}>
                {sign}
                {display}
              </span>
            </span>
          );
        })}
      </div>

      {/* ── Scrub slider + transport controls ─────────────────────────── */}
      {history.length >= 3 && (
        <div
          className="flex flex-col gap-1 px-2 pt-1 pb-2"
          style={{ flex: "0 0 auto" }}
          data-testid="ghost-radar-scrub"
        >
          <div className="flex items-center gap-2">
            <span className="text-[9px] uppercase tracking-[0.22em] text-white/35">
              scrub
            </span>
            <input
              type="range"
              aria-label="Scrub through quorum history"
              data-testid="ghost-radar-scrub-slider"
              min={0}
              max={history.length - 1}
              value={scrubIdx ?? history.length - 1}
              onChange={handleScrubChange}
              className="flex-1 h-1 accent-white/60 cursor-pointer"
            />
            <span
              className="text-[9px] uppercase tracking-[0.22em] text-white/45 tabular-nums min-w-[6.5rem] text-right"
              data-testid="ghost-radar-scrub-label"
            >
              {scrubIdx == null
                ? "live · now"
                : `${scrubIdx + 1}/${history.length}${
                    currentSnapshot?.timestamp
                      ? ` · ${formatRelativeTime(
                          currentSnapshot.timestamp,
                          history[history.length - 1]?.timestamp ?? Date.now(),
                        )}`
                      : ""
                  }`}
            </span>
          </div>
          <div className="flex items-center gap-1.5 pl-[2.6rem]">
            <button
              type="button"
              onClick={handleTogglePlay}
              data-testid="ghost-radar-play"
              aria-pressed={playing}
              aria-label={playing ? "Pause playback" : "Play through history"}
              title={playing ? "Pause" : "Play through history"}
              disabled={history.length < 2}
              className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-white/70 hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span aria-hidden="true">{playing ? "⏸" : "▶"}</span>
              <span>{playing ? "Pause" : "Play"}</span>
            </button>
            <button
              type="button"
              onClick={handleToggleAutoLoop}
              data-testid="ghost-radar-autoloop"
              aria-pressed={autoLoop}
              aria-label="Toggle auto-loop"
              title={
                autoLoop
                  ? "Auto-loop ON — playback restarts from the beginning at the end."
                  : "Auto-loop OFF — playback stops when it reaches the end."
              }
              className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-medium transition-colors"
              style={{
                background: autoLoop ? "rgba(52,211,153,0.15)" : "rgba(255,255,255,0.05)",
                color: autoLoop ? "#34d399" : "rgba(255,255,255,0.6)",
                borderColor: autoLoop
                  ? "rgba(52,211,153,0.35)"
                  : "rgba(255,255,255,0.1)",
              }}
            >
              <span aria-hidden="true">↻</span>
              <span>Loop</span>
            </button>
            <button
              type="button"
              onClick={handleReturnToLive}
              data-testid="ghost-radar-live"
              aria-label="Return to live"
              title="Snap back to the latest snapshot and resume live behaviour"
              disabled={scrubIdx == null && !playing}
              className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-white/70 hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{
                  background:
                    scrubIdx == null && !playing ? "#34d399" : "rgba(255,255,255,0.45)",
                  boxShadow:
                    scrubIdx == null && !playing
                      ? "0 0 6px rgba(52,211,153,0.7)"
                      : "none",
                }}
              />
              <span>Live</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
