"use client";

import { useArchitectStore } from "@/store/architect";
import type { DashboardType } from "@quorum/types";

// `implemented` flag marks dashboards with real component code today.
// Unimplemented ones are still listed (so users can see the roadmap) but
// rendered greyed out and unclickable.  Add new types above the unimplemented
// block as their components ship.
const DASHBOARD_OPTIONS: {
  type: DashboardType;
  label: string;
  description: string;
  implemented: boolean;
}[] = [
  { type: "quorum_health_chart", label: "Health Chart", description: "Line chart tracking quorum health 0-100", implemented: true },
  { type: "agent_document_viewer", label: "Agent Documents", description: "Reference docs the agents are reading from", implemented: true },
  { type: "agent_affinity_graph", label: "Agent Affinity", description: "Network of agents grouped by domain-tag overlap (Spring/Heatmap/River toggle)", implemented: true },
  { type: "authority_cascade_tree", label: "Authority Tree", description: "Hierarchical tree of role authority", implemented: false },
  { type: "contribution_river", label: "Contribution River", description: "Flow visualization of contributions", implemented: false },
  { type: "consensus_heat_ring", label: "Heat Ring", description: "Radial consensus visualization", implemented: false },
  { type: "conflict_topology_map", label: "Conflict Map", description: "Network graph of role-pair conflicts", implemented: true },
  { type: "decision_waterfall", label: "Decision Waterfall", description: "Authority-tiered cascade of contributions", implemented: true },
  { type: "resolution_radar", label: "Resolution Radar", description: "Polar chart of resolution progress", implemented: false },
  { type: "role_coverage_map", label: "Role Coverage", description: "Heatmap of role × structured-field activity", implemented: true },
  { type: "decision_dependency_dag", label: "Dependency DAG", description: "Directed graph of dependencies", implemented: false },
  { type: "momentum_pulse", label: "Momentum Pulse", description: "Activity momentum indicator", implemented: false },
  { type: "authority_weighted_gauge", label: "Authority Gauge", description: "Weighted authority meter", implemented: false },
  { type: "contribution_timeline", label: "Timeline", description: "Chronological multi-source event feed", implemented: true },
  { type: "artifact_lineage_graph", label: "Artifact Lineage", description: "Artifact version graph", implemented: false },
  { type: "live_stance_board", label: "Stance Board", description: "Live position tracking", implemented: false },
  { type: "voice_pulse_matrix", label: "Voice Matrix", description: "Voice input visualization", implemented: false },
];

const MAX_DASHBOARDS = 3;

export function DashboardSelector() {
  const { quorumDraft, setQuorumDraft } = useArchitectStore();
  const selected = quorumDraft.dashboard_types;

  function toggle(type: DashboardType) {
    const opt = DASHBOARD_OPTIONS.find((o) => o.type === type);
    if (!opt?.implemented) return; // unimplemented dashboards are not selectable
    if (selected.includes(type)) {
      setQuorumDraft({ dashboard_types: selected.filter((t) => t !== type) });
    } else if (selected.length < MAX_DASHBOARDS) {
      setQuorumDraft({ dashboard_types: [...selected, type] });
    }
  }

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
        Dashboard Types{" "}
        <span className="text-gray-500 dark:text-gray-400 font-normal">
          ({selected.length}/{MAX_DASHBOARDS})
        </span>
      </h4>
      <p className="text-xs text-gray-600 dark:text-gray-300 mb-3">
        Select 1-3 dashboard visualizations for this quorum.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {DASHBOARD_OPTIONS.map((opt) => {
          const isSelected = selected.includes(opt.type);
          const isMaxed = !isSelected && selected.length >= MAX_DASHBOARDS;
          const isDisabled = !opt.implemented || isMaxed;
          return (
            <button
              key={opt.type}
              type="button"
              onClick={() => toggle(opt.type)}
              disabled={isDisabled}
              title={!opt.implemented ? "Coming soon — component not yet built" : undefined}
              className={`relative text-left p-2.5 rounded-lg border-2 transition-all text-sm ${
                isSelected
                  ? "border-blue-500 bg-blue-50"
                  : !opt.implemented
                    ? "border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 opacity-40 cursor-not-allowed"
                    : isMaxed
                      ? "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 opacity-50 cursor-not-allowed"
                      : "border-gray-200 dark:border-gray-700 hover:border-gray-300 bg-white dark:bg-gray-800"
              }`}
            >
              {!opt.implemented && (
                <span className="absolute top-1 right-1 text-[9px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-medium">
                  Soon
                </span>
              )}
              <div className="font-medium pr-8">{opt.label}</div>
              <div className="text-xs text-gray-600 dark:text-gray-300 mt-0.5">
                {opt.description}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium text-gray-900 dark:text-gray-100">Carousel Mode:</span>
          <select
            value={quorumDraft.carousel_mode}
            onChange={(e) =>
              setQuorumDraft({
                carousel_mode: e.target.value as "multi-view" | "multi-quorum",
              })
            }
            className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm dark:bg-gray-800 dark:text-gray-100"
          >
            <option value="multi-view">Multi-view (same quorum, different dashboards)</option>
            <option value="multi-quorum">Multi-quorum (same dashboard, different quorums)</option>
          </select>
        </label>
      </div>
    </div>
  );
}
