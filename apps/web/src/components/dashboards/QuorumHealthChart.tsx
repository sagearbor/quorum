"use client";

import { useMemo, type ReactElement } from "react";
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
import { useQuorumLive } from "@/hooks/useQuorumLive";
import { DashboardInfo } from "./DashboardInfo";
import type { HealthSnapshot } from "@quorum/types";

const QUORUM_HEALTH_BLURB = `**Quorum Health Chart.** A live snapshot of how close this quorum is to producing its decision artifact.
- **Composite** (blue ●) — overall score 0-100, weighted blend of the lines below.  Higher is better.  The dotted target line is the threshold for the quorum to finalize.
- **Completion** (cyan ▲) — fraction of expected contributions submitted.
- **Consensus** (purple ■) — how aligned the roles are; drops when new conflicts are detected.
- **Role Coverage** (green ◆) — how many of the configured roles have actually contributed.
- **Critical Path** (orange ★) — health of the dependency chain; drops if a high-authority role is blocked.
- **Path Clear** (pink ✚) — inverse of blocker count; lower means more decisions are stuck.`;

interface QuorumHealthChartProps {
  quorumId: string;
  threshold?: number;
  /** Pass pre-computed history for testing / storybook (bypasses hook) */
  staticHistory?: HealthSnapshot[];
  staticScore?: number;
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
}: QuorumHealthChartProps) {
  const live = useQuorumLive(quorumId);
  const history = staticHistory ?? live.history;
  const score = staticScore ?? live.healthScore;

  const data: ChartDatum[] = useMemo(
    () =>
      history.map((s) => ({
        time: formatTime(s.timestamp),
        timestamp: s.timestamp,
        score: Math.round(s.score * 10) / 10,
        completion_pct: Math.round(s.metrics.completion_pct * 10) / 10,
        consensus_score: Math.round(s.metrics.consensus_score * 10) / 10,
        role_coverage_pct: Math.round(s.metrics.role_coverage_pct * 10) / 10,
        critical_path_score: Math.round(s.metrics.critical_path_score * 10) / 10,
        blocker_score: Math.round(s.metrics.blocker_score * 10) / 10,
      })),
    [history],
  );

  return (
    <div className="w-full h-full flex flex-col" style={{minHeight: 0}}>
      {/* Header */}
      <div className="flex items-center justify-between px-2 mb-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-white/90">Quorum Health</h3>
            <DashboardInfo blurb={QUORUM_HEALTH_BLURB} />
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
          <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
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
              contentStyle={{
                background: "rgba(15,15,25,0.95)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8,
                fontSize: 12,
                color: "#fff",
              }}
              labelStyle={{ color: "rgba(255,255,255,0.5)" }}
              cursor={{ stroke: "rgba(255,255,255,0.15)", strokeWidth: 1 }}
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
    </div>
  );
}
