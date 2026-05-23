"use client";

/**
 * AgentAffinityGraphRiver — horizontal streamgraph variant of the affinity panel.
 *
 * Time flows left to right; each role is a coloured swim lane whose:
 *   - Thickness at time t  approx  (contributions + a2a_requests) by that role in minute t
 *   - Centerline at time t approx  vertical position derived from each role's
 *                              mean pairwise affinity to its peers, taken
 *                              from the backend `/quorums/{id}/affinity-graph`
 *                              endpoint (word-level overlap via
 *                              `compute_tag_relevance`). Highly aligned
 *                              roles hover near the middle; outliers drift
 *                              to the top / bottom of the canvas.
 *
 * Previously the alignment signal came from a client-side Jaccard of
 * per-minute tag sets against the union centroid. That returned ~0 because
 * LLM-emitted `[tags: ...]` are short generic words while persona
 * domain_tags are compound — every band sat in a flat horizontal stripe.
 * The backend endpoint uses word-level overlap, so it produces real signal.
 *
 * The view maintains a rolling 30-minute window of per-role activity buckets
 * in local state.
 *
 *   - SVG <path> with linear ("L") interpolation only — no cubic Beziers.
 *   - Empty / sparse state shows an explicit "Listening for activity…" hint
 *     instead of jagged zero-height bands.
 *   - Respects prefers-reduced-motion (no auto-scroll under that hint).
 *
 * Self-contained: fetches /role-status and /affinity-graph in parallel,
 * polls /affinity-graph every 15s, and subscribes to `contributions` +
 * `a2a_requests` via Supabase realtime.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { DashboardInfo } from "./DashboardInfo";

const RIVER_BLURB =
  "**Agent Affinity — River.** A streamgraph of agent activity over the last 30 minutes. Each colored band is one role; band thickness shows how much that role contributed in that minute (messages + A2A requests), and the vertical position shows how aligned that role's tags are with the rest of the quorum — computed server-side by the affinity-graph endpoint (word-level overlap, not exact-match). Bands braid toward each other when roles converge on shared topics.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentAffinityGraphRiverProps {
  quorumId: string;
  /** SVG viewport width. */
  width?: number;
  /** SVG viewport height. */
  height?: number;
  /** Override the now-clock; used in tests for deterministic bucketing. */
  nowMs?: number;
}

interface RoleMeta {
  role_id: string;
  name: string;
  color: string;
  authority_rank: number;
}

interface RoleStatusResponse {
  role_id: string;
  name: string;
  status: string;
  contributions_count: number;
}

interface ActivityEvent {
  role_id: string;
  /** epoch ms */
  ts: number;
  /** tags extracted from `[tags: ...]` blocks in the content. */
  tags: string[];
  /** 1 for a contribution, 1 for an A2A request — additive. */
  weight: number;
}

// Per-role per-minute bucket.
interface Bucket {
  activity: number;
  tags: Set<string>;
}

// Plotting representation: one (x, centerY, thickness) point per bucket.
interface RoleSeries {
  role: RoleMeta;
  points: { x: number; cy: number; thickness: number }[];
}

/** Edge from the backend `/affinity-graph` endpoint. */
interface AffinityEdge {
  source: string;
  target: string;
  weight: number;
  interactionType?: string;
}

interface AffinityGraphResponse {
  nodes: Array<{ id: string; label?: string; tags?: string[] }>;
  edges: AffinityEdge[];
}

/** Pairwise weights from the backend, keyed by `pairKey(a, b)`. */
type EdgeWeightMap = Map<string, number>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_MINUTES = 30;
const MS_PER_MIN = 60_000;
// Default palette used as a fallback when role-status doesn't return colors.
const FALLBACK_PALETTE = [
  "#60a5fa", // blue
  "#34d399", // green
  "#f87171", // red
  "#fbbf24", // amber
  "#a78bfa", // violet
  "#f472b6", // pink
  "#22d3ee", // cyan
  "#fb923c", // orange
];

const TAG_BLOCK_RE = /\[tags?:\s*([^\]]+)\]/gi;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Parse `[tags: a, b, c]` blocks from arbitrary text. */
export function parseTags(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  // RegExp with /g flag is stateful — clone per call to stay reentrant.
  const re = new RegExp(TAG_BLOCK_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    for (const raw of match[1].split(",")) {
      const t = raw.trim().toLowerCase().replace(/\s+/g, "_");
      if (t) out.push(t);
    }
  }
  return out;
}

/** Floor an epoch ms timestamp to its minute. */
function floorToMinute(ms: number): number {
  return Math.floor(ms / MS_PER_MIN) * MS_PER_MIN;
}

/** Stable ordering for two role ids to use as a pair-key in the weight map. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Mean pairwise affinity weight for `roleId` against every other role
 *  appearing in `allRoleIds`, looked up in the backend-supplied edge map.
 *  Returns 0 when the role has no edges in the response. */
function meanAffinity(
  roleId: string,
  allRoleIds: string[],
  weights: EdgeWeightMap,
): number {
  if (allRoleIds.length <= 1) return 0;
  let total = 0;
  let n = 0;
  for (const peer of allRoleIds) {
    if (peer === roleId) continue;
    const w = weights.get(pairKey(roleId, peer));
    if (w === undefined) continue;
    total += w;
    n += 1;
  }
  return n === 0 ? 0 : total / n;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentAffinityGraphRiver({
  quorumId,
  width = 720,
  height = 320,
  nowMs,
}: AgentAffinityGraphRiverProps) {
  const [roles, setRoles] = useState<RoleMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [tick, setTick] = useState(0); // forces re-render every 30s for auto-scroll
  const prefersReducedMotion = usePrefersReducedMotion();
  /** Pairwise affinity weights from the backend `/affinity-graph` endpoint,
   *  keyed by `pairKey(a, b)`. Polled every 15s so the band centerlines
   *  update as new contributions land server-side. */
  const [edgeWeights, setEdgeWeights] = useState<EdgeWeightMap>(
    () => new Map<string, number>(),
  );

  // -------------------------------------------------------------------------
  // Fetch role list + initial affinity graph in parallel.
  //   - /role-status drives the swim-lane roster.
  //   - /affinity-graph supplies authoritative pairwise weights used to
  //     position each band's centerline (mean affinity to all peers).
  //   Affinity-graph failure is non-fatal: bands fall back to the lane
  //   bias and sit on the midline.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const base = process.env.NEXT_PUBLIC_API_URL ?? "";
        const [rolesRes, affinityRes] = await Promise.all([
          fetch(`${base}/quorums/${quorumId}/role-status`),
          fetch(`${base}/quorums/${quorumId}/affinity-graph`).catch(
            () => null,
          ),
        ]);
        if (!rolesRes.ok) throw new Error(`role-status ${rolesRes.status}`);
        const data: RoleStatusResponse[] = await rolesRes.json();
        if (cancelled) return;
        const mapped: RoleMeta[] = data.map((r, i) => ({
          role_id: r.role_id,
          name: r.name,
          // role-status doesn't carry color today — derive from palette by index.
          color: FALLBACK_PALETTE[i % FALLBACK_PALETTE.length],
          authority_rank: 0,
        }));

        if (affinityRes && affinityRes.ok) {
          try {
            const graph: AffinityGraphResponse = await affinityRes.json();
            const map: EdgeWeightMap = new Map();
            for (const e of graph.edges ?? []) {
              if (!e.source || !e.target) continue;
              map.set(pairKey(e.source, e.target), e.weight);
            }
            if (!cancelled) setEdgeWeights(map);
          } catch {
            // Malformed payload — leave weights empty.
          }
        }

        setRoles(mapped);
        setError(null);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "fetch failed");
          setRoles([]);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [quorumId]);

  // -------------------------------------------------------------------------
  // Poll the backend affinity graph every 15s so band centerlines drift as
  // new contributions land server-side.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!quorumId) return;
    if (!roles || roles.length === 0) return;
    let cancelled = false;
    const base = process.env.NEXT_PUBLIC_API_URL ?? "";
    const refresh = async () => {
      try {
        const res = await fetch(`${base}/quorums/${quorumId}/affinity-graph`);
        if (!res.ok) return;
        const graph: AffinityGraphResponse = await res.json();
        if (cancelled) return;
        const map: EdgeWeightMap = new Map();
        for (const e of graph.edges ?? []) {
          if (!e.source || !e.target) continue;
          map.set(pairKey(e.source, e.target), e.weight);
        }
        setEdgeWeights(map);
      } catch {
        // Transient failure — keep the previous snapshot.
      }
    };
    const id = setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [quorumId, roles]);

  // -------------------------------------------------------------------------
  // Subscribe to contributions + a2a_requests via Supabase realtime
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let contribChannel: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let a2aChannel: any = null;

    async function subscribe() {
      try {
        const { supabase } = await import("@/lib/supabase");
        if (cancelled) return;

        contribChannel = supabase
          .channel(`river-contrib:${quorumId}`)
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "contributions",
              filter: `quorum_id=eq.${quorumId}`,
            },
            (payload: { new: Record<string, unknown> }) => {
              if (cancelled) return;
              const row = payload.new;
              const roleId = String(row.role_id ?? "");
              const content = String(row.content ?? "");
              const created = row.created_at
                ? new Date(String(row.created_at)).getTime()
                : Date.now();
              if (!roleId) return;
              setEvents((prev) =>
                appendEvent(prev, {
                  role_id: roleId,
                  ts: created,
                  tags: parseTags(content),
                  weight: 1,
                }),
              );
            },
          )
          .subscribe();

        a2aChannel = supabase
          .channel(`river-a2a:${quorumId}`)
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "a2a_requests",
              filter: `quorum_id=eq.${quorumId}`,
            },
            (payload: { new: Record<string, unknown> }) => {
              if (cancelled) return;
              const row = payload.new;
              const roleId = String(row.from_role_id ?? "");
              const created = row.created_at
                ? new Date(String(row.created_at)).getTime()
                : Date.now();
              if (!roleId) return;
              setEvents((prev) =>
                appendEvent(prev, {
                  role_id: roleId,
                  ts: created,
                  // A2A rows don't always carry a [tags: ...] block; fall back to empty.
                  tags: [],
                  weight: 1,
                }),
              );
            },
          )
          .subscribe();
      } catch {
        // Supabase unavailable — silently degrade. The "connecting…" / empty
        // states are driven by the absence of events, not by an error toast.
      }
    }

    subscribe();

    return () => {
      cancelled = true;
      if (contribChannel || a2aChannel) {
        import("@/lib/supabase").then(({ supabase }) => {
          if (contribChannel) supabase.removeChannel(contribChannel);
          if (a2aChannel) supabase.removeChannel(a2aChannel);
        });
      }
    };
  }, [quorumId]);

  // -------------------------------------------------------------------------
  // 30-second auto-scroll tick (skipped under reduced-motion)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (prefersReducedMotion) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [prefersReducedMotion]);

  // -------------------------------------------------------------------------
  // Derived: bucket events per role, compute series points
  // -------------------------------------------------------------------------
  const series = useMemo(() => {
    if (!roles || roles.length === 0) return [] as RoleSeries[];
    const now = nowMs ?? Date.now();
    // Recompute against `tick` so the window slides even if no new event
    // arrives; the dependency is read here intentionally.
    void tick;

    const windowStart = floorToMinute(now) - (WINDOW_MINUTES - 1) * MS_PER_MIN;

    // role_id -> bucket index -> bucket
    const byRole = new Map<string, Bucket[]>();
    for (const r of roles) {
      byRole.set(
        r.role_id,
        Array.from({ length: WINDOW_MINUTES }, () => ({
          activity: 0,
          tags: new Set<string>(),
        })),
      );
    }

    for (const ev of events) {
      const idx = Math.floor((floorToMinute(ev.ts) - windowStart) / MS_PER_MIN);
      if (idx < 0 || idx >= WINDOW_MINUTES) continue;
      const buckets = byRole.get(ev.role_id);
      if (!buckets) continue;
      buckets[idx].activity += ev.weight;
      ev.tags.forEach((t) => buckets[idx].tags.add(t));
    }

    // Project to (x, cy, thickness).
    const usableW = width - LEFT_PAD - RIGHT_PAD;
    const cyMid = height / 2;
    const halfH = (height - TOP_PAD - BOTTOM_PAD) / 2;

    // Per-role mean affinity to all peers, from the backend `/affinity-graph`
    // endpoint. Held constant across the rolling window (affinity is a
    // whole-quorum property at fetch time, not a per-minute slice). Roles
    // with no edges in the response — or before the first fetch — get 0,
    // i.e. they drift to the edge until the backend reports their weights.
    const allRoleIds = roles.map((r) => r.role_id);
    const alignByRole = new Map<string, number>();
    for (const r of roles) {
      alignByRole.set(
        r.role_id,
        meanAffinity(r.role_id, allRoleIds, edgeWeights),
      );
    }

    const out: RoleSeries[] = [];
    let roleIdx = 0;
    for (const r of roles) {
      const buckets = byRole.get(r.role_id)!;
      // Deterministic per-role bias keeps lanes visually distinct even when
      // their alignment values are near-identical (avoids overlapping bands).
      const bias =
        ((roleIdx - (roles.length - 1) / 2) / Math.max(roles.length, 1)) *
        halfH *
        0.4;
      const align = alignByRole.get(r.role_id) ?? 0;
      const points = buckets.map((b, i) => {
        // Aligned roles hover near center; outliers drift outward.
        const offset = (1 - align) * halfH * 0.55;
        const cy = cyMid + bias + (roleIdx % 2 === 0 ? -offset : offset);
        const x = LEFT_PAD + (i / (WINDOW_MINUTES - 1)) * usableW;
        // Each activity unit adds ~3.5 px to the band thickness, capped.
        const thickness = Math.min(28, b.activity * 3.5);
        return { x, cy, thickness };
      });
      out.push({ role: r, points });
      roleIdx++;
    }
    return out;
  }, [roles, events, nowMs, tick, width, height, edgeWeights]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (roles === null) {
    return (
      <div
        className="flex h-full items-center justify-center bg-black/40"
        data-testid="agent-affinity-river-loading"
      >
        <span className="text-sm text-white/40 animate-pulse">Connecting…</span>
      </div>
    );
  }

  if (roles.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center bg-black/40"
        data-testid="agent-affinity-river-empty"
      >
        <p className="text-sm text-white/40">
          {error ? `Connecting… (${error})` : "No roles available."}
        </p>
      </div>
    );
  }

  const totalActivity = series.reduce(
    (s, r) => s + r.points.reduce((p, pt) => p + pt.thickness, 0),
    0,
  );
  const isSparse = totalActivity < 0.5;
  const nowX = width - RIGHT_PAD;

  return (
    <div
      className="flex h-full flex-col bg-white/[0.03]"
      data-testid="agent-affinity-river"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-2 pb-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold text-white/90">
            Agent Affinity — River
          </h3>
          <DashboardInfo blurb={RIVER_BLURB} />
        </div>
        <span className="text-[10px] text-white/30">
          last {WINDOW_MINUTES}m
          {prefersReducedMotion && " · static"}
        </span>
      </div>

      {/* SVG canvas */}
      <div className="relative flex-1 min-h-0">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-full w-full"
          aria-label="Agent affinity river streamgraph"
        >
          {/* Background grid: vertical minute markers every 5 min */}
          <GridLines width={width} height={height} />

          {/* Bands */}
          {series.map((s) => (
            <RiverBand key={s.role.role_id} series={s} />
          ))}

          {/* "now" line at the right edge */}
          <line
            x1={nowX}
            x2={nowX}
            y1={TOP_PAD}
            y2={height - BOTTOM_PAD}
            stroke="rgba(255,255,255,0.5)"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
          <text
            x={nowX - 4}
            y={TOP_PAD + 10}
            textAnchor="end"
            fontSize={9}
            fill="rgba(255,255,255,0.4)"
          >
            now
          </text>

          {/* Role labels pinned to the right edge */}
          <RoleLabels series={series} width={width} />
        </svg>

        {/* Sparse-data hint */}
        {isSparse && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            data-testid="agent-affinity-river-listening"
          >
            <p className="rounded bg-black/60 px-3 py-1.5 text-xs text-white/50">
              Listening for activity…
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout constants & subcomponents
// ---------------------------------------------------------------------------

const LEFT_PAD = 16;
const RIGHT_PAD = 96; // reserve room for the role labels
const TOP_PAD = 20;
const BOTTOM_PAD = 12;

function GridLines({ width, height }: { width: number; height: number }) {
  const lines = [];
  const usableW = width - LEFT_PAD - RIGHT_PAD;
  for (let m = 0; m < WINDOW_MINUTES; m += 5) {
    const x = LEFT_PAD + (m / (WINDOW_MINUTES - 1)) * usableW;
    lines.push(
      <line
        key={m}
        x1={x}
        x2={x}
        y1={TOP_PAD}
        y2={height - BOTTOM_PAD}
        stroke="rgba(255,255,255,0.04)"
        strokeWidth={1}
      />,
    );
  }
  return <g>{lines}</g>;
}

function RiverBand({ series }: { series: RoleSeries }) {
  // Build a closed polygon: forward along the top edge, then back along the bottom.
  const { points, role } = series;
  if (points.length < 2) return null;

  const top = points.map((p) => `${p.x},${p.cy - p.thickness / 2}`);
  const bottom = [...points]
    .reverse()
    .map((p) => `${p.x},${p.cy + p.thickness / 2}`);
  // Linear-only ("L") segments per the design brief.
  const d = `M${top.join(" L")} L${bottom.join(" L")} Z`;

  return (
    <path
      d={d}
      fill={role.color}
      fillOpacity={0.35}
      stroke={role.color}
      strokeOpacity={0.6}
      strokeWidth={0.75}
    />
  );
}

function RoleLabels({
  series,
  width,
}: {
  series: RoleSeries[];
  width: number;
}) {
  // Sort labels by the centerline at the last bucket to reduce visual collision.
  const sorted = [...series].sort((a, b) => {
    const ay = a.points[a.points.length - 1]?.cy ?? 0;
    const by = b.points[b.points.length - 1]?.cy ?? 0;
    return ay - by;
  });

  return (
    <g>
      {sorted.map((s) => {
        const last = s.points[s.points.length - 1];
        if (!last) return null;
        const x = width - RIGHT_PAD + 6;
        const y = last.cy;
        const truncated =
          s.role.name.length > 12
            ? s.role.name.slice(0, 11) + "…"
            : s.role.name;
        return (
          <g key={s.role.role_id} transform={`translate(${x}, ${y})`}>
            <circle r={3} fill={s.role.color} />
            <text
              x={8}
              y={3}
              fontSize={10}
              fill="rgba(255,255,255,0.85)"
              fontWeight="500"
            >
              {truncated}
            </text>
            {s.role.authority_rank > 0 && (
              <text
                x={8 + truncated.length * 5.5 + 4}
                y={3}
                fontSize={8}
                fill="rgba(255,255,255,0.45)"
              >
                r{s.role.authority_rank}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Append an event to the rolling buffer, keeping only events within the
 * current 30-minute window. Drops anything older than the window so the
 * array stays bounded across long-running sessions.
 */
function appendEvent(prev: ActivityEvent[], ev: ActivityEvent): ActivityEvent[] {
  const cutoff = Date.now() - WINDOW_MINUTES * MS_PER_MIN;
  const next = prev.filter((e) => e.ts >= cutoff);
  next.push(ev);
  return next;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  const mqlRef = useRef<MediaQueryList | null>(null);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    mqlRef.current = mql;
    setReduced(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}
