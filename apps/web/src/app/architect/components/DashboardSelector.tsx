"use client";

import { useArchitectStore } from "@/store/architect";
import type { DashboardType } from "@quorum/types";

const DASHBOARD_OPTIONS: { type: DashboardType; label: string; description: string }[] = [
  { type: "quorum_health_chart", label: "Health Chart", description: "Line chart tracking quorum health 0-100" },
  { type: "authority_cascade_tree", label: "Authority Tree", description: "Hierarchical tree of role authority" },
  { type: "contribution_river", label: "Contribution River", description: "Flow visualization of contributions" },
  { type: "consensus_heat_ring", label: "Heat Ring", description: "Radial consensus visualization" },
  { type: "conflict_topology_map", label: "Conflict Map", description: "Network graph of conflicts" },
  { type: "decision_waterfall", label: "Decision Waterfall", description: "Sequential decision flow" },
  { type: "resolution_radar", label: "Resolution Radar", description: "Polar chart of resolution progress" },
  { type: "role_coverage_map", label: "Role Coverage", description: "Heatmap of role participation" },
  { type: "decision_dependency_dag", label: "Dependency DAG", description: "Directed graph of dependencies" },
  { type: "momentum_pulse", label: "Momentum Pulse", description: "Activity momentum indicator" },
  { type: "authority_weighted_gauge", label: "Authority Gauge", description: "Weighted authority meter" },
  { type: "contribution_timeline", label: "Timeline", description: "Chronological contribution view" },
  { type: "artifact_lineage_graph", label: "Artifact Lineage", description: "Artifact version graph" },
  { type: "live_stance_board", label: "Stance Board", description: "Live position tracking" },
  { type: "voice_pulse_matrix", label: "Voice Matrix", description: "Voice input visualization" },
];

const MAX_DASHBOARDS = 3;

export function DashboardSelector() {
  const { quorumDraft, setQuorumDraft } = useArchitectStore();
  const selected = quorumDraft.dashboard_types;

  function toggle(type: DashboardType) {
    if (selected.includes(type)) {
      setQuorumDraft({ dashboard_types: selected.filter((t) => t !== type) });
    } else if (selected.length < MAX_DASHBOARDS) {
      setQuorumDraft({ dashboard_types: [...selected, type] });
    }
  }

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-700 mb-1">
        Dashboard Types{" "}
        <span className="text-gray-400 font-normal">
          ({selected.length}/{MAX_DASHBOARDS})
        </span>
      </h4>
      <p className="text-xs text-gray-500 mb-3">
        Select 1-3 dashboard visualizations for this quorum.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {DASHBOARD_OPTIONS.map((opt) => {
          const isSelected = selected.includes(opt.type);
          const isDisabled = !isSelected && selected.length >= MAX_DASHBOARDS;
          return (
            <button
              key={opt.type}
              type="button"
              onClick={() => toggle(opt.type)}
              disabled={isDisabled}
              className={`text-left p-2.5 rounded-lg border-2 transition-all text-sm ${
                isSelected
                  ? "border-blue-500 bg-blue-50"
                  : isDisabled
                    ? "border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed"
                    : "border-gray-200 hover:border-gray-300 bg-white"
              }`}
            >
              <div className="font-medium">{opt.label}</div>
              <div className="text-xs text-gray-500 mt-0.5">
                {opt.description}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium text-gray-700">Carousel Mode:</span>
          <select
            value={quorumDraft.carousel_mode}
            onChange={(e) =>
              setQuorumDraft({
                carousel_mode: e.target.value as "multi-view" | "multi-quorum",
              })
            }
            className="px-2 py-1 border border-gray-300 rounded text-sm"
          >
            <option value="multi-view">Multi-view (same quorum, different dashboards)</option>
            <option value="multi-quorum">Multi-quorum (same dashboard, different quorums)</option>
          </select>
        </label>
      </div>
    </div>
  );
}
