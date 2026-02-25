"use client";

/**
 * Quorum Health Chart — default dashboard for every quorum.
 *
 * Line chart: time on X, composite score 0–100 on Y (good = up).
 * Metrics: completion %, consensus score, role coverage %, critical path (inverted).
 * Target line (dotted): artifact generation threshold.
 *
 * Placeholder — real Recharts implementation in Phase 2 (Stream H).
 */

interface QuorumHealthChartProps {
  quorumId: string;
}

export function QuorumHealthChart({ quorumId }: QuorumHealthChartProps) {
  return (
    <div className="w-full h-full min-h-[200px] border border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center text-gray-400 p-4">
      <div className="text-sm font-medium mb-1">Quorum Health Chart</div>
      <div className="text-xs">Quorum: {quorumId}</div>
      <div className="text-xs mt-2">Recharts integration — Phase 2</div>
    </div>
  );
}
