"use client";

/**
 * AgentAffinityGraphHeatmap — Designer C's "Heat-Tile Time-Lapse" view.
 *
 * N x N role x role grid where each cell shows the pairwise Jaccard similarity
 * of `[tags: ...]` blocks rolling over the last 20 ticks. The matrix re-sorts
 * itself every 5 seconds via a cheap row-clustering pass (sort by average
 * similarity to peers, descending) so coalitions visually clump together,
 * animated via Framer Motion's `layout` prop.
 *
 *   Cell background colour  -> current Jaccard value (blue 0 -> orange 1)
 *   Cell sparkline          -> last 20 Jaccard samples per pair
 *   Cell border thickness   -> count of a2a_requests between pair (last 60s)
 *   Diagonal cell           -> role contribution rate (sparkline + colour)
 *
 * Respects `prefers-reduced-motion`: the layout animation is suppressed so
 * the matrix snaps to the new sort order instead of tweening.
 *
 * The component is self-contained: it fetches its own role list, subscribes
 * to contributions and a2a_requests, and renders graceful "connecting..." /
 * empty states.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { subscribeToContributions } from "@/lib/dataProvider";
import { DashboardInfo } from "./DashboardInfo";

const HEATMAP_BLURB =
  "**Affinity Heatmap.** Each cell shows how much two AI roles' recent vocabularies overlap (Jaccard similarity over the last 20 contributions). Hotter cells mean stronger thematic alignment; thicker borders mean more agent-to-agent traffic in the last minute. Every 5 seconds the matrix re-sorts so coalitions visually clump together.";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROLLING_TAG_LIMIT = 30;
const SPARK_WINDOW = 20;
const A2A_WINDOW_MS = 60_000;
const RESORT_INTERVAL_MS = 5_000;
const CONTRIB_WINDOW_MS = 60_000;

const TAG_RE = /\[tags?:\s*([^\]]+)\]/gi;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoleStatus {
  role_id: string;
  name: string;
  status?: string;
  contributions_count?: number;
  authority_rank?: number;
}

interface RoleEntry {
  role_id: string;
  name: string;
  authority_rank: number;
}

type SparkMap = Record<string, number[]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  a.forEach((x) => {
    if (b.has(x)) intersection++;
  });
  const union = new Set<string>();
  a.forEach((x) => union.add(x));
  b.forEach((x) => union.add(x));
  return union.size === 0 ? 0 : intersection / union.size;
}

function extractTags(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    for (const raw of m[1].split(",")) {
      const t = raw.trim().toLowerCase();
      if (t) out.push(t);
    }
  }
  return out;
}

function heatColor(v: number, alpha = 0.9): string {
  const clamped = Math.max(0, Math.min(1, v));
  const r = Math.round(30 + (251 - 30) * clamped);
  const g = Math.round(58 + (146 - 58) * clamped);
  const b = Math.round(138 + (60 - 138) * clamped);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function sparkPoints(values: number[], w: number, h: number): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const y = h - Math.max(0, Math.min(1, values[0])) * h;
    return `0,${y.toFixed(2)} ${w},${y.toFixed(2)}`;
  }
  const stepX = w / (values.length - 1);
  return values
    .map((v, i) => {
      const x = i * stepX;
      const y = h - Math.max(0, Math.min(1, v)) * h;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function clusterOrder(roles: RoleEntry[], sparks: SparkMap): RoleEntry[] {
  if (roles.length <= 1) return roles;
  const score = (r: RoleEntry) => {
    let total = 0;
    let n = 0;
    for (const peer of roles) {
      if (peer.role_id === r.role_id) continue;
      const series = sparks[pairKey(r.role_id, peer.role_id)] ?? [];
      if (series.length === 0) continue;
      total += series[series.length - 1];
      n++;
    }
    return n === 0 ? 0 : total / n;
  };
  return [...roles].sort((a, b) => {
    const d = score(b) - score(a);
    if (Math.abs(d) > 1e-9) return d;
    if (a.authority_rank !== b.authority_rank)
      return b.authority_rank - a.authority_rank;
    return a.name.localeCompare(b.name);
  });
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface AgentAffinityGraphHeatmapProps {
  quorumId: string;
  /** Override role list (for tests). When provided, skips REST fetch. */
  staticRoles?: RoleEntry[];
}

export function AgentAffinityGraphHeatmap({
  quorumId,
  staticRoles,
}: AgentAffinityGraphHeatmapProps) {
  const reducedMotion = usePrefersReducedMotion();

  const [roles, setRoles] = useState<RoleEntry[]>(staticRoles ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!staticRoles);

  const tagSetsRef = useRef<Map<string, Set<string>>>(new Map());
  const tagOrderRef = useRef<Map<string, string[]>>(new Map());
  const sparksRef = useRef<SparkMap>({});
  const a2aRef = useRef<Map<string, number[]>>(new Map());
  const contribTimesRef = useRef<Map<string, number[]>>(new Map());

  const [sparks, setSparks] = useState<SparkMap>({});
  const [a2aCounts, setA2aCounts] = useState<Record<string, number>>({});
  const [diagonalRates, setDiagonalRates] = useState<Record<string, number[]>>(
    {},
  );
  const [orderedRoles, setOrderedRoles] = useState<RoleEntry[]>(
    staticRoles ?? [],
  );

  // -----------------------------------------------------------------------
  // 1) Fetch role list via REST (graceful fallback)
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (staticRoles) return;
    let cancelled = false;
    (async () => {
      try {
        const apiBase = process.env.NEXT_PUBLIC_API_URL || "/api";
        const res = await fetch(`${apiBase}/quorums/${quorumId}/role-status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: RoleStatus[] = await res.json();
        if (cancelled) return;
        const mapped: RoleEntry[] = data.map((r, i) => ({
          role_id: r.role_id,
          name: r.name,
          authority_rank: r.authority_rank ?? data.length - i,
        }));
        setRoles(mapped);
        setOrderedRoles(mapped);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load roles",
        );
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [quorumId, staticRoles]);

  // -----------------------------------------------------------------------
  // 2) Subscribe to contributions -> per-role rolling tag sets
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (roles.length === 0) return;
    const ingest = (raw: { role_id?: string; content?: string }) => {
      const roleId = raw.role_id;
      const content = raw.content ?? "";
      if (!roleId) return;
      const arr = contribTimesRef.current.get(roleId) ?? [];
      arr.push(Date.now());
      contribTimesRef.current.set(roleId, arr);
      const tags = extractTags(content);
      if (tags.length === 0) return;
      const set = tagSetsRef.current.get(roleId) ?? new Set<string>();
      const order = tagOrderRef.current.get(roleId) ?? [];
      for (const t of tags) {
        if (!set.has(t)) {
          set.add(t);
          order.push(t);
        }
      }
      while (order.length > ROLLING_TAG_LIMIT) {
        const dropped = order.shift();
        if (dropped) set.delete(dropped);
      }
      tagSetsRef.current.set(roleId, set);
      tagOrderRef.current.set(roleId, order);
    };
    const unsub = subscribeToContributions(quorumId, ingest);
    return () => {
      unsub();
    };
  }, [quorumId, roles]);

  // -----------------------------------------------------------------------
  // 3) Subscribe to a2a_requests realtime -> cell border thickness
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (roles.length === 0) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channel: any = null;
    (async () => {
      try {
        const { supabase } = await import("@/lib/supabase");
        channel = supabase
          .channel(`a2a-heatmap:${quorumId}`)
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "agent_requests",
              filter: `quorum_id=eq.${quorumId}`,
            },
            (payload: {
              new: { from_role_id?: string; to_role_id?: string };
            }) => {
              if (cancelled) return;
              const from = payload.new.from_role_id;
              const to = payload.new.to_role_id;
              if (!from || !to) return;
              const key = pairKey(from, to);
              const arr = a2aRef.current.get(key) ?? [];
              arr.push(Date.now());
              a2aRef.current.set(key, arr);
            },
          )
          .subscribe();
      } catch {
        // Supabase unavailable -- borders stay at 0
      }
    })();
    return () => {
      cancelled = true;
      if (channel) {
        import("@/lib/supabase").then(({ supabase }) => {
          supabase.removeChannel(channel!);
        });
      }
    };
  }, [quorumId, roles]);

  // -----------------------------------------------------------------------
  // 4) Tick: recompute sparklines + a2a counts + re-cluster every 5s
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (roles.length === 0) return;
    function tick() {
      const now = Date.now();
      const nextSparks: SparkMap = { ...sparksRef.current };
      for (let i = 0; i < roles.length; i++) {
        for (let j = i; j < roles.length; j++) {
          const a = roles[i].role_id;
          const b = roles[j].role_id;
          const setA = tagSetsRef.current.get(a) ?? new Set<string>();
          const setB =
            a === b ? setA : tagSetsRef.current.get(b) ?? new Set<string>();
          let value: number;
          if (a === b) {
            const times = contribTimesRef.current.get(a) ?? [];
            const recent = times.filter((t) => now - t <= CONTRIB_WINDOW_MS);
            contribTimesRef.current.set(a, recent);
            value = Math.min(1, recent.length / 10);
          } else {
            value = jaccard(setA, setB);
          }
          const key = pairKey(a, b);
          const series = nextSparks[key] ?? [];
          series.push(value);
          if (series.length > SPARK_WINDOW) series.shift();
          nextSparks[key] = series;
        }
      }
      sparksRef.current = nextSparks;
      setSparks(nextSparks);

      const nextCounts: Record<string, number> = {};
      a2aRef.current.forEach((times, key) => {
        const fresh = times.filter((t) => now - t <= A2A_WINDOW_MS);
        a2aRef.current.set(key, fresh);
        if (fresh.length > 0) nextCounts[key] = fresh.length;
      });
      setA2aCounts(nextCounts);

      const diag: Record<string, number[]> = {};
      for (const r of roles) {
        diag[r.role_id] = nextSparks[pairKey(r.role_id, r.role_id)] ?? [];
      }
      setDiagonalRates(diag);

      setOrderedRoles(clusterOrder(roles, nextSparks));
    }

    tick();
    const interval = setInterval(tick, RESORT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [roles]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const cellPx = useMemo(() => {
    if (orderedRoles.length === 0) return 56;
    return Math.max(
      36,
      Math.min(72, Math.floor(360 / orderedRoles.length) + 12),
    );
  }, [orderedRoles.length]);

  if (loading) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="agent-affinity-heatmap-loading"
      >
        <span className="text-sm text-white/40 animate-pulse">
          Connecting to quorum...
        </span>
      </div>
    );
  }

  if (loadError && roles.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="agent-affinity-heatmap-error"
      >
        <p className="text-sm text-white/40">
          Role data unavailable -- connecting...
        </p>
      </div>
    );
  }

  if (orderedRoles.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="agent-affinity-heatmap-empty"
      >
        <p className="text-sm text-white/40">No roles in this quorum yet.</p>
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col gap-3 p-1 text-white"
      data-testid="agent-affinity-heatmap"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold text-white/90">
            Agent Affinity - Heatmap
          </h3>
          <DashboardInfo blurb={HEATMAP_BLURB} />
        </div>
        <div className="flex items-center gap-3 text-[10px] text-white/40">
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-4 rounded"
              style={{ background: heatColor(0) }}
            />
            0.0
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-4 rounded"
              style={{ background: heatColor(0.5) }}
            />
            0.5
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-4 rounded"
              style={{ background: heatColor(1) }}
            />
            1.0
          </span>
        </div>
      </div>

      {/* Matrix */}
      <div className="overflow-auto">
        <div
          className="inline-grid"
          style={{
            gridTemplateColumns: `minmax(120px, max-content) repeat(${orderedRoles.length}, ${cellPx}px)`,
            gap: 2,
          }}
        >
          {/* Top-left blank corner */}
          <div />
          {/* Column headers */}
          {orderedRoles.map((col) => (
            <motion.div
              key={`col-${col.role_id}`}
              layout={!reducedMotion}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="flex flex-col items-center justify-end gap-0.5 px-1 pb-1 text-[10px] text-white/70"
              style={{ width: cellPx }}
              title={col.name}
            >
              <span
                className="rounded bg-white/10 px-1 py-[1px] text-[9px] font-mono text-white/60"
                aria-label={`authority rank ${col.authority_rank}`}
              >
                r{col.authority_rank}
              </span>
              <span
                className="truncate text-center leading-tight"
                style={{ maxWidth: cellPx }}
              >
                {col.name.length > 10 ? col.name.slice(0, 9) + "..." : col.name}
              </span>
            </motion.div>
          ))}

          {/* Body rows */}
          {orderedRoles.map((row) => (
            <RowGroup
              key={`row-${row.role_id}`}
              row={row}
              cols={orderedRoles}
              sparks={sparks}
              a2aCounts={a2aCounts}
              diagonalRates={diagonalRates}
              cellPx={cellPx}
              reducedMotion={reducedMotion}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row + Cell sub-components
// ---------------------------------------------------------------------------

interface RowGroupProps {
  row: RoleEntry;
  cols: RoleEntry[];
  sparks: SparkMap;
  a2aCounts: Record<string, number>;
  diagonalRates: Record<string, number[]>;
  cellPx: number;
  reducedMotion: boolean;
}

function RowGroup({
  row,
  cols,
  sparks,
  a2aCounts,
  diagonalRates,
  cellPx,
  reducedMotion,
}: RowGroupProps) {
  return (
    <>
      {/* Row label */}
      <motion.div
        layout={!reducedMotion}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="flex items-center justify-end gap-1 pr-2 text-[11px] text-white/80"
        title={row.name}
        style={{ minWidth: 120 }}
      >
        <span className="truncate">{row.name}</span>
        <span className="shrink-0 rounded bg-white/10 px-1 py-[1px] text-[9px] font-mono text-white/60">
          r{row.authority_rank}
        </span>
      </motion.div>

      {/* Row cells */}
      {cols.map((col) => {
        const isDiag = col.role_id === row.role_id;
        const key = pairKey(row.role_id, col.role_id);
        const series = isDiag
          ? diagonalRates[row.role_id] ?? []
          : sparks[key] ?? [];
        const current = series.length > 0 ? series[series.length - 1] : 0;
        const a2a = a2aCounts[key] ?? 0;
        const borderWidth = Math.min(4, 0.5 + a2a * 0.5);

        return (
          <motion.div
            key={`cell-${row.role_id}-${col.role_id}`}
            layout={!reducedMotion}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className="relative overflow-hidden rounded"
            style={{
              width: cellPx,
              height: cellPx,
              background: heatColor(current, isDiag ? 0.65 : 0.85),
              border: `${borderWidth}px solid ${
                a2a > 0 ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.08)"
              }`,
              boxSizing: "border-box",
            }}
            data-testid={`cell-${row.role_id}-${col.role_id}`}
            title={`${row.name} <-> ${col.name}  |  ${
              isDiag ? "rate" : "similarity"
            }=${current.toFixed(2)}  |  a2a=${a2a}`}
          >
            <svg
              viewBox={`0 0 ${cellPx} ${cellPx / 2}`}
              className="absolute inset-x-0 bottom-0 h-1/2 w-full"
              preserveAspectRatio="none"
            >
              <polyline
                points={sparkPoints(series, cellPx, cellPx / 2)}
                fill="none"
                stroke={isDiag ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.55)"}
                strokeWidth={1}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
            {/* Current value, tiny text top-left */}
            <span
              className="absolute left-1 top-0.5 font-mono text-[8px] leading-none text-white/85"
              aria-hidden
            >
              {current >= 0.005 ? current.toFixed(2) : ""}
            </span>
          </motion.div>
        );
      })}
    </>
  );
}
