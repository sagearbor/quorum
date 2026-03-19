"use client";

import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { DashboardCarousel } from "@/components/carousel/DashboardCarousel";
import { getQuorums, isDemoMode } from "@/lib/dataProvider";

const MOCK_QUORUM_IDS = [
  "mock-quorum-clinical-trial",
  "mock-quorum-irb-review",
  "mock-quorum-site-approval",
  "mock-quorum-data-monitoring",
];

export default function DashboardPage() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const slug = params.slug;

  // URL params for dashboard control
  const filterQuorum = searchParams.get("quorum"); // show specific quorum only
  const filterType = searchParams.get("type");     // e.g., gantt, health, budget

  const [quorumIds, setQuorumIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (isDemoMode()) {
        if (!cancelled) {
          setQuorumIds(MOCK_QUORUM_IDS);
          setLoading(false);
        }
        return;
      }

      try {
        const quorums = await getQuorums(slug);
        if (!cancelled) {
          let ids = quorums.map((q) => q.id);
          // Filter to specific quorum if requested
          if (filterQuorum) {
            ids = ids.filter((id) => id === filterQuorum);
          }
          setQuorumIds(ids);
        }
      } catch (err) {
        console.error("[DashboardPage] Failed to load quorums for", slug, err);
        if (!cancelled) {
          setQuorumIds([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [slug, filterQuorum]);

  return (
    <div className="h-screen w-screen bg-black text-white overflow-hidden flex flex-col">
      {/* Header bar */}
      <header className="px-6 py-3 flex items-center justify-between border-b border-white/10 shrink-0">
        <div className="flex items-center gap-4">
          <Link
            href={`/event/${slug}`}
            className="text-white/40 hover:text-white/70 text-sm transition-colors"
          >
            &larr; Back to event
          </Link>
          <h1 className="text-lg font-semibold tracking-wide">
            QUORUM <span className="text-white/50 font-normal">/ {slug}</span>
          </h1>
        </div>
        <div className="flex items-center gap-4">
          {filterType && (
            <span className="text-xs bg-white/10 text-white/60 px-2 py-0.5 rounded">
              {filterType}
            </span>
          )}
          <span className="text-xs text-emerald-400/70 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
          <span className="text-xs text-white/40">DASHBOARD</span>
        </div>
      </header>

      {/* Carousel */}
      <main className="flex-1 min-h-0 flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-white/30 text-sm">
            Loading quorums…
          </div>
        ) : quorumIds.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-white/30 text-sm">
            No quorums found for this event
          </div>
        ) : (
          <DashboardCarousel
            eventSlug={slug}
            quorumIds={quorumIds}
            intervalMs={25_000}
          />
        )}
      </main>
    </div>
  );
}
