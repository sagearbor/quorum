"use client";

import { useParams } from "next/navigation";
import { useState, useEffect, useCallback, useRef } from "react";
import { DashboardCarousel } from "@/components/carousel/DashboardCarousel";

interface RoleStatus {
  role_id: string;
  name: string;
  status: "pending" | "blocked" | "active" | "completed";
  blocked_by_names: string[];
  contributions_count: number;
}

export default function DisplayPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const [quorumIds, setQuorumIds] = useState<string[]>([]);

  // Fetch real quorum IDs for this event slug from the API
  useEffect(() => {
    async function loadQuorums() {
      try {
        const res = await fetch(`/api/events/${slug}/quorum-ids`);
        if (res.ok) {
          const ids: string[] = await res.json();
          if (ids.length > 0) { setQuorumIds(ids); return; }
        }
      } catch { /* fall through */ }
      // Fallback to mock IDs if API unavailable or no quorums yet
      setQuorumIds([
        "mock-quorum-clinical-trial",
        "mock-quorum-irb-review",
        "mock-quorum-site-approval",
        "mock-quorum-data-monitoring",
      ]);
    }
    loadQuorums();
    const interval = setInterval(loadQuorums, 30_000);
    return () => clearInterval(interval);
  }, [slug]);

  const [roleStatuses, setRoleStatuses] = useState<RoleStatus[]>([]);
  const [unblockedIds, setUnblockedIds] = useState<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);

  const fetchRoleStatus = useCallback(async () => {
    for (const qId of quorumIds) {
      try {
        const res = await fetch(`/api/quorums/${qId}/role-status`);
        if (res.ok) {
          const data: RoleStatus[] = await res.json();
          setRoleStatuses(data);
        }
      } catch {
        // Silently fail in mock/test mode
      }
    }
  }, [quorumIds]);

  // Poll role-status every 10s
  useEffect(() => {
    fetchRoleStatus();
    const interval = setInterval(fetchRoleStatus, 10_000);
    return () => clearInterval(interval);
  }, [fetchRoleStatus]);

  // Listen for WebSocket role_unblocked events
  useEffect(() => {
    for (const qId of quorumIds) {
      try {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${protocol}//${window.location.host}/quorums/${qId}/live`);
        wsRef.current = ws;

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "role_unblocked") {
              // Flash animation: add to unblocked set, remove after 2s
              setUnblockedIds((prev) => new Set([...prev, msg.role_id]));
              setTimeout(() => {
                setUnblockedIds((prev) => {
                  const next = new Set(prev);
                  next.delete(msg.role_id);
                  return next;
                });
              }, 2000);
              // Refresh role statuses
              fetchRoleStatus();
            }
          } catch {
            // Ignore non-JSON messages
          }
        };
      } catch {
        // WebSocket not available in test/mock mode
      }
    }
    return () => {
      wsRef.current?.close();
    };
  }, [quorumIds, fetchRoleStatus]);

  const blockedRoles = roleStatuses.filter((r) => r.status === "blocked");

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

      {/* Blocked roles overlay strip */}
      {blockedRoles.length > 0 && (
        <div className="px-6 py-2 flex gap-3 flex-wrap border-b border-white/5">
          {roleStatuses.map((role) => {
            const isBlocked = role.status === "blocked";
            const justUnblocked = unblockedIds.has(role.role_id);

            if (!isBlocked && !justUnblocked) return null;

            return (
              <div
                key={role.role_id}
                className={`relative px-3 py-1.5 rounded-lg text-xs transition-all duration-500 ${
                  justUnblocked
                    ? "bg-emerald-500/20 border border-emerald-400/40 text-emerald-300"
                    : "bg-white/5 border border-white/10 text-white/40"
                }`}
              >
                {isBlocked && !justUnblocked && (
                  <span className="mr-1.5" aria-label="Locked">
                    &#128274;
                  </span>
                )}
                <span className="font-medium">{role.name}</span>
                {isBlocked && !justUnblocked && (
                  <span className="ml-1.5 text-white/25">
                    Waiting for: {role.blocked_by_names.join(", ")}
                  </span>
                )}
                {justUnblocked && (
                  <span className="ml-1.5 text-emerald-400">Unlocked!</span>
                )}
              </div>
            );
          })}
        </div>
      )}

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
