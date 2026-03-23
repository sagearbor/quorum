"use client";

import { useMemo } from "react";
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
import type { HealthSnapshot } from "@quorum/types";

interface QuorumHealthChartProps {
  quorumId: string;
  threshold?: number;
  /** Pass pre-computed history for testing / storybook (bypasses hook) */
  staticHistory?: HealthSnapshot[];
  staticScore?: number;
}

const METRIC_LINES = [
  { key: "completion_pct", color: "#22d3ee", label: "Completion" },
  { key: "consensus_score", color: "#a78bfa", label: "Consensus" },
  { key: "role_coverage_pct", color: "#34d399", label: "Role Coverage" },
  { key: "critical_path_score", color: "#fb923c", label: "Critical Path" },
  { key: "blocker_score", color: "#f472b6", label: "Blockers" },
] as const;

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
          <h3 className="text-sm font-semibold text-white/90">Quorum Health</h3>
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
      <div className="flex-1" style={{minHeight: 0, height: "calc(100% - 56px)"}}>
        <ResponsiveContainer width="100%" height="100%">
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
            />
            <Legend
              wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}
              iconType="circle"
              iconSize={8}
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
              dot={false}
              animationDuration={400}
              animationEasing="ease-out"
            />

            {/* Individual metric lines */}
            {METRIC_LINES.map(({ key, color, label }) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                name={label}
                stroke={color}
                strokeWidth={1.2}
                strokeOpacity={0.6}
                dot={false}
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
