"use client";

import { useEffect, useMemo, useState } from "react";
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  ResponsiveContainer,
} from "recharts";
import { motion, useReducedMotion } from "framer-motion";
import { useQuorumLive, type LLMMetricRationale } from "@/hooks/useQuorumLive";
import { DashboardInfo } from "./DashboardInfo";
import { ChartPointPopover } from "./ChartPointPopover";
import type { HealthSnapshot, StreamContribution } from "@quorum/types";

/** Width (ms) of each tempo bucket in the activity sparkline. */
const TEMPO_BUCKET_MS = 30_000;
/** How many buckets to show — 10 × 30s = 5 min window. */
const TEMPO_BUCKETS = 10;
/** Window (ms) used to find a previous score for the headline delta. */
const DELTA_LOOKBACK_MS = 30_000;
/** Time-window (ms) the popover uses to find contributions near a click. */
const POPOVER_WINDOW_MS = TEMPO_BUCKET_MS / 2 + 1_000;

const QUORUM_HEALTH_BLURB = `**Quorum Health — three-organ readout.** A single instrument showing where the quorum is, what shape it's in, and how alive the room feels.
- **Headline (top).** Composite score 0-100 plus a 30-second delta (↑/↓/—). Color shifts amber → green as the score crosses the target threshold (75).
- **Radar (middle).** Five axes 0-100 describing the quorum's deliberative state. Filled polygon = current values; dashed amber polygon = target.
- **Activity strip (bottom).** Tempo of contributions per 30-second bucket over the last 5 minutes. **Click a spike** to see what landed in that bucket.

**What each radar axis measures:**
- **Completion** — fraction of the final artifact's sections that have content (or, before resolve, estimated from role coverage). Climbs as roles commit positions.
- **Consensus** — authority-weighted role participation: higher-authority roles contributing have more weight. NOT a pure agreement measure on its own; LLM signals modulate this when agents detect disagreement.
- **Role Coverage** — fraction of configured roles that have contributed at least once. Pure coverage count.
- **Critical Path** — contribution density (contributions / (roles × 2)). Approximation of "are we close to having enough input to resolve."
- **Path Clear** — inverse of unanswered single-occupant ("capacity = 1") roles. Drops when a high-priority single-person role hasn't yet weighed in.

**Live signals.** When ON (default), agents emit per-axis deltas (±20 per turn, decayed) based on what they say in conversation — e.g. naming an IRB blocker pulls **Path Clear** down; resolving a conflict pulls **Consensus** up. Toggle OFF to see only the deterministic baseline.`;

const LIVE_SIGNALS_STORAGE_KEY = "quorumLiveSignals";

function readInitialLiveSignals(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(LIVE_SIGNALS_STORAGE_KEY);
    if (raw == null) return true; // default ON
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

interface QuorumHealthChartProps {
  quorumId: string;
  threshold?: number;
  /** Pass pre-computed history for testing / storybook (bypasses hook) */
  staticHistory?: HealthSnapshot[];
  staticScore?: number;
  /** Pre-computed LLM deltas for testing (bypasses hook). Short keys, e.g.
   *  `{ consensus: -8, blockers: +5 }`. */
  staticDeltas?: Record<string, number>;
  /** Pre-computed rationales for testing. */
  staticRationales?: LLMMetricRationale[];
  /** Pre-computed contributions list for testing (bypasses hook). */
  staticContributions?: StreamContribution[];
}

/** Pick the accent color for a given composite score. */
function scoreColor(score: number, threshold: number): {
  hex: string;
  rgb: string;
  glyph: string;
  label: string;
} {
  if (score >= threshold) {
    return { hex: "#34d399", rgb: "52,211,153", glyph: "●", label: "above target" };
  }
  if (score >= 50) {
    return { hex: "#fbbf24", rgb: "251,191,36", glyph: "●", label: "below target" };
  }
  return { hex: "#f87171", rgb: "248,113,113", glyph: "●", label: "critical" };
}

interface TempoBucket {
  /** Right-edge timestamp (ms) of this bucket. */
  ts: number;
  /** Count of contributions whose created_at landed in this bucket. */
  count: number;
}

/** Bucket recent contributions into fixed time windows ending at `now`. */
function bucketContributions(
  contributions: StreamContribution[],
  now: number,
  bucketMs: number,
  buckets: number,
): TempoBucket[] {
  const out: TempoBucket[] = [];
  for (let i = buckets - 1; i >= 0; i--) {
    const end = now - i * bucketMs;
    out.push({ ts: end, count: 0 });
  }
  for (const c of contributions) {
    const t = Date.parse(c.created_at);
    if (!Number.isFinite(t)) continue;
    const ageMs = now - t;
    if (ageMs < 0 || ageMs > buckets * bucketMs) continue;
    const idx = buckets - 1 - Math.floor(ageMs / bucketMs);
    if (idx >= 0 && idx < buckets) out[idx].count += 1;
  }
  return out;
}

export function QuorumHealthChart({
  quorumId,
  threshold = 75,
  staticHistory,
  staticScore,
  staticDeltas,
  staticRationales: _staticRationales,
  staticContributions,
}: QuorumHealthChartProps) {
  const live = useQuorumLive(quorumId);
  const history = staticHistory ?? live.history;
  const score = staticScore ?? live.healthScore;
  const llmDeltas = staticDeltas ?? live.llmDeltas;
  const contributions: StreamContribution[] =
    staticContributions ?? live.recentContributions;

  const prefersReducedMotion = useReducedMotion();

  // Click-spike popover state (anchored to viewport coords from the SVG click).
  const [popover, setPopover] = useState<{
    anchor: { x: number; y: number };
    timestamp: number;
  } | null>(null);

  const contribsNear = useMemo(() => {
    if (!popover) return [];
    return contributions
      .map((c) => ({ c, ts: Date.parse(c.created_at) }))
      .filter(({ ts }) => Math.abs(ts - popover.timestamp) <= POPOVER_WINDOW_MS)
      .sort((a, b) => Math.abs(a.ts - popover.timestamp) - Math.abs(b.ts - popover.timestamp))
      .map(({ c }) => c);
  }, [popover, contributions]);

  // Live Signals toggle — default ON, persisted in localStorage.
  const [liveSignalsOn, setLiveSignalsOn] = useState<boolean>(readInitialLiveSignals);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(LIVE_SIGNALS_STORAGE_KEY, liveSignalsOn ? "on" : "off");
    } catch {
      // ignore persistence errors
    }
  }, [liveSignalsOn]);

  /** Apply the cumulative delta for a single metric, clamping to [0, 100]. */
  const modulate = (key: keyof typeof DELTA_KEY_BY_METRIC, raw: number): number => {
    if (!liveSignalsOn) return clamp01_100(raw);
    const delta = llmDeltas[DELTA_KEY_BY_METRIC[key]] ?? 0;
    return clamp01_100(raw + delta);
  };

  /** Latest snapshot from the history feed (falls back to a zero shape). */
  const latest: HealthSnapshot | null =
    history.length > 0 ? history[history.length - 1] : null;

  /** Radar data — one row per axis (Recharts radar expects this shape). */
  const radarData = useMemo(() => {
    const base = latest?.metrics ?? {
      completion_pct: 0,
      consensus_score: 0,
      role_coverage_pct: 0,
      critical_path_score: 0,
      blocker_score: 0,
    };
    return RADAR_AXES.map(({ axis, key }) => ({
      axis,
      value: Math.round(modulate(key, base[key]) * 10) / 10,
      // Reference value applied uniformly to draw the faint target polygon.
      target: threshold,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest, llmDeltas, liveSignalsOn]);

  /** Headline delta: composite score now vs. ~30s ago (from history). */
  const headlineDelta = useMemo(() => {
    if (history.length === 0) return 0;
    const nowTs = history[history.length - 1].timestamp;
    const target = nowTs - DELTA_LOOKBACK_MS;
    // Find the snapshot closest to (now - 30s) without going past it.
    let prev: HealthSnapshot | null = null;
    for (const s of history) {
      if (s.timestamp <= target) prev = s;
      else break;
    }
    // Fall back to the oldest snapshot if history is shorter than the window.
    const reference = prev ?? history[0];
    return score - reference.score;
  }, [history, score]);

  /** Activity tempo: bucketed contributions for the sparkline strip. */
  const tempo = useMemo(() => {
    const now =
      history.length > 0 ? history[history.length - 1].timestamp : Date.now();
    return bucketContributions(contributions, now, TEMPO_BUCKET_MS, TEMPO_BUCKETS);
  }, [contributions, history]);

  const tempoMax = useMemo(
    () => Math.max(1, ...tempo.map((b) => b.count)),
    [tempo],
  );

  const accent = scoreColor(score, threshold);
  const roundedScore = Math.round(score);
  const roundedDelta = Math.round(headlineDelta);
  const deltaGlyph = roundedDelta > 0 ? "↑" : roundedDelta < 0 ? "↓" : "—";
  const deltaColor =
    roundedDelta > 0
      ? "#34d399"
      : roundedDelta < 0
        ? "#f87171"
        : "rgba(255,255,255,0.45)";

  return (
    <div className="w-full h-full flex flex-col" style={{ minHeight: 0 }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-1 mb-1">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
            Quorum Health
          </h3>
          <DashboardInfo blurb={QUORUM_HEALTH_BLURB} />
          <button
            type="button"
            onClick={() => setLiveSignalsOn((v) => !v)}
            aria-pressed={liveSignalsOn}
            title={
              liveSignalsOn
                ? "Live signals ON — AI agents are modulating the radar based on conversation. Click to view deterministic baseline."
                : "Live signals OFF — showing deterministic baseline only. Click to enable AI modulation."
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

      {/* ── Organ 1 · Headline tile ────────────────────────────────────── */}
      <div
        className="relative flex items-end gap-4 px-2 pt-1 pb-2 border-b border-white/[0.06]"
        style={{ flex: "0 0 auto" }}
      >
        <motion.div
          key={roundedScore}
          initial={prefersReducedMotion ? false : { scale: 0.96, opacity: 0.6 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="leading-none"
          style={{
            fontFamily:
              "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span
            className="font-bold"
            style={{
              fontSize: "3rem",
              color: accent.hex,
              textShadow: `0 0 22px rgba(${accent.rgb}, 0.35)`,
              letterSpacing: "-0.04em",
            }}
          >
            {roundedScore}
          </span>
        </motion.div>

        <div className="flex flex-col gap-0.5 pb-1.5">
          <div className="flex items-baseline gap-1.5">
            <motion.span
              key={`${deltaGlyph}-${roundedDelta}`}
              initial={prefersReducedMotion ? false : { y: roundedDelta > 0 ? 6 : -6, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="text-lg font-bold leading-none tabular-nums"
              style={{ color: deltaColor }}
              aria-label={`Delta ${roundedDelta} versus 30 seconds ago`}
            >
              {deltaGlyph}
              {Math.abs(roundedDelta)}
            </motion.span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-white/40">
              Δ 30s
            </span>
          </div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">
            Composite · target {threshold} · {accent.label}
          </div>
        </div>

        {/* Hairline target indicator on the right edge */}
        <div
          aria-hidden="true"
          className="ml-auto self-stretch flex flex-col items-end justify-between py-1"
          style={{ minWidth: 38 }}
        >
          <span className="text-[9px] uppercase tracking-[0.2em] text-white/35">/100</span>
          <span
            className="block w-7 h-px"
            style={{ background: `linear-gradient(to right, transparent, ${accent.hex})` }}
          />
        </div>
      </div>

      {/* ── Organ 2 · Radar ────────────────────────────────────────────── */}
      <div className="relative flex-1 min-h-0" data-testid="health-radar-wrap">
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
            {/* Threshold ring — faint reference polygon at y=target. Uses the
                `target` field already on every radarData row (set to the same
                threshold value), so it draws a regular polygon. */}
            <Radar
              name="Target"
              dataKey="target"
              stroke="rgba(250,204,21,0.45)"
              strokeDasharray="4 4"
              strokeWidth={1}
              fill="rgba(250,204,21,0.04)"
              isAnimationActive={false}
              dot={false}
            />
            {/* Live polygon */}
            <Radar
              name="Health"
              dataKey="value"
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
        {/* Corner label so the radar reads as an instrument, not a generic chart */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1 left-2 text-[9px] uppercase tracking-[0.22em] text-white/30"
        >
          Balance · 5 axes
        </div>
      </div>

      {/* ── Organ 3 · Activity sparkline ───────────────────────────────── */}
      <div
        className="relative px-2 pt-2 pb-1 border-t border-white/[0.06]"
        style={{ flex: "0 0 auto" }}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-[9px] uppercase tracking-[0.22em] text-white/40">
            Activity · {TEMPO_BUCKETS * (TEMPO_BUCKET_MS / 1000)}s · {tempo.reduce((a, b) => a + b.count, 0)} turns
          </span>
          <span className="text-[9px] uppercase tracking-[0.22em] text-white/30">
            ← older · newer →
          </span>
        </div>
        <TempoStrip
          buckets={tempo}
          max={tempoMax}
          color={accent.hex}
          colorRgb={accent.rgb}
          pulse={!prefersReducedMotion}
          onPick={(bucketTs, clientX, clientY) =>
            setPopover({ anchor: { x: clientX, y: clientY }, timestamp: bucketTs })
          }
        />
      </div>

      {/* Click-spike popover — adapts the existing ChartPointPopover by
          anchoring it to a tempo-strip bucket instead of a line-chart point.
          See docs/DECISIONS.md note for the three-organ redesign. */}
      {popover && (
        <ChartPointPopover
          anchor={popover.anchor}
          timestamp={popover.timestamp}
          contributions={contribsNear}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── *
 * TempoStrip — pure-SVG sparkline of contribution tempo per bucket.
 * Renders as vertical bars (more legible at projector distance than a single
 * polyline) plus a connecting baseline polyline so eye flow is preserved.
 * ────────────────────────────────────────────────────────────────────────── */

interface TempoStripProps {
  buckets: TempoBucket[];
  max: number;
  color: string;
  colorRgb: string;
  pulse: boolean;
  onPick: (bucketTs: number, clientX: number, clientY: number) => void;
}

function TempoStrip({ buckets, max, color, colorRgb, pulse, onPick }: TempoStripProps) {
  // SVG coords: 100 wide × 30 tall viewBox — bars stretch with preserveAspect.
  const W = 100;
  const H = 30;
  const n = buckets.length;
  const slot = W / n;
  const gap = Math.min(1.4, slot * 0.18);
  const barW = Math.max(1.6, slot - gap);
  const newestIdx = n - 1;
  // Build the line connecting bar tops.
  const linePts = buckets
    .map((b, i) => {
      const x = i * slot + slot / 2;
      const h = (b.count / max) * (H - 4);
      const y = H - 2 - h;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      role="img"
      aria-label="Activity tempo over last 5 minutes"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={28}
      style={{ display: "block" }}
    >
      {/* Baseline */}
      <line
        x1={0}
        x2={W}
        y1={H - 1}
        y2={H - 1}
        stroke={`rgba(${colorRgb},0.18)`}
        strokeWidth={0.4}
      />
      {/* Connecting tempo line — subtle, beneath the bars */}
      <polyline
        points={linePts}
        fill="none"
        stroke={`rgba(${colorRgb},0.45)`}
        strokeWidth={0.6}
        vectorEffect="non-scaling-stroke"
      />
      {/* Bars */}
      {buckets.map((b, i) => {
        const x = i * slot + (slot - barW) / 2;
        const h = (b.count / max) * (H - 4);
        const y = H - 2 - Math.max(h, b.count > 0 ? 1.2 : 0);
        const isLatest = i === newestIdx && b.count > 0;
        const opacity = b.count === 0 ? 0.18 : 0.55 + 0.45 * (b.count / max);
        return (
          <g key={i}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(h, b.count > 0 ? 1.2 : 0.4)}
              fill={color}
              fillOpacity={opacity}
              style={{ cursor: b.count > 0 ? "pointer" : "default" }}
              onClick={(e) => {
                if (b.count === 0) return;
                onPick(b.ts, e.clientX, e.clientY);
              }}
            >
              {isLatest && pulse && (
                <animate
                  attributeName="fill-opacity"
                  values={`${opacity};1;${opacity}`}
                  dur="1.4s"
                  repeatCount="indefinite"
                />
              )}
            </rect>
          </g>
        );
      })}
    </svg>
  );
}
