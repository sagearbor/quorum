"use client";

import { useArchitectStore } from "@/store/architect";
import { mockQuorums, mockRoles } from "@/lib/mockData";
import type { Quorum, Role } from "@quorum/types";

function QuorumCard({
  quorum,
  roles,
}: {
  quorum: Quorum;
  roles: Role[];
}) {
  const isHot = quorum.heat_score >= 75;
  const totalParticipants = roles.reduce(
    (sum, r) => sum + (r.capacity === 1 ? 1 : 3),
    0
  );

  return (
    <div
      className={`p-4 rounded-xl border-2 transition-all ${
        isHot
          ? "border-orange-400 bg-orange-50 shadow-md"
          : "border-gray-200 bg-white"
      }`}
    >
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-semibold text-base">{quorum.title}</h3>
        {isHot && (
          <span className="text-lg" title="Hot quorum">
            🔥
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-3">{quorum.description}</p>

      <div className="flex items-center gap-4 mb-3">
        <div className="flex-1">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span>Heat Score</span>
            <span className="font-mono font-medium">{quorum.heat_score}</span>
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                quorum.heat_score >= 75
                  ? "bg-orange-500"
                  : quorum.heat_score >= 50
                    ? "bg-yellow-500"
                    : "bg-blue-500"
              }`}
              style={{ width: `${quorum.heat_score}%` }}
            />
          </div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold">{totalParticipants}</div>
          <div className="text-[10px] text-gray-500">participants</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {roles.map((role) => (
          <span
            key={role.id}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
            style={{
              backgroundColor: `${role.color}20`,
              color: role.color,
              border: `1px solid ${role.color}40`,
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: role.color }}
            />
            {role.name}
          </span>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs text-gray-400">
        <span
          className={`w-2 h-2 rounded-full ${
            quorum.status === "active" ? "bg-green-500" : "bg-gray-300"
          }`}
        />
        {quorum.status}
        <span className="ml-auto">
          {quorum.dashboard_types.length} dashboard
          {quorum.dashboard_types.length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}

export function LiveEventDashboard() {
  const { createdQuorums, eventDraft } = useArchitectStore();

  // Merge mock data with any user-created quorums
  const allQuorums: Array<{ quorum: Quorum; roles: Role[] }> = [
    ...mockQuorums.map((q) => ({ quorum: q, roles: mockRoles[q.id] || [] })),
    ...createdQuorums.map((cq) => ({
      quorum: {
        id: cq.id,
        event_id: cq.event_id,
        title: cq.title,
        description: cq.description,
        status: cq.status,
        heat_score: cq.heat_score,
        carousel_mode: cq.carousel_mode,
        dashboard_types: cq.dashboard_types,
        created_at: cq.created_at,
      },
      roles: cq.roles,
    })),
  ];

  // Sort by heat score descending
  allQuorums.sort((a, b) => b.quorum.heat_score - a.quorum.heat_score);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-lg">
            {eventDraft.name || "Event"} — Live Dashboard
          </h3>
          <p className="text-sm text-gray-500">
            {allQuorums.length} quorum{allQuorums.length !== 1 ? "s" : ""} • sorted
            by heat score
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {allQuorums.map(({ quorum, roles }) => (
          <QuorumCard key={quorum.id} quorum={quorum} roles={roles} />
        ))}
      </div>
    </div>
  );
}
