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
 *                              `compute_tag_relevance`).
 *
 * Window strategy:
 *   - Active quorum -> rolling WINDOW_MINUTES (30 min) ending at "now".
 *   - Resolved quorum -> full lifetime from first contribution to resolved_at
 *     (or last contribution if resolved_at is null), with a "Resolved at" marker.
 *
 * Render modes (stream/bars toggle):
 *   - STREAM: continuous SVG path bands (with mid-canvas braiding for
 *     pair weights > 0.3) — best for high event-density quorums.
 *   - BARS:  stacked bar per bucket, color-segmented by role — best for
 *     sparse quorums where streams look like flat lines.
 *   Default is data-driven on contributions-per-minute; user override
 *   persists in localStorage["riverAffinityViewMode"].
 *
 * Visual layer:
 *   - Bands are tinted by mean affinity (cool / desaturated for outliers,
 *     warm / saturated for aligned roles).
 *   - Silent buckets keep at least MIN_BAND_PX of vertical presence so
 *     quiet roles stay visible on the roster.
 *   - Pair weights render as small chips beside each role label; the
 *     globally-strongest pair is bold-amber.
 *   - Y-axis decoration: rotated "ALIGNMENT WITH QUORUM" label + faint
 *     midline rule.
 *
 * Self-contained: fetches /role-status, /affinity-graph and /state in
 * parallel, polls /affinity-graph every 15s, and subscribes to
 * `contributions` + `a2a_requests` via Supabase realtime.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { DashboardInfo } from "./DashboardInfo";

const RIVER_BLURB =
  "**Agent Affinity — River.** Each colored band is one role; band thickness shows how much that role contributed (messages + A2A requests), and the vertical position shows how aligned that role's tags are with the rest of the quorum — computed server-side. Bands tint warm/cool by mean affinity, braid mid-canvas when pair weights exceed 0.3, and a minimum band height keeps silent roles visible. Toggle between STREAM and BARS; the default chooses bars for sparse quorums (< 1.5 events/min) and stream for dense ones. Resolved quorums show their full lifetime + a 'Resolved at' marker.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiverViewMode = "stream" | "bars";

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
  color: string; // base palette color
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

// Per-role per-bucket aggregate.
interface Bucket {
  activity: number;
  tags: Set<string>;
}

// Plotting representation: one (x, centerY, thickness) point per bucket.
interface RoleSeries {
  role: RoleMeta;
  /** Mean pairwise affinity weight against all peers, in [0,1]. */
  meanAffinity: number;
  /** Effective fill color after affinity tinting. */
  tintedColor: string;
  /** Top 3 pairs by weight, descending. */
  topPairs: { peerId: string; peerName: string; weight: number }[];
  points: { x: number; cy: number; thickness: number; rawActivity: number }[];
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

interface QuorumState {
  status: string;
  resolvedAt: number | null;
  firstContribAt: number | null;
  lastContribAt: number | null;
  totalContributions: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_MINUTES = 30;
const MS_PER_MIN = 60_000;
/** Floor on band thickness so silent roles stay visible (improvement #2). */
const MIN_BAND_PX = 5;
/** Threshold above which two roles' bands braid mid-canvas (improvement #6). */
const BRAID_THRESHOLD = 0.3;
/** Density boundary: bars when contribs/min < this, stream otherwise (#7). */
const DENSITY_BARS_BELOW = 1.5;
const STORAGE_KEY_VIEW_MODE = "riverAffinityViewMode";

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

/** Top-N pairs for a role, sorted by weight desc. */
function topPairsFor(
  roleId: string,
  roles: RoleMeta[],
  weights: EdgeWeightMap,
  n = 3,
): { peerId: string; peerName: string; weight: number }[] {
  const out: { peerId: string; peerName: string; weight: number }[] = [];
  for (const peer of roles) {
    if (peer.role_id === roleId) continue;
    const w = weights.get(pairKey(roleId, peer.role_id));
    if (w === undefined || w <= 0) continue;
    out.push({ peerId: peer.role_id, peerName: peer.name, weight: w });
  }
  out.sort((a, b) => b.weight - a.weight);
  return out.slice(0, n);
}

/** Short truncation used for role-label chips. */
function shortName(name: string, max = 4): string {
  if (!name) return "";
  const trimmed = name.replace(/\b(of|the|and|&)\b/gi, "").trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return name.slice(0, max);
  const first = words[0];
  return first.length <= max ? first : first.slice(0, max);
}

/**
 * Map a normalised affinity score in [0,1] to a tinted RGB color (improvement #1).
 * Low affinity -> cool / desaturated (blue-grey).
 * High affinity -> warm / saturated (orange-red).
 * Used to override the role base color when a backend affinity reading exists.
 */
export function affinityTint(score: number): string {
  const s = Math.max(0, Math.min(1, score));
  // Interpolate from cool blue-grey (rgb 100,116,139) to warm orange (rgb 251,146,60).
  const cool = { r: 100, g: 116, b: 139 };
  const warm = { r: 251, g: 146, b: 60 };
  const r = Math.round(cool.r + (warm.r - cool.r) * s);
  const g = Math.round(cool.g + (warm.g - cool.g) * s);
  const b = Math.round(cool.b + (warm.b - cool.b) * s);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Choose initial view mode based on event density.
 *   density = totalContribs / spanMinutes
 *   < DENSITY_BARS_BELOW -> "bars", else "stream"
 * Spans <= 0 default to "bars" (no data to stream).
 */
export function chooseInitialViewMode(
  totalContribs: number,
  spanMinutes: number,
): RiverViewMode {
  if (spanMinutes <= 0) return "bars";
  const density = totalContribs / spanMinutes;
  return density < DENSITY_BARS_BELOW ? "bars" : "stream";
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
  const [quorumState, setQuorumState] = useState<QuorumState | null>(null);
  /** View mode is null until we know whether to default to stream or bars. */
  const [viewMode, setViewMode] = useState<RiverViewMode | null>(null);
  /** True once the user has manually picked a mode — locks in their choice. */
  const userOverrodeMode = useRef(false);

  // -------------------------------------------------------------------------
  // Hydrate persisted view mode (improvement #7).
  // -------------------------------------------------------------------------
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY_VIEW_MODE);
      if (stored === "stream" || stored === "bars") {
        setViewMode(stored);
        userOverrodeMode.current = true;
      }
    } catch {
      // ignore — SSR or storage disabled
    }
  }, []);

  // -------------------------------------------------------------------------
  // Fetch role list + initial affinity graph + quorum state in parallel.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const base = process.env.NEXT_PUBLIC_API_URL ?? "";
        const [rolesRes, affinityRes, stateRes] = await Promise.all([
          fetch(`${base}/quorums/${quorumId}/role-status`),
          fetch(`${base}/quorums/${quorumId}/affinity-graph`).catch(() => null),
          fetch(`${base}/quorums/${quorumId}/state`).catch(() => null),
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

        if (stateRes && stateRes.ok) {
          try {
            const s = await stateRes.json();
            const q = s?.quorum ?? {};
            const contribs = Array.isArray(s?.contributions)
              ? (s.contributions as Array<{ created_at?: string }>)
              : [];
            const tsList = contribs
              .map((c) =>
                c.created_at ? new Date(c.created_at).getTime() : NaN,
              )
              .filter((t) => Number.isFinite(t)) as number[];
            const qs: QuorumState = {
              status: String(q.status ?? "active"),
              resolvedAt: q.resolved_at
                ? new Date(String(q.resolved_at)).getTime()
                : null,
              firstContribAt: tsList.length ? Math.min(...tsList) : null,
              lastContribAt: tsList.length ? Math.max(...tsList) : null,
              totalContributions: tsList.length,
            };
            if (!cancelled) setQuorumState(qs);
          } catch {
            // ignore — non-fatal, defaults to active/30-min behavior
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
  // 30-second auto-scroll tick (skipped under reduced-motion or when resolved)
  // -------------------------------------------------------------------------
  const isResolved = quorumState?.status === "resolved";
  useEffect(() => {
    if (prefersReducedMotion) return;
    if (isResolved) return; // resolved quorums are static — no need to slide.
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [prefersReducedMotion, isResolved]);

  // -------------------------------------------------------------------------
  // Window bounds (improvement #5: lifetime window when resolved).
  // -------------------------------------------------------------------------
  const windowBounds = useMemo(() => {
    const now = nowMs ?? Date.now();
    if (isResolved && quorumState) {
      const start =
        quorumState.firstContribAt ?? now - WINDOW_MINUTES * MS_PER_MIN;
      const end =
        quorumState.resolvedAt ?? quorumState.lastContribAt ?? now;
      // Pad both ends by one minute so the very first / very last bucket renders.
      const startFloor = floorToMinute(start);
      const endFloor = floorToMinute(end) + MS_PER_MIN;
      const buckets = Math.max(
        2,
        Math.round((endFloor - startFloor) / MS_PER_MIN),
      );
      return {
        start: startFloor,
        end: endFloor,
        buckets,
        resolvedAt:
          quorumState.resolvedAt ?? quorumState.lastContribAt ?? end,
        mode: "lifetime" as const,
      };
    }
    // Rolling window for active quorums.
    void tick; // force recompute every tick so the window slides.
    const end = floorToMinute(now) + MS_PER_MIN;
    const start = end - WINDOW_MINUTES * MS_PER_MIN;
    return {
      start,
      end,
      buckets: WINDOW_MINUTES,
      resolvedAt: null,
      mode: "rolling" as const,
    };
  }, [nowMs, tick, isResolved, quorumState]);

  // -------------------------------------------------------------------------
  // Decide initial viewMode once roles + state + (optional) events are known.
  // Improvement #7 — density-driven default; localStorage overrides.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (viewMode !== null) return;
    if (userOverrodeMode.current) return;
    if (!roles) return;
    // Prefer authoritative state-based count over realtime-buffered events.
    let totalContribs = 0;
    let spanMin = 0;
    if (
      quorumState &&
      quorumState.firstContribAt &&
      quorumState.lastContribAt
    ) {
      totalContribs = quorumState.totalContributions;
      const endTs = quorumState.resolvedAt ?? quorumState.lastContribAt;
      spanMin = Math.max(
        1,
        (endTs - quorumState.firstContribAt) / MS_PER_MIN,
      );
    } else {
      totalContribs = events.length;
      spanMin = WINDOW_MINUTES;
    }
    setViewMode(chooseInitialViewMode(totalContribs, spanMin));
  }, [roles, quorumState, events.length, viewMode]);

  // -------------------------------------------------------------------------
  // Derived: bucket events per role, compute series points
  // -------------------------------------------------------------------------
  const series = useMemo(() => {
    if (!roles || roles.length === 0) return [] as RoleSeries[];

    const { start, buckets: nBuckets } = windowBounds;

    // role_id -> bucket index -> bucket
    const byRole = new Map<string, Bucket[]>();
    for (const r of roles) {
      byRole.set(
        r.role_id,
        Array.from({ length: nBuckets }, () => ({
          activity: 0,
          tags: new Set<string>(),
        })),
      );
    }

    for (const ev of events) {
      const idx = Math.floor((floorToMinute(ev.ts) - start) / MS_PER_MIN);
      if (idx < 0 || idx >= nBuckets) continue;
      const arr = byRole.get(ev.role_id);
      if (!arr) continue;
      arr[idx].activity += ev.weight;
      ev.tags.forEach((t) => arr[idx].tags.add(t));
    }

    // Project to (x, cy, thickness).
    const usableW = width - LEFT_PAD - RIGHT_PAD;
    const cyMid = height / 2;
    const halfH = (height - TOP_PAD - BOTTOM_PAD) / 2;

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
      const bucketArr = byRole.get(r.role_id)!;
      // Deterministic per-role bias keeps lanes visually distinct even when
      // their alignment values are near-identical (avoids overlapping bands).
      const bias =
        ((roleIdx - (roles.length - 1) / 2) / Math.max(roles.length, 1)) *
        halfH *
        0.4;
      const align = alignByRole.get(r.role_id) ?? 0;
      const points = bucketArr.map((b, i) => {
        // Aligned roles hover near center; outliers drift outward.
        const offset = (1 - align) * halfH * 0.55;
        const cy = cyMid + bias + (roleIdx % 2 === 0 ? -offset : offset);
        const x =
          LEFT_PAD +
          (nBuckets <= 1 ? 0 : (i / (nBuckets - 1)) * usableW);
        // Each activity unit adds ~3.5 px to the band thickness, capped.
        // Floor at MIN_BAND_PX so silent buckets stay visible (#2).
        const rawThickness = Math.min(28, b.activity * 3.5);
        const thickness = Math.max(MIN_BAND_PX, rawThickness);
        return { x, cy, thickness, rawActivity: b.activity };
      });
      out.push({
        role: r,
        meanAffinity: align,
        tintedColor: align > 0 ? affinityTint(align) : r.color,
        topPairs: topPairsFor(r.role_id, roles, edgeWeights, 3),
        points,
      });
      roleIdx++;
    }
    return out;
  }, [roles, events, windowBounds, width, height, edgeWeights]);

  // -------------------------------------------------------------------------
  // Braiding plan (improvement #6) — for each pair > BRAID_THRESHOLD, plan
  // a swap of centerlines across the middle third of the canvas, then back.
  // -------------------------------------------------------------------------
  const braidPlan = useMemo(() => {
    if (!roles || roles.length < 2) return [] as Array<[string, string]>;
    const out: Array<[string, string]> = [];
    for (let i = 0; i < roles.length; i++) {
      for (let j = i + 1; j < roles.length; j++) {
        const a = roles[i].role_id;
        const b = roles[j].role_id;
        const w = edgeWeights.get(pairKey(a, b)) ?? 0;
        if (w > BRAID_THRESHOLD) out.push([a, b]);
      }
    }
    return out;
  }, [roles, edgeWeights]);

  // Apply braiding by morphing centerline points in the middle 40% of x range.
  const braidedSeries = useMemo<RoleSeries[]>(() => {
    if (viewMode === "bars") return series; // braiding is stream-only
    if (braidPlan.length === 0) return series;
    // Group by lower-index role so each role only swaps with at most one peer
    // per render (avoids unreadable rope-knots).
    const swaps = new Map<string, string>();
    for (const [a, b] of braidPlan) {
      if (!swaps.has(a) && !swaps.has(b)) {
        swaps.set(a, b);
        swaps.set(b, a);
      }
    }
    if (swaps.size === 0) return series;

    const idxOf = new Map<string, number>();
    series.forEach((s, i) => idxOf.set(s.role.role_id, i));

    const xs = series[0]?.points.map((p) => p.x) ?? [];
    const minX = xs[0] ?? 0;
    const maxX = xs[xs.length - 1] ?? 1;
    const span = maxX - minX || 1;
    const braidStart = minX + span * 0.3;
    const braidEnd = minX + span * 0.7;

    // Pure functional rebuild to keep the original arrays untouched.
    const result: RoleSeries[] = series.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ ...p })),
    }));

    swaps.forEach((peerId, roleId) => {
      // Only process each pair once (lower id key).
      if (roleId >= peerId) return;
      const aIdx = idxOf.get(roleId);
      const bIdx = idxOf.get(peerId);
      if (aIdx === undefined || bIdx === undefined) return;
      const A = result[aIdx];
      const B = result[bIdx];
      for (let i = 0; i < A.points.length; i++) {
        const pA = A.points[i];
        const pB = B.points[i];
        // ease factor in [0,1] = 1 inside braid window, 0 outside.
        let t = 0;
        if (pA.x >= braidStart && pA.x <= braidEnd) {
          const localSpan = braidEnd - braidStart;
          const phase = ((pA.x - braidStart) / localSpan) * Math.PI;
          t = Math.sin(phase); // 0 -> 1 -> 0
        }
        const origA = pA.cy;
        const origB = pB.cy;
        pA.cy = origA + (origB - origA) * t;
        pB.cy = origB + (origA - origB) * t;
      }
    });

    return result;
  }, [series, braidPlan, viewMode]);

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
    (s, r) => s + r.points.reduce((p, pt) => p + pt.rawActivity, 0),
    0,
  );
  const isSparse = totalActivity < 0.5;
  const nowX = width - RIGHT_PAD;
  const effectiveMode: RiverViewMode = viewMode ?? "stream";

  function pickMode(next: RiverViewMode) {
    userOverrodeMode.current = true;
    setViewMode(next);
    try {
      window.localStorage.setItem(STORAGE_KEY_VIEW_MODE, next);
    } catch {
      // ignore
    }
  }

  const headerLabel = isResolved ? "full lifetime" : `last ${WINDOW_MINUTES}m`;

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
        <div className="flex items-center gap-2">
          {/* Stream/Bars toggle (#7) */}
          <div className="flex items-center rounded border border-white/10 overflow-hidden">
            <button
              type="button"
              onClick={() => pickMode("stream")}
              data-testid="river-view-mode-stream"
              aria-pressed={effectiveMode === "stream"}
              className={`text-[10px] uppercase tracking-widest px-1.5 py-0.5 transition-colors ${
                effectiveMode === "stream"
                  ? "bg-white/15 text-white/90"
                  : "text-white/40 hover:text-white/70"
              }`}
              title="Stream view (continuous bands)"
            >
              Stream
            </button>
            <button
              type="button"
              onClick={() => pickMode("bars")}
              data-testid="river-view-mode-bars"
              aria-pressed={effectiveMode === "bars"}
              className={`text-[10px] uppercase tracking-widest px-1.5 py-0.5 transition-colors ${
                effectiveMode === "bars"
                  ? "bg-white/15 text-white/90"
                  : "text-white/40 hover:text-white/70"
              }`}
              title="Bars view (stacked bar per minute)"
            >
              Bars
            </button>
          </div>
          <span className="text-[10px] text-white/30">
            {headerLabel}
            {prefersReducedMotion && " · static"}
          </span>
        </div>
      </div>

      {/* SVG canvas */}
      <div className="relative flex-1 min-h-0">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-full w-full"
          aria-label="Agent affinity river streamgraph"
        >
          {/* Y-axis label + midline (#4) */}
          <YAxisDecor width={width} height={height} />

          {/* Background grid: vertical guides */}
          <GridLines
            width={width}
            height={height}
            buckets={windowBounds.buckets}
          />

          {/* Bands or bars */}
          {effectiveMode === "stream" ? (
            braidedSeries.map((s) => (
              <RiverBand key={s.role.role_id} series={s} />
            ))
          ) : (
            <StackedBars
              series={series}
              width={width}
              height={height}
              buckets={windowBounds.buckets}
            />
          )}

          {/* "now" or "resolved at" marker */}
          {isResolved ? (
            <ResolvedMarker
              xPos={nowX}
              height={height}
              resolvedAt={windowBounds.resolvedAt ?? null}
            />
          ) : (
            <NowMarker xPos={nowX} height={height} />
          )}

          {/* Role labels pinned to the right edge */}
          <RoleLabels series={braidedSeries} width={width} />
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

const LEFT_PAD = 28; // a touch wider to host the y-axis label
const RIGHT_PAD = 180; // reserve room for role labels + edge-weight chips
const TOP_PAD = 20;
const BOTTOM_PAD = 12;

function GridLines({
  width,
  height,
  buckets,
}: {
  width: number;
  height: number;
  buckets: number;
}) {
  const lines: React.ReactElement[] = [];
  const usableW = width - LEFT_PAD - RIGHT_PAD;
  // Aim for ~6 evenly spaced vertical guides regardless of bucket count.
  const step = Math.max(1, Math.round(buckets / 6));
  for (let m = 0; m < buckets; m += step) {
    const x =
      LEFT_PAD + (buckets <= 1 ? 0 : (m / (buckets - 1)) * usableW);
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

/** Rotated y-axis label + faint midline rule (improvement #4). */
function YAxisDecor({ width, height }: { width: number; height: number }) {
  const midY = (TOP_PAD + (height - BOTTOM_PAD)) / 2;
  return (
    <g data-testid="river-y-axis-decor">
      <line
        x1={LEFT_PAD}
        x2={width - RIGHT_PAD}
        y1={midY}
        y2={midY}
        stroke="rgba(255,255,255,0.10)"
        strokeWidth={1}
        strokeDasharray="2 4"
      />
      <text
        transform={`translate(10, ${midY}) rotate(-90)`}
        textAnchor="middle"
        fontSize={9}
        fill="rgba(255,255,255,0.35)"
        letterSpacing="0.08em"
      >
        ALIGNMENT WITH QUORUM
      </text>
    </g>
  );
}

function RiverBand({ series }: { series: RoleSeries }) {
  const { points, tintedColor, role } = series;
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
      fill={tintedColor}
      fillOpacity={0.5}
      stroke={role.color}
      strokeOpacity={0.7}
      strokeWidth={0.75}
    />
  );
}

/** BARS mode: stacked vertical bar per bucket, color-segmented by role. */
function StackedBars({
  series,
  width,
  height,
  buckets,
}: {
  series: RoleSeries[];
  width: number;
  height: number;
  buckets: number;
}) {
  if (series.length === 0 || buckets === 0) return null;
  const usableW = width - LEFT_PAD - RIGHT_PAD;
  const baseY = height - BOTTOM_PAD;
  const usableH = baseY - TOP_PAD;
  const colWidth = Math.max(2, (usableW / buckets) * 0.7);

  // Peak activity across all buckets sets the vertical scale.
  let peak = 0;
  for (let i = 0; i < buckets; i++) {
    let total = 0;
    for (const s of series) total += s.points[i]?.rawActivity ?? 0;
    if (total > peak) peak = total;
  }
  const pxPerUnit = peak > 0 ? Math.min(usableH / peak, 32) : 0;

  const rects: React.ReactElement[] = [];
  for (let i = 0; i < buckets; i++) {
    const x =
      LEFT_PAD +
      (buckets <= 1 ? usableW / 2 : (i / (buckets - 1)) * usableW) -
      colWidth / 2;
    let cursorY = baseY;
    for (const s of series) {
      const activity = s.points[i]?.rawActivity ?? 0;
      const h =
        activity > 0
          ? Math.max(MIN_BAND_PX * 0.6, activity * pxPerUnit)
          : 1.5; // ghost line so silent roles register on the bar baseline
      cursorY -= h;
      rects.push(
        <rect
          key={`${i}-${s.role.role_id}`}
          x={x}
          y={cursorY}
          width={colWidth}
          height={h}
          fill={activity > 0 ? s.tintedColor : s.role.color}
          fillOpacity={activity > 0 ? 0.75 : 0.18}
          stroke={s.role.color}
          strokeOpacity={0.5}
          strokeWidth={0.4}
        />,
      );
    }
  }
  return <g data-testid="river-bars">{rects}</g>;
}

function NowMarker({ xPos, height }: { xPos: number; height: number }) {
  return (
    <g>
      <line
        x1={xPos}
        x2={xPos}
        y1={TOP_PAD}
        y2={height - BOTTOM_PAD}
        stroke="rgba(255,255,255,0.5)"
        strokeWidth={1}
        strokeDasharray="4 3"
      />
      <text
        x={xPos - 4}
        y={TOP_PAD + 10}
        textAnchor="end"
        fontSize={9}
        fill="rgba(255,255,255,0.4)"
      >
        now
      </text>
    </g>
  );
}

function ResolvedMarker({
  xPos,
  height,
  resolvedAt,
}: {
  xPos: number;
  height: number;
  resolvedAt: number | null;
}) {
  const hhmm = resolvedAt
    ? new Date(resolvedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
  return (
    <g data-testid="river-resolved-marker">
      <line
        x1={xPos}
        x2={xPos}
        y1={TOP_PAD}
        y2={height - BOTTOM_PAD}
        stroke="rgba(248,113,113,0.7)"
        strokeWidth={1.25}
        strokeDasharray="3 2"
      />
      <text
        x={xPos - 4}
        y={TOP_PAD + 10}
        textAnchor="end"
        fontSize={9}
        fill="rgba(248,113,113,0.85)"
        fontWeight="600"
      >
        Resolved {hhmm}
      </text>
    </g>
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

  // Distribute label rows vertically when many roles cluster on similar Y.
  const minRowGap = 22;
  const rows: number[] = [];
  sorted.forEach((s, i) => {
    const desired =
      s.points[s.points.length - 1]?.cy ?? TOP_PAD + i * minRowGap;
    const prev = rows[i - 1];
    rows[i] = prev !== undefined ? Math.max(desired, prev + minRowGap) : desired;
  });

  // Identify the global top pair-weight so we can bold it across all rows.
  let globalMax = 0;
  sorted.forEach((s) => {
    if (s.topPairs[0] && s.topPairs[0].weight > globalMax) {
      globalMax = s.topPairs[0].weight;
    }
  });

  return (
    <g data-testid="river-role-labels">
      {sorted.map((s, i) => {
        const x = width - RIGHT_PAD + 6;
        const y = rows[i];
        const truncated =
          s.role.name.length > 14
            ? s.role.name.slice(0, 13) + "…"
            : s.role.name;
        return (
          <g key={s.role.role_id} transform={`translate(${x}, ${y})`}>
            <circle r={3} fill={s.tintedColor} />
            <text
              x={8}
              y={3}
              fontSize={10}
              fill="rgba(255,255,255,0.85)"
              fontWeight="500"
            >
              {truncated}
            </text>
            {/* Edge-weight chips (#3) */}
            <PairChips pairs={s.topPairs} globalMax={globalMax} y={14} />
          </g>
        );
      })}
    </g>
  );
}

function PairChips({
  pairs,
  globalMax,
  y,
}: {
  pairs: RoleSeries["topPairs"];
  globalMax: number;
  y: number;
}) {
  if (!pairs || pairs.length === 0) return null;
  let cursorX = 8;
  return (
    <g data-testid="river-pair-chips">
      {pairs.map((p) => {
        const isTop = globalMax > 0 && Math.abs(p.weight - globalMax) < 1e-6;
        const label = `${shortName(p.peerName)} ${p.weight.toFixed(2)}`;
        const w = label.length * 5.2 + 8;
        const chip = (
          <g key={p.peerId} transform={`translate(${cursorX}, ${y})`}>
            <rect
              x={0}
              y={-7}
              width={w}
              height={10}
              rx={2}
              fill="rgba(255,255,255,0.08)"
              stroke="rgba(255,255,255,0.12)"
              strokeWidth={0.5}
            />
            <text
              x={4}
              y={1}
              fontSize={8}
              fill={isTop ? "rgba(251,191,36,0.95)" : "rgba(255,255,255,0.7)"}
              fontWeight={isTop ? "700" : "400"}
            >
              {label}
            </text>
          </g>
        );
        cursorX += w + 3;
        return chip;
      })}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Append an event to the rolling buffer. For active quorums (the common
 * realtime path) we drop anything older than the rolling window. Resolved
 * quorums never accept new realtime events in practice, so this bound is fine.
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
