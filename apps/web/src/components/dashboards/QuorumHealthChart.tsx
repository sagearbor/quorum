"use client";

import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { useQuorumLive, type LLMMetricRationale } from "@/hooks/useQuorumLive";
import { DashboardInfo } from "./DashboardInfo";
import { ChartPointPopover } from "./ChartPointPopover";
import type { HealthSnapshot, StreamContribution } from "@quorum/types";

/** Time-window (ms) used by the chart popover to find contributions near a
 *  clicked data point.  ±5s on either side per spec. */
const POPOVER_WINDOW_MS = 5_000;

const QUORUM_HEALTH_BLURB = `**Quorum Health Chart.** A live snapshot of how close this quorum is to producing its decision artifact.
- **Composite** (blue ●) — overall score 0-100, weighted blend of the lines below.  Higher is better.  The dotted target line is the threshold for the quorum to finalize.
- **Completion** (cyan ▲) — fraction of expected contributions submitted.
- **Consensus** (purple ■) — how aligned the roles are; drops when new conflicts are detected.
- **Role Coverage** (green ◆) — how many of the configured roles have actually contributed.
- **Critical Path** (orange ★) — health of the dependency chain; drops if a high-authority role is blocked.
- **Path Clear** (pink ✚) — inverse of blocker count; lower means more decisions are stuck.

**Live signals.** When the **Live signals** toggle is **ON** (default), AI agent personas can pull these lines up or down based on what they detect during conversation — e.g. a flagged IRB issue pulls **Path Clear** down with a rationale shown on hover.  When **OFF**, the chart shows only the deterministic baseline counts and percentages.  Toggle the pill in the chart header to compare.`;

/** Maps the displayed metric key (HealthMetrics) → short delta key emitted by
 *  the LLM `[scores: ...]` block (see packages/llm/quorum_llm/metric_deltas.py). */
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

type MetricShape = "triangle" | "square" | "diamond" | "star" | "cross";

const METRIC_LINES: ReadonlyArray<{
  key: "completion_pct" | "consensus_score" | "role_coverage_pct" | "critical_path_score" | "blocker_score";
  color: string;
  label: string;
  shape: MetricShape;
  glyph: string;
}> = [
  { key: "completion_pct", color: "#22d3ee", label: "Completion", shape: "triangle", glyph: "▲" },
  { key: "consensus_score", color: "#a78bfa", label: "Consensus", shape: "square", glyph: "■" },
  { key: "role_coverage_pct", color: "#34d399", label: "Role Coverage", shape: "diamond", glyph: "◆" },
  { key: "critical_path_score", color: "#fb923c", label: "Critical Path", shape: "star", glyph: "★" },
  { key: "blocker_score", color: "#f472b6", label: "Path Clear", shape: "cross", glyph: "✚" },
] as const;

/**
 * Render a small SVG shape centred at (cx, cy) in the given color.  Used as
 * the `dot` for each secondary line so series are distinguishable by both
 * shape and color (Sophie's expo feedback — overlapping lines were
 * indistinguishable when only color differed).
 */
function renderShape(
  shape: MetricShape,
  cx: number,
  cy: number,
  color: string,
  size = 5,
  opacity = 0.85,
): ReactElement {
  switch (shape) {
    case "triangle": {
      const h = size * 1.1;
      const pts = `${cx},${cy - h} ${cx - size},${cy + h * 0.6} ${cx + size},${cy + h * 0.6}`;
      return <polygon points={pts} fill={color} fillOpacity={opacity} />;
    }
    case "square":
      return (
        <rect
          x={cx - size}
          y={cy - size}
          width={size * 2}
          height={size * 2}
          fill={color}
          fillOpacity={opacity}
        />
      );
    case "diamond": {
      const pts = `${cx},${cy - size * 1.1} ${cx + size * 1.1},${cy} ${cx},${cy + size * 1.1} ${cx - size * 1.1},${cy}`;
      return <polygon points={pts} fill={color} fillOpacity={opacity} />;
    }
    case "star": {
      // 5-pointed star
      const spikes = 5;
      const outer = size * 1.3;
      const inner = size * 0.55;
      let path = "";
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const a = (Math.PI / spikes) * i - Math.PI / 2;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        path += (i === 0 ? "M" : "L") + x.toFixed(2) + "," + y.toFixed(2) + " ";
      }
      path += "Z";
      return <path d={path} fill={color} fillOpacity={opacity} />;
    }
    case "cross": {
      // Plus / cross
      const t = size * 0.55; // thickness
      const l = size * 1.2;  // arm length
      return (
        <g fill={color} fillOpacity={opacity}>
          <rect x={cx - t / 2} y={cy - l} width={t} height={l * 2} />
          <rect x={cx - l} y={cy - t / 2} width={l * 2} height={t} />
        </g>
      );
    }
  }
}

function makeDot(shape: MetricShape, color: string, size = 4, opacity = 0.85) {
  // Recharts calls this for every data point.  Return a transparent
  // placeholder when cx/cy are missing (Recharts does this for the activeDot
  // slot etc.).  Typed loosely to satisfy Recharts' DotProps union.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DotComponent = (props: any) => {
    const cx = typeof props?.cx === "number" ? props.cx : null;
    const cy = typeof props?.cy === "number" ? props.cy : null;
    if (cx == null || cy == null) return null;
    return <g>{renderShape(shape, cx, cy, color, size, opacity)}</g>;
  };
  DotComponent.displayName = `MetricDot(${shape})`;
  return DotComponent;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

interface ChartDatum {
  time: string;
  timestamp: number;
  score: number;
  completion_pct: number;
  consensus_score: number;
  role_coverage_pct: number;
  critical_path_score: number;
  blocker_score: number;
}

export function QuorumHealthChart({
  quorumId,
  threshold = 75,
  staticHistory,
  staticScore,
  staticDeltas,
  staticRationales,
  staticContributions,
}: QuorumHealthChartProps) {
  const live = useQuorumLive(quorumId);
  const history = staticHistory ?? live.history;
  const score = staticScore ?? live.healthScore;
  const llmDeltas = staticDeltas ?? live.llmDeltas;
  const llmRationales = staticRationales ?? live.llmRationales;
  const contributions: StreamContribution[] =
    staticContributions ?? live.recentContributions;

  // Click-point popover state.  Anchored to where the user clicked in
  // viewport space so it lines up regardless of overflow ancestors.
  const [popover, setPopover] = useState<{
    anchor: { x: number; y: number };
    timestamp: number;
  } | null>(null);

  /** Find contributions within ±5s of the given timestamp. */
  const contribsNear = useMemo(() => {
    if (!popover) return [];
    return contributions
      .map((c) => ({ c, ts: new Date(c.created_at).getTime() }))
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
      // ignore persistence errors (e.g. private-mode storage quota)
    }
  }, [liveSignalsOn]);

  /** Apply the cumulative delta for a single metric, clamping to [0, 100].
   *  Applied BEFORE the *10/10 rounding so the rendered value is correct. */
  const modulate = (key: keyof typeof DELTA_KEY_BY_METRIC, raw: number): number => {
    if (!liveSignalsOn) return Math.round(raw * 10) / 10;
    const deltaKey = DELTA_KEY_BY_METRIC[key];
    const delta = llmDeltas[deltaKey] ?? 0;
    return Math.round(clamp01_100(raw + delta) * 10) / 10;
  };

  const data: ChartDatum[] = useMemo(
    () =>
      history.map((s) => ({
        time: formatTime(s.timestamp),
        timestamp: s.timestamp,
        score: Math.round(s.score * 10) / 10,
        completion_pct: modulate("completion_pct", s.metrics.completion_pct),
        consensus_score: modulate("consensus_score", s.metrics.consensus_score),
        role_coverage_pct: modulate("role_coverage_pct", s.metrics.role_coverage_pct),
        critical_path_score: modulate("critical_path_score", s.metrics.critical_path_score),
        blocker_score: modulate("blocker_score", s.metrics.blocker_score),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, llmDeltas, liveSignalsOn],
  );

  /** Most-recent rationale per short delta key. Used by tooltip when ON. */
  const latestRationaleByKey = useMemo(() => {
    const out: Record<string, LLMMetricRationale> = {};
    for (const r of llmRationales) {
      // newest last — overwrite to keep latest
      out[r.metric] = r;
    }
    return out;
  }, [llmRationales]);

  return (
    <div className="w-full h-full flex flex-col" style={{minHeight: 0}}>
      {/* Header */}
      <div className="flex items-center justify-between px-2 mb-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-white/90">Quorum Health</h3>
            <DashboardInfo blurb={QUORUM_HEALTH_BLURB} />
            <button
              type="button"
              onClick={() => setLiveSignalsOn((v) => !v)}
              aria-pressed={liveSignalsOn}
              title={
                liveSignalsOn
                  ? "Live signals ON — AI agents are modulating these lines based on conversation. Click to view deterministic baseline."
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
          <div
            className="transition-all duration-700 ease-out"
          >
            <span className="text-2xl font-bold tabular-nums" style={{ color: score > threshold ? "#34d399" : score > 50 ? "#fbbf24" : "#f87171" }}>
              {Math.round(score)}
            </span>
            <span className="text-xs text-white/50 ml-1">/100</span>
          </div>
        </div>
        {!live.connected && !staticHistory && (
          <span className="text-xs text-yellow-400/80 animate-pulse">connecting…</span>
        )}
      </div>

      {/* Chart */}
      <div className="flex-1" style={{minHeight: "220px"}}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart
            data={data}
            margin={{ top: 5, right: 20, bottom: 5, left: 0 }}
            onClick={(state: unknown, event: unknown) => {
              // Recharts passes a state object with activePayload + a native
              // event with clientX/Y.  Bail out gracefully if either is
              // missing (e.g. clicking on empty chart whitespace).
              const s = state as {
                activePayload?: Array<{ payload?: { timestamp?: number } }>;
              } | null;
              const e = event as { clientX?: number; clientY?: number } | null;
              const ts = s?.activePayload?.[0]?.payload?.timestamp;
              if (typeof ts !== "number") return;
              if (typeof e?.clientX !== "number" || typeof e?.clientY !== "number") return;
              setPopover({ anchor: { x: e.clientX, y: e.clientY }, timestamp: ts });
            }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="time"
              tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }}
              axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
              tickLine={false}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }}
              axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
              tickLine={false}
              width={32}
            />
            <Tooltip
              cursor={{ stroke: "rgba(255,255,255,0.15)", strokeWidth: 1 }}
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                // Mapping of label → metric short key, so we can look up rationale.
                const labelToShortKey: Record<string, string> = {
                  Completion: "completion",
                  Consensus: "consensus",
                  "Role Coverage": "role_coverage",
                  "Critical Path": "critical_path",
                  "Path Clear": "blockers",
                };
                return (
                  <div
                    style={{
                      background: "rgba(15,15,25,0.95)",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 8,
                      fontSize: 12,
                      color: "#fff",
                      padding: "8px 10px",
                      maxWidth: 280,
                    }}
                  >
                    <div style={{ color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>{label}</div>
                    {payload.map((p, i) => {
                      const name = String(p.name ?? "");
                      const value = typeof p.value === "number" ? p.value : Number(p.value ?? 0);
                      const shortKey = labelToShortKey[name];
                      const rationale =
                        liveSignalsOn && shortKey ? latestRationaleByKey[shortKey] : undefined;
                      return (
                        <div key={i} style={{ marginTop: i === 0 ? 0 : 2 }}>
                          <span style={{ color: String(p.color ?? "#fff") }}>{name}</span>
                          <span style={{ color: "rgba(255,255,255,0.85)" }}>: {value}</span>
                          {rationale && rationale.delta !== 0 && (
                            <div
                              style={{
                                color: "rgba(255,255,255,0.65)",
                                fontSize: 11,
                                marginLeft: 8,
                                marginTop: 1,
                              }}
                            >
                              {name}: {rationale.delta > 0 ? "+" : ""}
                              {rationale.delta} — {rationale.why}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}
              iconSize={10}
              content={({ payload }) => (
                <ul className="flex flex-wrap justify-center gap-3 pt-1" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {(payload ?? []).map((entry, i) => {
                    const name = String(entry.value);
                    const color = entry.color ?? "#fff";
                    // Composite uses circle, others use shape glyphs from
                    // METRIC_LINES.  Looking up by label so the legend
                    // matches whichever order Recharts emits.
                    const metric = METRIC_LINES.find((m) => m.label === name);
                    const glyph = metric?.glyph ?? "●";
                    return (
                      <li key={i} className="inline-flex items-center gap-1" style={{ color: "rgba(255,255,255,0.65)" }}>
                        <span aria-hidden="true" style={{ color, fontSize: 13, lineHeight: 1 }}>{glyph}</span>
                        <span>{name}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            />

            {/* Threshold reference line */}
            <ReferenceLine
              y={threshold}
              stroke="rgba(250,204,21,0.5)"
              strokeDasharray="6 4"
              label={{
                value: `Target ${threshold}`,
                fill: "rgba(250,204,21,0.5)",
                fontSize: 10,
                position: "right",
              }}
            />

            {/* Composite score — bold main line */}
            <Line
              type="monotone"
              dataKey="score"
              name="Composite"
              stroke="#60a5fa"
              strokeWidth={2.5}
              dot={{ r: 3, fill: "#60a5fa", strokeWidth: 0 }}
              activeDot={{ r: 5, fill: "#60a5fa", stroke: "#fff", strokeWidth: 2 }}
              animationDuration={400}
              animationEasing="ease-out"
            />

            {/* Individual metric lines — each with a distinct shape AND
                colour so overlapping series remain legible (Sophie's
                expo-feedback fix). */}
            {METRIC_LINES.map(({ key, color, label, shape }) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                name={label}
                stroke={color}
                strokeWidth={1.6}
                strokeOpacity={0.85}
                dot={makeDot(shape, color, 4, 0.85)}
                activeDot={makeDot(shape, color, 6, 1)}
                animationDuration={400}
                animationEasing="ease-out"
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Click-point popover — shows contributions near the clicked timestamp
          with analyzer tags / rationale / delta strip.  Portaled to body so
          it escapes overflow:hidden ancestors. */}
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
