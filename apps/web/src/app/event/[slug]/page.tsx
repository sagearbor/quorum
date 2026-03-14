"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { getQuorums, isDemoMode } from "@/lib/dataProvider";
import type { Quorum, Role } from "@quorum/types";

interface EnrichedQuorum extends Quorum {
  roles: Role[];
}

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

  const [quorums, setQuorums] = useState<EnrichedQuorum[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const data = await getQuorums(slug);
      if (!cancelled) {
        setQuorums(data as EnrichedQuorum[]);
        setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [slug]);

  if (loading) {
    return (
      <div className="p-4 sm:p-6 max-w-4xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-4 bg-gray-200 rounded w-1/4" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-48 bg-gray-100 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <header className="mb-6">
        <nav className="text-sm text-gray-400 mb-2">
          <a href="/architect" className="hover:text-gray-600">Architect</a>
          <span className="mx-1">/</span>
          <span className="text-gray-700">{slug}</span>
        </nav>
        <h1 className="text-2xl font-bold">{slug}</h1>
        <p className="text-sm text-gray-500 mt-1">
          {quorums.length} quorum{quorums.length !== 1 ? "s" : ""}
          {station && (
            <span className="ml-2 inline-flex items-center gap-1 rounded bg-indigo-50 px-2 py-0.5 text-indigo-700 text-xs font-medium">
              Station {station}
            </span>
          )}
          {isDemoMode() && (
            <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-amber-700 text-xs font-medium">
              Demo Mode
            </span>
          )}
        </p>
      </header>

      {quorums.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">No quorums yet</p>
          <p className="text-sm">Create quorums in the <a href="/architect" className="text-indigo-600 underline">Architect</a> to get started.</p>
        </div>
      ) : (
        <section>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {quorums.map((quorum) => {
              const roles = quorum.roles ?? [];

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

                  {roles.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {roles.map((role) => (
                        <span
                          key={role.id}
                          data-testid={`role-pill-${role.id}`}
                          className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
                          style={{
                            backgroundColor: `${role.color ?? "#6b7280"}18`,
                            color: role.color ?? "#6b7280",
                          }}
                        >
                          {role.name}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
