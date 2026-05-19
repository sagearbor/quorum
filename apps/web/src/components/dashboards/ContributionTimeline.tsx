"use client";

/**
 * ContributionTimeline — vertical chronological feed of every event in a quorum.
 *
 * Merges four source streams into one time-ordered timeline:
 *   1. `contributions`    → "Contribution" entries
 *   2. `station_messages` → "Chat" entries
 *   3. `agent_requests`   → "A2A" entries
 *   4. `agent_insights`   → "Insight" entries (best-effort)
 *
 * Each source is fetched on mount via Supabase REST. Contributions + A2A are
 * additionally subscribed to via the realtime channels exposed by
 * dataProvider. A 10s poll acts as a safety net for the other tables.
 *
 * Newest-first. Auto-scrolls to the top on new events unless the user has
 * scrolled away. Multi-select filtering by event type via header pills.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { motion, useReducedMotion, AnimatePresence } from "framer-motion";
import type {
  Contribution,
  StationMessage,
  AgentRequest,
  AgentInsight,
  Role,
} from "@quorum/types";
import {
  subscribeToContributions,
  subscribeToQuorumA2ARequests,
} from "@/lib/dataProvider";
import { DashboardInfo } from "./DashboardInfo";

const BLURB =
  "**Contribution Timeline.** Chronological feed of every event in this quorum. Filter by type, click any entry to expand. Useful for 'what happened when?' Q&A.";

export type TimelineEventType = "contribution" | "chat" | "a2a" | "insight";

export interface TimelineEntry {
  key: string;
  type: TimelineEventType;
  createdAt: string;
  roleId: string | null;
  targetRoleId?: string | null;
  excerpt: string;
  fullContent: string;
  subLabel?: string;
}

const TYPE_META: Record<
  TimelineEventType,
  { label: string; pillBg: string; pillFg: string; rule: string }
> = {
  contribution: { label: "Contribution", pillBg: "bg-emerald-900/40", pillFg: "text-emerald-300", rule: "bg-emerald-500/40" },
  chat:         { label: "Chat",         pillBg: "bg-sky-900/40",     pillFg: "text-sky-300",     rule: "bg-sky-500/40" },
  a2a:          { label: "A2A",          pillBg: "bg-violet-900/40",  pillFg: "text-violet-300",  rule: "bg-violet-500/40" },
  insight:      { label: "Insight",      pillBg: "bg-amber-900/40",   pillFg: "text-amber-300",   rule: "bg-amber-500/40" },
};

const ALL_TYPES: TimelineEventType[] = ["contribution", "chat", "a2a", "insight"];

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function excerptOf(text: string, limit = 140): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : clean.slice(0, limit - 1).trimEnd() + "…";
}

function fromContribution(r: Contribution): TimelineEntry {
  return { key: `contribution:${r.id}`, type: "contribution", createdAt: r.created_at, roleId: r.role_id, excerpt: excerptOf(r.content), fullContent: r.content ?? "" };
}
function fromStationMessage(r: StationMessage): TimelineEntry {
  return { key: `chat:${r.id}`, type: "chat", createdAt: r.created_at, roleId: r.role_id, excerpt: excerptOf(r.content), fullContent: r.content ?? "", subLabel: r.role };
}
function fromAgentRequest(r: AgentRequest): TimelineEntry {
  return { key: `a2a:${r.id}`, type: "a2a", createdAt: r.created_at, roleId: r.from_role_id, targetRoleId: r.to_role_id, excerpt: excerptOf(r.content), fullContent: r.content ?? "", subLabel: r.request_type };
}
function fromAgentInsight(r: AgentInsight): TimelineEntry {
  return { key: `insight:${r.id}`, type: "insight", createdAt: r.created_at, roleId: r.source_role_id, excerpt: excerptOf(r.content), fullContent: r.content ?? "", subLabel: r.insight_type };
}

function mergeEntries(prev: TimelineEntry[], incoming: TimelineEntry[]): TimelineEntry[] {
  const map = new Map<string, TimelineEntry>();
  for (const e of prev) map.set(e.key, e);
  for (const e of incoming) map.set(e.key, e);
  const out = Array.from(map.values());
  out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return out;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  } catch { return "—"; }
}

function roleLookup(roles: Pick<Role, "id" | "name" | "color">[]): (id: string | null | undefined) => { name: string; color: string } {
  const map = new Map<string, { name: string; color: string }>();
  for (const r of roles) map.set(r.id, { name: r.name, color: r.color || "#94a3b8" });
  return (id) => {
    if (!id) return { name: "—", color: "#94a3b8" };
    return map.get(id) ?? { name: id.slice(0, 6), color: "#94a3b8" };
  };
}

// ---------------------------------------------------------------------------
// Data fetch — Supabase REST
// ---------------------------------------------------------------------------

async function fetchAllSources(quorumId: string): Promise<TimelineEntry[]> {
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_QUORUM_TEST_MODE === "true") return [];
  try {
    const { supabase } = await import("@/lib/supabase");
    const q = (table: string) => supabase.from(table).select("*").eq("quorum_id", quorumId).order("created_at", { ascending: false }).limit(200);
    const [contribs, msgs, a2as, insights] = await Promise.all([
      q("contributions"),
      q("station_messages"),
      q("agent_requests"),
      // agent_insights is best-effort — tolerate missing table.
      q("agent_insights").then((r) => r, () => ({ data: [] as AgentInsight[] })),
    ]);
    const entries: TimelineEntry[] = [];
    for (const r of (contribs.data ?? []) as Contribution[])    entries.push(fromContribution(r));
    for (const r of (msgs.data ?? []) as StationMessage[])      entries.push(fromStationMessage(r));
    for (const r of (a2as.data ?? []) as AgentRequest[])        entries.push(fromAgentRequest(r));
    const insightRows = (insights && "data" in insights ? insights.data : []) ?? [];
    for (const r of insightRows as AgentInsight[])              entries.push(fromAgentInsight(r));
    return mergeEntries([], entries);
  } catch { return []; }
}

async function fetchRoles(quorumId: string): Promise<Pick<Role, "id" | "name" | "color">[]> {
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_QUORUM_TEST_MODE === "true") return [];
  try {
    const { supabase } = await import("@/lib/supabase");
    const { data } = await supabase.from("roles").select("id, name, color").eq("quorum_id", quorumId);
    return (data ?? []) as Pick<Role, "id" | "name" | "color">[];
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ContributionTimelineProps {
  quorumId: string;
  /** Pre-loaded entries for tests / Storybook (bypasses fetch). */
  staticEntries?: TimelineEntry[];
  /** Pre-loaded roles for tests / Storybook (bypasses fetch). */
  staticRoles?: Pick<Role, "id" | "name" | "color">[];
}

export function ContributionTimeline({ quorumId, staticEntries, staticRoles }: ContributionTimelineProps) {
  const prefersReducedMotion = useReducedMotion();

  // Always sort entries newest-first via mergeEntries, even for the static
  // initial value passed via the prop.
  const [entries, setEntries] = useState<TimelineEntry[]>(() =>
    staticEntries ? mergeEntries([], staticEntries) : [],
  );
  const [roles, setRoles] = useState<Pick<Role, "id" | "name" | "color">[]>(staticRoles ?? []);
  const [loading, setLoading] = useState(!staticEntries);
  const [activeFilters, setActiveFilters] = useState<Set<TimelineEventType>>(() => new Set(ALL_TYPES));
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const userScrolledAwayRef = useRef(false);
  const lastTopKeyRef = useRef<string | null>(null);

  // Initial fetch + 10s polling fallback.
  useEffect(() => {
    if (staticEntries) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const runFetch = async () => {
      const fresh = await fetchAllSources(quorumId);
      if (cancelled) return;
      setEntries((prev) => mergeEntries(prev, fresh));
      setLoading(false);
    };
    runFetch();
    const pollId = setInterval(runFetch, 10_000);
    return () => { cancelled = true; clearInterval(pollId); };
  }, [quorumId, staticEntries]);

  // Roles.
  useEffect(() => {
    if (staticRoles) return;
    let cancelled = false;
    fetchRoles(quorumId).then((r) => { if (!cancelled) setRoles(r); });
    return () => { cancelled = true; };
  }, [quorumId, staticRoles]);

  // Realtime subs (contributions + A2A — others rely on the poll).
  useEffect(() => {
    if (staticEntries) return;
    const unsubContrib = subscribeToContributions(quorumId, (c) => {
      setEntries((prev) => mergeEntries(prev, [fromContribution(c as unknown as Contribution)]));
    });
    const unsubA2A = subscribeToQuorumA2ARequests(quorumId, (req) => {
      setEntries((prev) => mergeEntries(prev, [fromAgentRequest(req)]));
    });
    return () => { unsubContrib(); unsubA2A(); };
  }, [quorumId, staticEntries]);

  const visibleEntries = useMemo(
    () => entries.filter((e) => activeFilters.has(e.type)),
    [entries, activeFilters],
  );

  // Auto-scroll to top on new events unless the user has scrolled away.
  // jsdom does not implement scrollTo, so feature-check before invoking.
  useEffect(() => {
    const topKey = visibleEntries[0]?.key ?? null;
    if (topKey && topKey !== lastTopKeyRef.current) {
      lastTopKeyRef.current = topKey;
      const el = scrollRef.current;
      if (el && !userScrolledAwayRef.current) {
        if (typeof el.scrollTo === "function") {
          el.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
        } else {
          el.scrollTop = 0;
        }
      }
    }
  }, [visibleEntries, prefersReducedMotion]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    userScrolledAwayRef.current = el.scrollTop > 24;
  }, []);

  const toggleFilter = useCallback((t: TimelineEventType) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(t)) {
        if (next.size === 1) return prev; // keep at least one selected
        next.delete(t);
      } else next.add(t);
      return next;
    });
  }, []);

  const toggleExpanded = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const lookup = useMemo(() => roleLookup(roles), [roles]);

  const typeCounts = useMemo(() => {
    const out: Record<TimelineEventType, number> = { contribution: 0, chat: 0, a2a: 0, insight: 0 };
    for (const e of entries) out[e.type] += 1;
    return out;
  }, [entries]);

  return (
    <div className="flex h-full flex-col gap-3 p-1" data-testid="contribution-timeline">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold text-white/90">Contribution Timeline</h3>
          <DashboardInfo blurb={BLURB} />
        </div>
        <span className="text-xs text-white/40">
          {visibleEntries.length} event{visibleEntries.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-1" data-testid="timeline-filters" role="group" aria-label="Timeline event-type filters">
        {ALL_TYPES.map((t) => {
          const meta = TYPE_META[t];
          const active = activeFilters.has(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggleFilter(t)}
              aria-pressed={active}
              data-testid={`filter-${t}`}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                active ? `${meta.pillBg} ${meta.pillFg} border-white/15`
                       : "border-white/10 bg-transparent text-white/30 hover:text-white/60"
              }`}
            >
              {meta.label}
              <span className="ml-1 text-white/40">{typeCounts[t]}</span>
            </button>
          );
        })}
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto pr-1" data-testid="timeline-scroll">
        {loading && entries.length === 0 ? (
          <div className="flex h-full items-center justify-center" data-testid="timeline-loading">
            <span className="animate-pulse text-sm text-white/40">Loading timeline…</span>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center" data-testid="timeline-empty">
            <p className="text-sm text-white/40">
              Timeline will populate as activity happens — no events yet.
            </p>
          </div>
        ) : (
          <ul className="relative space-y-2" data-testid="timeline-list">
            <AnimatePresence initial={false}>
              {visibleEntries.map((entry, idx) => {
                const isExpanded = expandedKeys.has(entry.key);
                const meta = TYPE_META[entry.type];
                const role = lookup(entry.roleId);
                const targetRole = entry.targetRoleId ? lookup(entry.targetRoleId) : null;
                const isLast = idx === visibleEntries.length - 1;
                const truncated = entry.fullContent.length > entry.excerpt.length;

                return (
                  <motion.li
                    key={entry.key}
                    initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                    transition={{ duration: 0.18 }}
                    data-testid={`timeline-entry-${entry.key}`}
                    data-event-key={entry.key}
                    className="relative grid grid-cols-[64px_12px_1fr] items-start gap-2"
                  >
                    <div className="pt-2 text-right font-mono text-[10px] tabular-nums text-white/40">
                      {formatTime(entry.createdAt)}
                    </div>

                    <div className="relative flex h-full justify-center">
                      <span className={`mt-2 inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full ${meta.rule}`} aria-hidden />
                      {!isLast && (
                        <span className="absolute left-1/2 top-5 h-[calc(100%-12px)] w-px -translate-x-1/2 bg-white/10" aria-hidden />
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => toggleExpanded(entry.key)}
                      aria-expanded={isExpanded}
                      className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-left transition-colors hover:bg-white/8 focus:outline-none focus:ring-1 focus:ring-white/30"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${meta.pillBg} ${meta.pillFg}`}>
                          {meta.label}
                          {entry.subLabel ? (
                            <span className="ml-1 font-normal opacity-70">· {entry.subLabel.replace(/_/g, " ")}</span>
                          ) : null}
                        </span>
                        <span
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ background: `${role.color}25`, color: role.color }}
                        >
                          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: role.color }} />
                          {role.name}
                          {targetRole ? (
                            <span className="opacity-70">{" → "}{targetRole.name}</span>
                          ) : null}
                        </span>
                      </div>

                      <p className={`mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-white/75 ${isExpanded ? "" : "line-clamp-3"}`}>
                        {isExpanded ? entry.fullContent : entry.excerpt}
                      </p>

                      {truncated && (
                        <span className="mt-1 inline-block text-[10px] font-medium text-white/40 hover:text-white/70">
                          {isExpanded ? "show less" : "show more"}
                        </span>
                      )}
                    </button>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  );
}
