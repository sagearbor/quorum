"use client";

/**
 * Dashboard Carousel — dual-panel sliding display for /display route.
 *
 * Two modes:
 * - Multi-view: same quorum, different dashboard types cycling ~25s.
 * - Multi-quorum: same dashboard type, different quorums side by side.
 *
 * Auto-mode: 1 quorum → multi-view; 3+ quorums → multi-quorum.
 *
 * Skeleton — Framer Motion animations in Phase 2.
 */

interface DashboardCarouselProps {
  eventSlug: string;
}

export function DashboardCarousel({ eventSlug }: DashboardCarouselProps) {
  return (
    <div className="w-full h-full flex items-center justify-center">
      <div className="grid grid-cols-2 gap-6 w-full max-w-7xl px-6">
        <div className="aspect-video border border-white/10 rounded-lg flex items-center justify-center text-white/30">
          Panel 1 — {eventSlug}
        </div>
        <div className="aspect-video border border-white/10 rounded-lg flex items-center justify-center text-white/30">
          Panel 2 — {eventSlug}
        </div>
      </div>
    </div>
  );
}
