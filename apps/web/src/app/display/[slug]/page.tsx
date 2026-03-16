"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { DashboardCarousel } from "@/components/carousel/DashboardCarousel";
import { getQuorums, isDemoMode } from "@/lib/dataProvider";

// Fallback IDs used only in demo mode (no real backend / Supabase available)
const MOCK_QUORUM_IDS = [
  "mock-quorum-clinical-trial",
  "mock-quorum-irb-review",
  "mock-quorum-site-approval",
  "mock-quorum-data-monitoring",
];

export default function DisplayPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const [quorumIds, setQuorumIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // In demo mode use the mock IDs immediately — no network call needed.
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
          setQuorumIds(quorums.map((q) => q.id));
        }
      } catch (err) {
        console.error("[DisplayPage] Failed to load quorums for", slug, err);
        // Fall back to empty list — carousel will show "awaiting quorums" state
        if (!cancelled) {
          setQuorumIds([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div className="h-screen w-screen bg-black text-white overflow-hidden flex flex-col">
      {/* Header bar */}
      <header className="px-6 py-3 flex items-center justify-between border-b border-white/10 shrink-0">
        <h1 className="text-lg font-semibold tracking-wide">
          QUORUM <span className="text-white/50 font-normal">/ {slug}</span>
        </h1>
        <div className="flex items-center gap-4">
          <span className="text-xs text-emerald-400/70 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
          <span className="text-xs text-white/40">PROJECTION MODE</span>
        </div>
      </header>

      {/* Carousel fills remaining space */}
      <main className="flex-1 min-h-0 flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-white/30 text-sm">
            Loading quorums…
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
