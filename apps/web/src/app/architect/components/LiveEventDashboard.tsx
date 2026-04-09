"use client";

import { useArchitectStore } from "@/store/architect";
import Link from "next/link";
import type { Quorum, Role } from "@quorum/types";

function QuorumCard({
  quorum,
  roles,
}: {
  quorum: Quorum;
  roles: Role[];
}) {
  const totalParticipants = roles.reduce(
    (sum, r) => sum + (r.capacity === 1 ? 1 : 3),
    0
  );

  return (
    <div className="p-4 rounded-xl border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-semibold text-base">{quorum.title}</h3>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-300 mb-3">{quorum.description}</p>

      <div className="flex items-center gap-4 mb-3">
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

      <div className="mt-3 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span
          className={`w-2 h-2 rounded-full ${
            quorum.status === "active" ? "bg-green-500" : "bg-blue-400"
          }`}
        />
        {quorum.status}
      </div>
    </div>
  );
}

export function LiveEventDashboard() {
  const { createdQuorums, eventDraft } = useArchitectStore();

  const allQuorums: Array<{ quorum: Quorum; roles: Role[] }> = createdQuorums.map((cq) => ({
    quorum: {
      id: cq.id,
      event_id: cq.event_id,
      title: cq.title,
      description: cq.description,
      status: cq.status,
      heat_score: cq.heat_score,
      autonomy_level: cq.autonomy_level ?? 0,
      carousel_mode: cq.carousel_mode,
      dashboard_types: cq.dashboard_types,
      created_at: cq.created_at,
    },
    roles: cq.roles,
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-lg">
            {eventDraft.name || "Event"} — Dashboard
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {allQuorums.length} quorum{allQuorums.length !== 1 ? "s" : ""} created
          </p>
        </div>
        {eventDraft.slug && (
          <Link
            href={`/event/${eventDraft.slug}`}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Open Event Page
          </Link>
        )}
      </div>

      {allQuorums.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <p className="text-lg mb-2">No quorums yet</p>
          <p className="text-sm">Go back to step 2 to create quorums, or open the event page to see it live.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {allQuorums.map(({ quorum, roles }) => (
            <QuorumCard key={quorum.id} quorum={quorum} roles={roles} />
          ))}
        </div>
      )}
    </div>
  );
}
