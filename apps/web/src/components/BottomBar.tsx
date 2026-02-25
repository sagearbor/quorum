"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useQuorumStore } from "@/store/quorumStore";

export function BottomBar() {
  const params = useParams<{ slug?: string }>();
  const searchParams = useSearchParams();
  const slug = params?.slug;
  const station = searchParams.get("station");

  const currentRole = useQuorumStore((s) => s.currentRole);
  const pendingCount = useQuorumStore((s) => s.pendingContributions.length);

  if (!slug) return null;

  const allQuorumsHref = `/event/${slug}${station ? `?station=${station}` : ""}`;

  return (
    <div
      data-testid="bottom-bar"
      className="fixed bottom-0 left-0 right-0 h-14 bg-white border-t border-gray-200 flex items-center px-4 gap-3 z-50"
    >
      <Link
        href={allQuorumsHref}
        data-testid="all-quorums-link"
        className="flex items-center gap-2 rounded-lg bg-gray-100 hover:bg-gray-200 px-4 py-2 text-sm font-medium transition-colors"
      >
        <span className="text-base">&#8862;</span>
        All Quorums
      </Link>

      {pendingCount > 0 && (
        <span
          data-testid="pending-badge"
          className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 px-2.5 py-1 text-xs font-medium"
        >
          {pendingCount} pending
        </span>
      )}

      <div className="ml-auto">
        {currentRole ? (
          <span
            data-testid="role-chip"
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold"
            style={{
              backgroundColor: `${currentRole.color}15`,
              color: currentRole.color,
            }}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: currentRole.color }}
            />
            {currentRole.name}
          </span>
        ) : (
          <span className="text-xs text-gray-400">No role selected</span>
        )}
      </div>
    </div>
  );
}
