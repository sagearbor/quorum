"use client";

import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useEffect, useCallback, useRef } from "react";
import { DashboardCarousel } from "@/components/carousel/DashboardCarousel";
import { PresenceDots } from "@/components/PresenceDots";
import { usePresence } from "@/hooks/usePresence";
import { buildWsUrl } from "@/lib/wsUrl";
import { getQuorums } from "@/lib/dataProvider";

interface QuorumOption {
  id: string;
  title: string;
}

interface RoleStatus {
  role_id: string;
  name: string;
  status: "pending" | "blocked" | "active" | "completed";
  blocked_by_names: string[];
  contributions_count: number;
}

export default function DisplayPage() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const slug = params.slug;

  // URL overrides for demo control:
  //   ?mode=multi-view  → force the dashboards-rotating layout (default for 3+ quorums
  //                       would be multi-quorum which only rotates health charts)
  //   ?quorum=<id>      → restrict display to a single quorum (lets multi-view
  //                       rotate all 7 dashboards over one quorum)
  const modeParam = searchParams.get("mode");
  const quorumFilter = searchParams.get("quorum");
  const modeOverride =
    modeParam === "multi-view" || modeParam === "multi-quorum" ? modeParam : undefined;

  // Quorum titles for the picker UI — pulled once per slug change.
  const [quorumOptions, setQuorumOptions] = useState<QuorumOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    getQuorums(slug)
      .then((qs) => {
        if (cancelled) return;
        setQuorumOptions(qs.map((q) => ({ id: q.id, title: q.title })));
      })
      .catch(() => {/* non-fatal */});
    return () => { cancelled = true; };
  }, [slug]);

  /** Build a new /display URL that flips one param while preserving others. */
  function updateParams(next: Record<string, string | null>) {
    const usp = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") usp.delete(k);
      else usp.set(k, v);
    }
    const qs = usp.toString();
    router.push(`/display/${slug}${qs ? `?${qs}` : ""}`);
  }

  const [quorumIds, setQuorumIds] = useState<string[]>([]);

  // Fetch real quorum IDs for this event slug from the API
  useEffect(() => {
    async function loadQuorums() {
      try {
        const res = await fetch(`/api/events/${slug}/quorum-ids`);
        if (res.ok) {
          const ids: string[] = await res.json();
          if (ids.length > 0) {
            // If ?quorum=<id> is set, restrict to that one (lets multi-view
            // rotate all dashboards for a single quorum demo).
            setQuorumIds(quorumFilter ? ids.filter((id) => id === quorumFilter) : ids);
            return;
          }
        }
      } catch { /* fall through */ }
      // API unavailable or no quorums yet — show empty state
      setQuorumIds([]);
    }
    loadQuorums();
    const interval = setInterval(loadQuorums, 30_000);
    return () => clearInterval(interval);
  }, [slug, quorumFilter]);

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
        // API unreachable — skip this quorum's role status
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
        const ws = new WebSocket(buildWsUrl(`/quorums/${qId}/live`));
        wsRef.current = ws;

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "role_unblocked") {
              // Flash animation: add to unblocked set, remove after 2s
              setUnblockedIds((prev) => new Set([...Array.from(prev), msg.role_id]));
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
        // WebSocket connection failed — skip realtime updates
      }
    }
    return () => {
      wsRef.current?.close();
    };
  }, [quorumIds, fetchRoleStatus]);

  const blockedRoles = roleStatuses.filter((r) => r.status === "blocked");

  // Presence for the first (primary) quorum drives the "people connected"
  // counter in the header.  When multiple quorums are showing in the carousel
  // we still only subscribe once — keeping the header lightweight.
  const primaryQuorumId = quorumIds[0] ?? "";
  const presence = usePresence(primaryQuorumId);
  const totalConnected = Array.from(presence.values()).reduce(
    (sum, info) => sum + info.participantCount,
    0,
  );

  return (
    <div className="h-screen w-screen bg-black text-white overflow-hidden flex flex-col">
      {/* Header bar */}
      <header className="px-6 py-3 flex items-center justify-between border-b border-white/10 shrink-0 gap-4 flex-wrap">
        <h1 className="text-lg font-semibold tracking-wide whitespace-nowrap">
          QUORUM <span className="text-white/50 font-normal">/ {slug}</span>
        </h1>

        {/* View controls — let demo presenter pick mode + focus quorum without remembering URL params */}
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 text-white/60">
            <span className="uppercase tracking-widest text-white/40">View</span>
            <select
              value={modeParam ?? ""}
              onChange={(e) => updateParams({ mode: e.target.value || null })}
              className="bg-white/5 border border-white/15 rounded px-2 py-1 text-white/90 hover:bg-white/10 focus:outline-none focus:border-white/40 cursor-pointer"
              title="Multi-View cycles through all dashboards for one quorum. Multi-Quorum pairs the same chart across quorums."
            >
              <option value="" className="bg-black">Auto</option>
              <option value="multi-view" className="bg-black">Multi-View — all dashboards</option>
              <option value="multi-quorum" className="bg-black">Multi-Quorum — side by side</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-white/60">
            <span className="uppercase tracking-widest text-white/40">Focus</span>
            <select
              value={quorumFilter ?? ""}
              onChange={(e) => updateParams({ quorum: e.target.value || null })}
              className="bg-white/5 border border-white/15 rounded px-2 py-1 text-white/90 hover:bg-white/10 focus:outline-none focus:border-white/40 cursor-pointer max-w-[14rem] truncate"
              title="Restrict display to a single quorum. Combine with Multi-View to cycle all dashboards for that quorum."
            >
              <option value="" className="bg-black">All quorums</option>
              {quorumOptions.map((q) => (
                <option key={q.id} value={q.id} className="bg-black">
                  {q.title.length > 40 ? q.title.slice(0, 37) + "…" : q.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-4">
          {totalConnected > 0 && (
            <span
              data-testid="display-presence-total"
              className="text-xs text-emerald-300/80 flex items-center gap-1.5"
              title={`${totalConnected} participant${totalConnected === 1 ? "" : "s"} currently connected`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {totalConnected} CONNECTED
            </span>
          )}
          <span className="text-xs text-emerald-400/70 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
          <Link
            href={`/event/${slug}`}
            title="Back to event"
            className="text-xs text-white/70 hover:text-white border border-white/15 hover:border-white/50 rounded px-2 py-1 transition-colors inline-flex items-center gap-1.5 cursor-pointer"
          >
            <span aria-hidden="true">&#8617;</span>
            <span className="uppercase tracking-widest">Back to event</span>
          </Link>
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
                <PresenceDots
                  roleId={role.role_id}
                  presence={presence}
                  className="ml-2 align-middle"
                />
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
          titlesById={Object.fromEntries(quorumOptions.map((q) => [q.id, q.title]))}
          mode={modeOverride}
          intervalMs={25_000}
        />
      </main>
    </div>
  );
}
