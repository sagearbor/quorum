"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getQuorums, isDemoMode } from "@/lib/dataProvider";
import { QRCodeSVG } from "qrcode.react";
import type { Quorum, Role } from "@quorum/types";

interface EnrichedQuorum extends Quorum {
  roles: Role[];
}

/** Track how many stations have been opened per role across the page. */
let stationCounter = 0;

function HeatBadge({ score }: { score: number }) {
  let bg = "bg-gray-100 text-gray-600";
  if (score >= 60) bg = "bg-red-100 text-red-700";
  else if (score >= 30) bg = "bg-amber-100 text-amber-700";

  return (
    <span
      className={`text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${bg}`}
      title="Heat Score: measures activity and conflict level (0-100)"
      data-testid="heat-badge"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M12 23c-3.866 0-7-2.686-7-6.5 0-1.89.86-3.74 2.16-5.35C8.46 9.54 10 8 11 6c.5 1 1 2 2.5 3.5 1.5 1.5 2.5 3 3.2 4.15C17.64 15.26 19 16.61 19 18.5 19 20.314 15.866 23 12 23z" />
      </svg>
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

function RoleDropdown({
  roles,
  slug,
  quorumId,
  router,
}: {
  roles: Role[];
  slug: string;
  quorumId: string;
  router: ReturnType<typeof useRouter>;
}) {
  const [open, setOpen] = useState(false);

  if (roles.length === 0) return null;

  return (
    <div className="relative mt-3">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        data-testid={`role-dropdown-${quorumId}`}
        className="w-full text-left text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg px-3 py-2 transition-colors flex items-center justify-between"
      >
        <span>Join as role...</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden"
          data-testid={`role-menu-${quorumId}`}
        >
          {roles.map((role) => (
            <button
              key={role.id}
              type="button"
              data-testid={`role-option-${role.id}`}
              onClick={(e) => {
                e.stopPropagation();
                stationCounter++;
                router.push(
                  `/event/${slug}/quorum/${quorumId}?station=${stationCounter}`
                );
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center gap-2"
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: role.color ?? "#6b7280" }}
              />
              <span style={{ color: role.color ?? "#6b7280" }}>
                {role.name}
              </span>
              <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
                {role.capacity === "unlimited" ? "open" : `1 seat`}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
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
  const [showQR, setShowQR] = useState(false);

  const baseUrl =
    typeof window !== "undefined" ? window.location.origin : "https://quorum.app";

  useEffect(() => {
    // Reset station counter on page load
    stationCounter = 0;

    let cancelled = false;
    async function load() {
      setLoading(true);
      const data = await getQuorums(slug);
      if (!cancelled) {
        setQuorums(data as unknown as EnrichedQuorum[]);
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
        <nav className="text-sm text-gray-500 dark:text-gray-400 mb-2">
          <a href="/architect" className="hover:text-gray-600 dark:hover:text-gray-300">Architect</a>
          <span className="mx-1">/</span>
          <span className="text-gray-900 dark:text-gray-100">{slug}</span>
        </nav>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{slug}</h1>
          <Link
            href={`/display/${slug}`}
            data-testid="dashboard-link"
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
            View Dashboard
          </Link>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
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

      {/* QR Codes — collapsible, shows station links for all quorums */}
      {quorums.length > 0 && (
        <div className="mb-6">
          <button
            type="button"
            onClick={() => setShowQR((v) => !v)}
            className="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="17" y="17" width="4" height="4"/>
            </svg>
            Station QR Codes
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${showQR ? "rotate-180" : ""}`}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {showQR && (
            <div className="mt-3 p-4 border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800">
              {quorums.map((quorum) => {
                const roles = quorum.roles ?? [];
                const stationCount = Math.max(roles.length, 1);
                return (
                  <div key={quorum.id} className="mb-4 last:mb-0">
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">{quorum.title}</h4>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                      {Array.from({ length: stationCount }, (_, i) => {
                        const url = `${baseUrl}/event/${slug}/quorum/${quorum.id}?station=${i + 1}`;
                        return (
                          <a
                            key={i}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex flex-col items-center p-3 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 hover:border-indigo-300 transition-colors"
                          >
                            <QRCodeSVG value={url} size={80} level="M" />
                            <span className="mt-2 text-xs font-medium text-gray-700 dark:text-gray-200">
                              Station {i + 1}
                            </span>
                            {roles[i] && (
                              <span
                                className="text-[10px] mt-0.5"
                                style={{ color: roles[i].color ?? "#6b7280" }}
                              >
                                {roles[i].name}
                              </span>
                            )}
                          </a>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {quorums.length === 0 ? (
        <div className="text-center py-16 text-gray-500 dark:text-gray-400">
          <p className="text-lg mb-2">No quorums yet</p>
          <p className="text-sm">Create quorums in the <a href="/architect" className="text-indigo-600 underline">Architect</a> to get started.</p>
        </div>
      ) : (
        <section>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {quorums.map((quorum) => {
              const roles = quorum.roles ?? [];

              return (
                <div
                  key={quorum.id}
                  data-testid={`quorum-card-${quorum.id}`}
                  className="text-left border border-gray-200 dark:border-gray-700 rounded-xl p-4 bg-white dark:bg-gray-800 hover:border-indigo-300 hover:shadow-md transition-all"
                >
                  <button
                    type="button"
                    onClick={() =>
                      router.push(
                        `/event/${slug}/quorum/${quorum.id}${station ? `?station=${station}` : ""}`
                      )
                    }
                    className="w-full text-left focus:outline-none"
                    data-testid={`quorum-card-link-${quorum.id}`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="font-semibold text-sm leading-tight pr-2">
                        {quorum.title}
                      </h3>
                      <HeatBadge score={quorum.heat_score} />
                    </div>

                    <p className="text-xs text-gray-600 dark:text-gray-300 mb-3 line-clamp-2">
                      {quorum.description}
                    </p>

                    <div className="flex items-center gap-1.5 mb-1">
                      <StatusDot status={quorum.status} />
                      <span className="text-xs text-gray-600 dark:text-gray-300 capitalize">
                        {quorum.status}
                      </span>
                    </div>
                  </button>

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

                  {/* Role selection dropdown */}
                  <RoleDropdown
                    roles={roles}
                    slug={slug}
                    quorumId={quorum.id}
                    router={router}
                  />

                  {/* Direct station links */}
                  {roles.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {roles.map((_, i) => (
                        <Link
                          key={i}
                          href={`/event/${slug}/quorum/${quorum.id}?station=${i + 1}`}
                          className="text-[10px] px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                        >
                          Station {i + 1}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
