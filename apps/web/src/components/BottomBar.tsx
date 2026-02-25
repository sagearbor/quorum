"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

export function BottomBar() {
  const params = useParams<{ slug?: string }>();
  const slug = params?.slug;

  if (!slug) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 h-14 bg-white border-t border-gray-200 flex items-center px-4 gap-3 z-50">
      <Link
        href={`/event/${slug}`}
        className="flex items-center gap-2 rounded-lg bg-gray-100 hover:bg-gray-200 px-4 py-2 text-sm font-medium transition-colors"
      >
        <span className="text-base">&#8862;</span>
        All Quorums
      </Link>

      {/* Current role chip — populated when a role is selected (Phase 2) */}
      <div className="ml-auto text-xs text-gray-400">
        No role selected
      </div>
    </div>
  );
}
