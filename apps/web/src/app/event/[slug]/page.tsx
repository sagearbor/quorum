"use client";

import { useEffect } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useQuorumStore } from "@/store/quorumStore";
import {
  mockEvent,
  mockQuorums,
  mockRolesByQuorum,
  mockActiveRoles,
  stationRoleMap,
} from "@/lib/mockData";

function HeatBadge({ score }: { score: number }) {
  let bg = "bg-gray-100 text-gray-600";
  if (score >= 60) bg = "bg-red-100 text-red-700";
  else if (score >= 30) bg = "bg-amber-100 text-amber-700";

  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${bg}`}>
      {score}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-green-500",
    open: "bg-blue-400",
    resolved: "bg-gray-400",
    archived: "bg-gray-300",
  };
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${colors[status] ?? "bg-gray-300"}`}
    />
  );
}

export default function EventPage() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const slug = params.slug;
  const station = searchParams.get("station");

  const {
    setCurrentEvent,
    setQuorums,
    setRolesForQuorum,
    setStationDefault,
    stationDefault,
  } = useQuorumStore();

  useEffect(() => {
    setCurrentEvent(mockEvent);
    setQuorums(mockQuorums);
    for (const [qid, roles] of Object.entries(mockRolesByQuorum)) {
      setRolesForQuorum(qid, roles);
    }
    if (station) {
      setStationDefault(parseInt(station, 10));
    }
  }, [station, setCurrentEvent, setQuorums, setRolesForQuorum, setStationDefault]);

  const defaultRoleId = stationDefault ? stationRoleMap[stationDefault] : null;

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">{mockEvent.name}</h1>
        <p className="text-sm text-gray-500 mt-1">
          /{slug}
          {stationDefault != null && (
            <span className="ml-2 inline-flex items-center gap-1 rounded bg-indigo-50 px-2 py-0.5 text-indigo-700 text-xs font-medium">
              Station {stationDefault}
            </span>
          )}
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold mb-4">
          Active Quorums
          <span className="text-sm font-normal text-gray-400 ml-2">
            ({mockQuorums.length})
          </span>
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {mockQuorums.map((quorum) => {
            const roles = mockRolesByQuorum[quorum.id] ?? [];
            const active = mockActiveRoles[quorum.id] ?? [];

            return (
              <button
                key={quorum.id}
                data-testid={`quorum-card-${quorum.id}`}
                onClick={() =>
                  router.push(
                    `/event/${slug}/quorum/${quorum.id}${station ? `?station=${station}` : ""}`
                  )
                }
                className="text-left border border-gray-200 rounded-xl p-4 hover:border-indigo-300 hover:shadow-md transition-all active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-indigo-400"
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-semibold text-sm leading-tight pr-2">
                    {quorum.title}
                  </h3>
                  <HeatBadge score={quorum.heat_score} />
                </div>

                <p className="text-xs text-gray-500 mb-3 line-clamp-2">
                  {quorum.description}
                </p>

                <div className="flex items-center gap-1.5 mb-1">
                  <StatusDot status={quorum.status} />
                  <span className="text-xs text-gray-500 capitalize">
                    {quorum.status}
                  </span>
                </div>

                {/* Role pills */}
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {roles.map((role) => {
                    const activeRole = active.find(
                      (ar) => ar.role_id === role.id
                    );
                    const count = activeRole?.participant_count ?? 0;
                    const isDefault = role.id === defaultRoleId;

                    return (
                      <span
                        key={role.id}
                        data-testid={`role-pill-${role.id}`}
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                          isDefault
                            ? "ring-2 ring-indigo-400 ring-offset-1"
                            : ""
                        }`}
                        style={{
                          backgroundColor: `${role.color}18`,
                          color: role.color,
                        }}
                      >
                        {role.name}
                        {count > 0 && (
                          <span
                            className="rounded-full px-1.5 text-[10px] font-bold"
                            style={{ backgroundColor: `${role.color}25` }}
                          >
                            {count}
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
