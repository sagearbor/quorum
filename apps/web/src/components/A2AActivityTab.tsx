"use client";

/**
 * A2AActivityTab — chronological list of every agent-to-agent (A2A) request
 * that has happened in this quorum.
 *
 * Today, A2A traffic is only visible as muted "system" messages spliced into
 * the conversation thread, which is easy to miss when the room is busy. This
 * tab gives the audience (and the operator) a dedicated, scrollable feed
 * with filter pills + role pills so the A2A protocol is legible at a glance.
 *
 * Data source: `useQuorumLive(quorumId).a2aEvents` — fetched once on mount,
 * then kept in sync via Supabase realtime on `agent_requests`.
 */

import { useMemo, useState } from "react";
import type { AgentRequest, Role } from "@quorum/types";

export type A2AStatusFilter = "all" | "pending" | "completed" | "rejected";

interface A2AActivityTabProps {
  events: AgentRequest[];
  roles: Role[];
  /** Optional initial filter (defaults to "all"). */
  initialFilter?: A2AStatusFilter;
  /** Optional id to scroll into view on mount (e.g. coming from a chart marker click). */
  scrollToId?: string | null;
}

const REQUEST_TYPE_LABEL: Record<AgentRequest["request_type"], string> = {
  conflict_flag: "Conflict flagged",
  input_request: "Input requested",
  review_request: "Review requested",
  doc_edit_notify: "Doc edit",
  escalation: "Escalation",
  negotiation: "Negotiation",
};

/** Map A2A status → human-readable badge + color triple. */
function statusBadge(status: AgentRequest["status"]): {
  label: string;
  bg: string;
  fg: string;
  ring: string;
} {
  switch (status) {
    case "pending":
      return {
        label: "Pending",
        bg: "bg-amber-50 dark:bg-amber-500/10",
        fg: "text-amber-700 dark:text-amber-300",
        ring: "ring-amber-200/60 dark:ring-amber-500/30",
      };
    case "acknowledged":
    case "processing":
      return {
        label: status === "acknowledged" ? "Acknowledged" : "Processing",
        bg: "bg-sky-50 dark:bg-sky-500/10",
        fg: "text-sky-700 dark:text-sky-300",
        ring: "ring-sky-200/60 dark:ring-sky-500/30",
      };
    case "resolved":
      return {
        label: "Completed",
        bg: "bg-emerald-50 dark:bg-emerald-500/10",
        fg: "text-emerald-700 dark:text-emerald-300",
        ring: "ring-emerald-200/60 dark:ring-emerald-500/30",
      };
    case "expired":
      return {
        label: "Rejected",
        bg: "bg-rose-50 dark:bg-rose-500/10",
        fg: "text-rose-700 dark:text-rose-300",
        ring: "ring-rose-200/60 dark:ring-rose-500/30",
      };
    default:
      return {
        label: String(status),
        bg: "bg-gray-100",
        fg: "text-gray-700",
        ring: "ring-gray-200",
      };
  }
}

/** True if `status` falls into the high-level filter bucket. */
function matchesFilter(status: AgentRequest["status"], filter: A2AStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "pending") {
    return status === "pending" || status === "acknowledged" || status === "processing";
  }
  if (filter === "completed") return status === "resolved";
  if (filter === "rejected") return status === "expired";
  return true;
}

interface RolePillProps {
  role?: Role;
  fallbackId: string;
}

function RolePill({ role, fallbackId }: RolePillProps) {
  const name = role?.name ?? fallbackId.slice(0, 6);
  const color = role?.color ?? "#6b7280";
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap"
      style={{
        backgroundColor: `${color}20`,
        color,
      }}
      title={role?.name ?? fallbackId}
    >
      {name}
    </span>
  );
}

interface A2ARowProps {
  event: AgentRequest & { dupCount?: number };
  rolesById: Map<string, Role>;
  highlight: boolean;
}

function A2ARow({ event, rolesById, highlight }: A2ARowProps) {
  const dupCount = event.dupCount ?? 1;
  const [expanded, setExpanded] = useState(false);
  const source = rolesById.get(event.from_role_id);
  const target = rolesById.get(event.to_role_id);
  const badge = statusBadge(event.status);
  const ts = new Date(event.created_at);
  const tsLabel = ts.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const requestLabel = REQUEST_TYPE_LABEL[event.request_type] ?? event.request_type;
  const truncated =
    event.content.length > 140 && !expanded
      ? `${event.content.slice(0, 139).trimEnd()}…`
      : event.content;

  return (
    <div
      id={`a2a-row-${event.id}`}
      data-testid={`a2a-row-${event.id}`}
      className={`rounded-xl border p-3 transition-colors ${
        highlight
          ? "border-indigo-300 bg-indigo-50/40 dark:border-indigo-500/40 dark:bg-indigo-500/10"
          : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800/40"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 mb-1.5">
        <RolePill role={source} fallbackId={event.from_role_id} />
        <span className="text-gray-400 dark:text-gray-500" aria-hidden>
          →
        </span>
        <RolePill role={target} fallbackId={event.to_role_id} />
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide ring-1 ${badge.bg} ${badge.fg} ${badge.ring}`}
        >
          {badge.label}
        </span>
        {dupCount > 1 && (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-mono tabular-nums bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
            title={`The autonomy loop re-broadcast this same message ${dupCount - 1} more time${dupCount - 1 === 1 ? "" : "s"} — collapsed for readability.`}
          >
            ×{dupCount}
          </span>
        )}
        <span className="text-[10px] text-gray-500 dark:text-gray-400 ml-auto tabular-nums">
          {tsLabel}
        </span>
      </div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
        {requestLabel}
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="block text-left text-sm text-gray-800 dark:text-gray-100 leading-snug w-full"
        data-testid={`a2a-row-content-${event.id}`}
        title={expanded ? "Click to collapse" : "Click to expand"}
      >
        {truncated}
      </button>
      {event.response && event.status === "resolved" && (
        <div className="mt-2 pl-3 border-l-2 border-emerald-300 dark:border-emerald-500/40">
          <div className="text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300 mb-0.5">
            Outcome
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-200 leading-snug">
            {event.response}
          </p>
        </div>
      )}
      {event.tags && event.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {event.tags.map((t) => (
            <span
              key={t}
              className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
            >
              #{t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function A2AActivityTab({
  events,
  roles,
  initialFilter = "all",
  scrollToId = null,
}: A2AActivityTabProps) {
  const [filter, setFilter] = useState<A2AStatusFilter>(initialFilter);

  const rolesById = useMemo(() => {
    const m = new Map<string, Role>();
    for (const r of roles) m.set(r.id, r);
    return m;
  }, [roles]);

  /** Collapse runs of A2A events that share identical content (the autonomy
   *  loop re-broadcasts the same "cross-station insight" every tick when the
   *  underlying state hasn't changed — without dedupe a 5-min demo can show
   *  50+ identical rows).  Keeps the newest event per (status, content-hash)
   *  and attaches a `dupCount` field so the UI can render "+N copies". */
  const dedupedEvents = useMemo(() => {
    const seen = new Map<string, AgentRequest & { dupCount: number }>();
    for (const e of events) {
      const contentKey = (e.content ?? "").trim().slice(0, 200);
      const key = `${e.from_role_id ?? ""}::${e.to_role_id ?? ""}::${contentKey}`;
      const existing = seen.get(key);
      if (existing) {
        existing.dupCount += 1;
        // Keep the newest event as canonical so timestamps trend recent.
        if ((e.created_at ?? "") > (existing.created_at ?? "")) {
          seen.set(key, { ...e, dupCount: existing.dupCount });
        }
      } else {
        seen.set(key, { ...e, dupCount: 1 });
      }
    }
    return Array.from(seen.values()).sort((a, b) =>
      (b.created_at ?? "").localeCompare(a.created_at ?? ""),
    );
  }, [events]);

  const filtered = useMemo(() => {
    return dedupedEvents.filter((e) => matchesFilter(e.status, filter));
  }, [dedupedEvents, filter]);

  const counts = useMemo(() => {
    const c = { all: events.length, pending: 0, completed: 0, rejected: 0 };
    for (const e of events) {
      if (matchesFilter(e.status, "pending")) c.pending++;
      else if (matchesFilter(e.status, "completed")) c.completed++;
      else if (matchesFilter(e.status, "rejected")) c.rejected++;
    }
    return c;
  }, [events]);

  const filters: { id: A2AStatusFilter; label: string; count: number }[] = [
    { id: "all", label: "All", count: counts.all },
    { id: "pending", label: "Pending", count: counts.pending },
    { id: "completed", label: "Completed", count: counts.completed },
    { id: "rejected", label: "Rejected", count: counts.rejected },
  ];

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      data-testid="a2a-activity-tab"
    >
      {/* Filter pills */}
      <div className="flex-shrink-0 flex flex-wrap gap-1.5 px-3 pt-3 pb-2 border-b border-gray-200 dark:border-gray-700">
        {filters.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={active}
              data-testid={`a2a-filter-${f.id}`}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                active
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              }`}
            >
              <span>{f.label}</span>
              <span
                className={`text-[10px] tabular-nums ${
                  active ? "text-white/80" : "text-gray-500 dark:text-gray-400"
                }`}
              >
                {f.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filtered.length === 0 ? (
          <div
            data-testid="a2a-empty"
            className="text-center text-sm text-gray-400 dark:text-gray-500 py-12 px-6 leading-relaxed"
          >
            {events.length === 0
              ? "No agent-to-agent activity yet. Agents will reach out to each other when their domain tags overlap."
              : `No ${filter} events match.`}
          </div>
        ) : (
          filtered.map((e) => (
            <A2ARow
              key={e.id}
              event={e}
              rolesById={rolesById}
              highlight={scrollToId === e.id}
            />
          ))
        )}
      </div>
    </div>
  );
}
