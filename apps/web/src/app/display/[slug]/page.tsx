"use client";

import { useParams } from "next/navigation";
import { DashboardCarousel } from "@/components/carousel/DashboardCarousel";

// In test mode, provide mock quorum IDs so the display works without a backend
const MOCK_QUORUM_IDS = [
  "mock-quorum-clinical-trial",
  "mock-quorum-irb-review",
  "mock-quorum-site-approval",
  "mock-quorum-data-monitoring",
];

export default function DisplayPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  // In production, these would come from a Supabase query for the event's active quorums.
  // For now, always use mock IDs — the useQuorumLive hook handles test mode automatically.
  const quorumIds = MOCK_QUORUM_IDS;

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
        <DashboardCarousel
          eventSlug={slug}
          quorumIds={quorumIds}
          intervalMs={25_000}
        />
      </main>
    </div>
  );
}
