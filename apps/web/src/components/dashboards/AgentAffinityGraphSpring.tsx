"use client";

/**
 * AgentAffinityGraphSpring — Spring-physics + activity-heatmap variant of the
 * agent affinity dashboard.
 *
 * Top 70%: live spring-simulated graph. Each role is a circle; positions
 *          re-target every 2 s based on the pairwise affinity weights
 *          returned by the backend `/quorums/{id}/affinity-graph` endpoint
 *          (word-level overlap via `compute_tag_relevance`). Nodes whose
 *          weights are high pull toward each other; pairs without an edge
 *          in the response have no force between them. Authority rank →
 *          node "mass" → spring inertia (heavier nodes resist motion).
 *          Animation uses Framer Motion's built-in spring transition.
 *
 *          The faint dashed circle is the "equilibrium ring" — the layout
 *          each node would occupy with zero spring force. Visible deviation
 *          from the ring is the spring pull.
 *
 *          Node radius is interpolated from contributions_count so the most
 *          active role visibly dominates. Edge stroke width is proportional
 *          to the backend weight, with the numeric value labeled at each
 *          midpoint so the dashboard doubles as a live readout of the
 *          underlying affinity matrix.
 *
 * Bottom 30%: 60 s activity heatmap with a play/scrub control that replays
 *             the contribution timeline. On resolved quorums the realtime
 *             channel never fires, so without playback the strip would be
 *             permanently empty. Rows = roles (sorted by authority_rank
 *             desc), columns = 12 x 5 s buckets. Cell intensity = combined
 *             contribution / station_message / agent_request count.
 *
 * When a new agent_request arrives, an SVG comet animates from source → target.
 *
 * Self-contained: takes only { quorumId } as a prop. Fetches its own data
 * from /quorums/{id}/role-status, /quorums/{id}/affinity-graph, and
 * /quorums/{id}/state (REST) and subscribes to Supabase realtime channels for
 * `contributions`, `station_messages`, and `agent_requests`. Renders a
 * "connecting…" state when data is unavailable.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { motion, useReducedMotion } from "framer-motion";
import { DashboardInfo } from "./DashboardInfo";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 560;
const PANEL_HEIGHT = 420;
const SPRING_PANEL_HEIGHT = Math.round(PANEL_HEIGHT * 0.7);
const HEATMAP_PANEL_HEIGHT = PANEL_HEIGHT - SPRING_PANEL_HEIGHT;
/** Default ring-layout node radius; per-node radius scales from min→max
 *  based on contributions_count. */
const NODE_RADIUS = 22;
const NODE_RADIUS_MIN = 14;
const NODE_RADIUS_MAX = 34;
/** contributions_count value at/above which a node renders at NODE_RADIUS_MAX. */
const NODE_SCALE_CAP = 10;
const RETARGET_INTERVAL_MS = 2000;
const HEATMAP_BUCKET_MS = 5000;
const HEATMAP_BUCKET_COUNT = 12;
const HEATMAP_WINDOW_MS = HEATMAP_BUCKET_MS * HEATMAP_BUCKET_COUNT;
const COMET_DURATION_MS = 1400;
/** How often to poll the backend `/affinity-graph` endpoint for refreshed
 *  pairwise weights. */
const AFFINITY_REFRESH_MS = 15_000;
/** Target effective spring force for the strongest pair, so even small
 *  raw weights (~0.13–0.42) produce visible node movement. We normalize the
 *  max edge weight to this value when computing pulls. */
const MAX_SPRING_FORCE = 0.8;
/** Backend default placeholder color used when no explicit role color was
 *  assigned. Treated as "no color" so we apply the fallback palette. */
const SLATE_DEFAULT_COLOR = "#94a3b8";
/** Scrubber tick rate while playing back the contribution timeline. */
const SCRUB_TICK_MS = 200;
/** Wall-clock duration to replay the full contribution window. */
const SCRUB_PLAYBACK_DURATION_MS = 30_000;

const AFFINITY_SPRING_BLURB =
  "**Agent Affinity (Spring + Heatmap).** Each circle is an AI role sized by `contributions_count`; nodes drift via a spring simulation toward neighbours with the highest backend-computed affinity. Edge thickness and the midpoint label show the pairwise weight. The dashed ring is the zero-spring equilibrium layout — visible deviation = spring pull. The activity strip below replays the contribution timeline via the scrub control; cell intensity = combined station messages + agent-to-agent requests in that 5 s bucket. Comets show live A2A traffic.";

// Fallback colour palette used when a role has no explicit colour (or the
// backend returned the slate-grey default).
const FALLBACK_COLORS = [
  "#60a5fa",
  "#34d399",
  "#f472b6",
  "#fbbf24",
  "#a78bfa",
  "#22d3ee",
  "#fb923c",
  "#f87171",
  "#4ade80",
  "#c084fc",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoleStatusRow {
  role_id: string;
  name: string;
  status?: string;
  contributions_count?: number;
  blocked_by_names?: string[];
  authority_rank?: number;
  /** Persona's persistent domain_tags (from agent_configs). Used as the
   *  baseline tag set so affinity has signal before any contributions arrive. */
  domain_tags?: string[];
}

interface RoleNode {
  id: string;
  name: string;
  authorityRank: number;
  color: string;
  /** Number of contributions this role has made. Drives node radius. */
  contributionsCount: number;
  /** Persona's persistent domain_tags — used for the hover tooltip. */
  domainTags: string[];
}

interface ContributionRow {
  id: string;
  quorum_id: string;
  role_id: string;
  content: string;
  created_at: string;
}

interface ActivityEvent {
  ts: number;
  roleId: string;
}

interface A2ARequestRow {
  id: string;
  quorum_id: string;
  from_role_id: string;
  to_role_id: string;
  created_at?: string;
}

interface Comet {
  id: string;
  fromId: string;
  toId: string;
  startedAt: number;
}

interface Vec2 {
  x: number;
  y: number;
}

/** Edge returned by the backend `/affinity-graph` endpoint. */
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
export type EdgeWeightMap = Map<string, number>;

// ---------------------------------------------------------------------------
// Helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const TAG_RE = /\[tags?:\s*([^\]]+)\]/gi;

/** Parse `[tags: a, b, c]` blocks out of a contribution body. */
export function extractTagsFromContent(content: string): string[] {
  if (!content) return [];
  const tags: string[] = [];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(content)) !== null) {
    for (const raw of m[1].split(",")) {
      const t = raw.trim().toLowerCase();
      if (t) tags.push(t);
    }
  }
  return tags;
}

/** Jaccard similarity between two tag arrays (treated as sets).
 *
 *  Retained as an exported helper because the unit-test suite covers it
 *  directly. The component itself no longer uses Jaccard for affinity —
 *  pairwise weights come from the backend `/affinity-graph` endpoint. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  sa.forEach((t) => {
    if (sb.has(t)) inter += 1;
  });
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Stable ordering for two role ids to use as a pair-key in the weight map. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Resolve the displayable color for a role.
 *
 * The backend currently leaves `roles.color` null on auto-promoted personas,
 * which the `/affinity-graph` endpoint surfaces as the slate placeholder
 * `#94a3b8`. When all roles share that placeholder the nodes are
 * indistinguishable, so we fall back to a stable palette indexed by the
 * role's position so the same role always gets the same color across
 * re-renders.
 */
export function resolveRoleColor(
  rawColor: string | null | undefined,
  index: number,
): string {
  const trimmed = (rawColor ?? "").trim().toLowerCase();
  if (!trimmed || trimmed === SLATE_DEFAULT_COLOR.toLowerCase()) {
    return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
  }
  return rawColor as string;
}

/**
 * Map a `contributions_count` to a render radius in
 * [NODE_RADIUS_MIN, NODE_RADIUS_MAX]. Counts above NODE_SCALE_CAP are
 * clamped to the max so a single noisy role can't dominate the canvas.
 */
export function radiusForContributions(count: number): number {
  const c = Math.max(0, Math.min(NODE_SCALE_CAP, count));
  const t = c / NODE_SCALE_CAP;
  return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * t;
}

/** Even ring layout positions for the given roles. */
function ringLayout(roleIds: string[], cx: number, cy: number, radius: number): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  const n = Math.max(1, roleIds.length);
  roleIds.forEach((id, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    out.set(id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });
  return out;
}

/**
 * Recompute target positions for each role.
 *
 * Start from the ring layout, then apply a single relaxation pass where
 * every pair of roles nudges toward each other proportional to the
 * backend-computed affinity weight (word-level overlap via
 * `compute_tag_relevance`, served by `/quorums/{id}/affinity-graph`).
 *
 * Pulls are normalized so the strongest edge produces MAX_SPRING_FORCE units
 * of pull. With realistic backend payloads (max ~0.42) this is roughly a
 * 6x multiplier on the previous `sim * 0.4` calculation — enough to clearly
 * visualize the strongest affinity pair without collapsing the graph.
 */
export function computeTargetPositions(
  roles: RoleNode[],
  weights: EdgeWeightMap,
  cx: number,
  cy: number,
  radius: number,
): Map<string, Vec2> {
  const ids = roles.map((r) => r.id);
  const ring = ringLayout(ids, cx, cy, radius);
  if (roles.length < 2) return ring;

  let maxWeight = 0;
  weights.forEach((w) => {
    if (w > maxWeight) maxWeight = w;
  });
  const scale = maxWeight > 0 ? MAX_SPRING_FORCE / maxWeight : 0;

  const pulls = new Map<string, Vec2>();
  for (const id of ids) pulls.set(id, { x: 0, y: 0 });

  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      const a = roles[i];
      const b = roles[j];
      const sim = weights.get(pairKey(a.id, b.id)) ?? 0;
      if (sim <= 0) continue;
      const pa = ring.get(a.id)!;
      const pb = ring.get(b.id)!;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const k = sim * scale;
      pulls.get(a.id)!.x += dx * k;
      pulls.get(a.id)!.y += dy * k;
      pulls.get(b.id)!.x -= dx * k;
      pulls.get(b.id)!.y -= dy * k;
    }
  }

  const out = new Map<string, Vec2>();
  for (const id of ids) {
    const base = ring.get(id)!;
    const pull = pulls.get(id)!;
    out.set(id, { x: base.x + pull.x, y: base.y + pull.y });
  }
  return out;
}

function clampActivity(n: number): number {
  return Math.max(0, Math.min(8, n));
}

function authorityToMass(rank: number): number {
  // Mass 0.5 (light = fast) .. 3 (heavy = slow). Default rank 0 → mass 1.
  return Math.max(0.5, Math.min(3, 1 + rank * 0.2));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface AgentAffinityGraphSpringProps {
  quorumId: string;
}

export function AgentAffinityGraphSpring({ quorumId }: AgentAffinityGraphSpringProps) {
  const reduceMotion = useReducedMotion();

  const [roles, setRoles] = useState<RoleNode[]>([]);
  const [connState, setConnState] = useState<"connecting" | "ready" | "error">("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  /** Activity events (station_messages + agent_requests) for the heatmap. */
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  /** Active comets to animate. */
  const [comets, setComets] = useState<Comet[]>([]);
  /** Re-render trigger for heatmap cell aging. */
  const [, forceTick] = useState(0);
  /** Pairwise affinity weights from the backend `/affinity-graph` endpoint,
   *  keyed by `pairKey(a, b)`. Polled every 15s to track ongoing changes. */
  const [edgeWeights, setEdgeWeights] = useState<EdgeWeightMap>(
    () => new Map<string, number>(),
  );
  /** Historical contributions for the scrubber playback. Loaded once on
   *  mount from /quorums/{id}/state and sorted by `created_at` asc. The
   *  realtime channel still drives the live heatmap; scrubber playback is
   *  layered on top so users can replay activity on resolved quorums where
   *  no live events fire. */
  const [historicalActivity, setHistoricalActivity] = useState<ActivityEvent[]>([]);
  /** Playback controls for the activity scrubber. `progress` is in [0,1]
   *  over the contribution timeline. Persisted in refs so the play loop can
   *  read the latest value without retriggering the interval effect. */
  const [isPlaying, setIsPlaying] = useState(false);
  const [scrubProgress, setScrubProgress] = useState(0);
  const scrubProgressRef = useRef(0);
  scrubProgressRef.current = scrubProgress;

  // -------------------------------------------------------------------------
  // Fetch the role list (REST) + enrich with authority_rank / color via supabase
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    if (!quorumId) return;

    async function load() {
      const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
      let baseList: RoleStatusRow[] = [];

      try {
        // Parallel fetch: role-status drives the node roster, affinity-graph
        // seeds the pairwise weights used by the spring sim. Affinity-graph
        // failure is non-fatal — nodes fall back to the ring layout.
        const [rolesRes, affinityRes] = await Promise.all([
          fetch(`${apiBase}/quorums/${quorumId}/role-status`),
          fetch(`${apiBase}/quorums/${quorumId}/affinity-graph`).catch(
            () => null,
          ),
        ]);
        if (!rolesRes.ok) throw new Error(`HTTP ${rolesRes.status}`);
        baseList = (await rolesRes.json()) as RoleStatusRow[];

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
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : "fetch failed");
        setConnState("error");
        return;
      }

      // Best-effort enrichment.
      let enriched: Record<string, { authority_rank: number; color: string }> = {};
      try {
        const { supabase } = await import("@/lib/supabase");
        const { data } = await supabase
          .from("roles")
          .select("id, authority_rank, color")
          .eq("quorum_id", quorumId);
        if (data) {
          for (const r of data as Array<{ id: string; authority_rank: number; color: string }>) {
            enriched[r.id] = { authority_rank: r.authority_rank ?? 0, color: r.color ?? "" };
          }
        }
      } catch {
        enriched = {};
      }

      if (cancelled) return;
      const built: RoleNode[] = baseList.map((r, i) => {
        const meta = enriched[r.role_id];
        return {
          id: r.role_id,
          name: r.name,
          authorityRank: meta?.authority_rank ?? r.authority_rank ?? 0,
          color: resolveRoleColor(meta?.color, i),
          contributionsCount: r.contributions_count ?? 0,
          domainTags: r.domain_tags ?? [],
        };
      });
      setRoles(built);
      setConnState("ready");
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [quorumId]);

  // -------------------------------------------------------------------------
  // Realtime subscriptions (best-effort — failures leave the panel usable).
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!quorumId) return;
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    (async () => {
      try {
        const { supabase } = await import("@/lib/supabase");
        if (cancelled) return;

        const contribChan = supabase
          .channel(`affinity-spring-contribs-${quorumId}`)
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "contributions", filter: `quorum_id=eq.${quorumId}` },
            (payload) => {
              const row = payload.new as ContributionRow;
              if (!row.role_id) return;
              setActivity((prev) => [
                ...prev,
                { ts: Date.now(), roleId: row.role_id },
              ]);
            },
          )
          .subscribe();

        const stationChan = supabase
          .channel(`affinity-spring-station-${quorumId}`)
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "station_messages", filter: `quorum_id=eq.${quorumId}` },
            (payload) => {
              const row = payload.new as { role_id?: string };
              if (!row.role_id) return;
              setActivity((prev) => [...prev, { ts: Date.now(), roleId: row.role_id! }]);
            },
          )
          .subscribe();

        const a2aChan = supabase
          .channel(`affinity-spring-a2a-${quorumId}`)
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "agent_requests", filter: `quorum_id=eq.${quorumId}` },
            (payload) => {
              const row = payload.new as A2ARequestRow;
              if (!row.from_role_id || !row.to_role_id) return;
              setActivity((prev) => [
                ...prev,
                { ts: Date.now(), roleId: row.from_role_id },
                { ts: Date.now(), roleId: row.to_role_id },
              ]);
              setComets((prev) => [
                ...prev.slice(-7),
                { id: row.id, fromId: row.from_role_id, toId: row.to_role_id, startedAt: Date.now() },
              ]);
            },
          )
          .subscribe();

        cleanups.push(() => supabase.removeChannel(contribChan));
        cleanups.push(() => supabase.removeChannel(stationChan));
        cleanups.push(() => supabase.removeChannel(a2aChan));
      } catch {
        // Supabase unavailable — realtime off, panel still works.
      }
    })();

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => {
        try {
          fn();
        } catch {
          /* ignore */
        }
      });
    };
  }, [quorumId]);

  // -------------------------------------------------------------------------
  // Periodic ticks: prune old activity + comets, re-render heatmap.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      const cutoff = Date.now() - HEATMAP_WINDOW_MS - 2000;
      setActivity((prev) => (prev.length > 0 && prev[0].ts < cutoff ? prev.filter((e) => e.ts >= cutoff) : prev));
      setComets((prev) => prev.filter((c) => Date.now() - c.startedAt < COMET_DURATION_MS + 200));
      forceTick((n) => (n + 1) % 1_000_000);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // -------------------------------------------------------------------------
  // Periodically refresh the backend affinity weights so the spring sim
  // keeps reflecting changes as new contributions arrive on the server.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!quorumId) return;
    if (roles.length === 0) return;
    let cancelled = false;
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    const refresh = async () => {
      try {
        const res = await fetch(
          `${apiBase}/quorums/${quorumId}/affinity-graph`,
        );
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
    const id = setInterval(refresh, AFFINITY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [quorumId, roles]);

  // -------------------------------------------------------------------------
  // Load historical contributions once so the scrubber can replay them.
  // /quorums/{id}/state returns contributions ordered by created_at asc.
  // On resolved quorums no realtime events ever fire, so without this fetch
  // the activity strip is permanently empty.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!quorumId) return;
    let cancelled = false;
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    (async () => {
      try {
        const res = await fetch(
          `${apiBase}/quorums/${quorumId}/state?limit=500`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          contributions?: Array<{ role_id: string; created_at: string }>;
        };
        if (cancelled) return;
        const events: ActivityEvent[] = [];
        for (const c of body.contributions ?? []) {
          if (!c.role_id || !c.created_at) continue;
          const t = Date.parse(c.created_at);
          if (Number.isNaN(t)) continue;
          events.push({ ts: t, roleId: c.role_id });
        }
        events.sort((a, b) => a.ts - b.ts);
        setHistoricalActivity(events);
      } catch {
        // Non-fatal — scrubber will just be a no-op.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [quorumId]);

  // -------------------------------------------------------------------------
  // Scrubber play loop. Persists across rerenders via refs so toggling
  // play/pause doesn't lose position.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!isPlaying) return;
    const stepPerTick = SCRUB_TICK_MS / SCRUB_PLAYBACK_DURATION_MS;
    const id = setInterval(() => {
      const next = scrubProgressRef.current + stepPerTick;
      if (next >= 1) {
        scrubProgressRef.current = 1;
        setScrubProgress(1);
        setIsPlaying(false);
        return;
      }
      scrubProgressRef.current = next;
      setScrubProgress(next);
    }, SCRUB_TICK_MS);
    return () => clearInterval(id);
  }, [isPlaying]);

  /** Toggle play/pause. If playback already finished, restart from 0. */
  const onTogglePlay = useCallback(() => {
    setIsPlaying((prev) => {
      if (!prev && scrubProgressRef.current >= 1) {
        scrubProgressRef.current = 0;
        setScrubProgress(0);
      }
      return !prev;
    });
  }, []);

  const onScrubChange = useCallback((next: number) => {
    const v = Math.max(0, Math.min(1, next));
    scrubProgressRef.current = v;
    setScrubProgress(v);
  }, []);

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------
  const cx = PANEL_WIDTH / 2;
  const cy = SPRING_PANEL_HEIGHT / 2;
  const radius = Math.min(PANEL_WIDTH, SPRING_PANEL_HEIGHT) / 2 - NODE_RADIUS - 20;

  const [targets, setTargets] = useState<Map<string, Vec2>>(new Map());

  useEffect(() => {
    if (roles.length === 0) return;
    const compute = () => {
      setTargets(computeTargetPositions(roles, edgeWeights, cx, cy, radius));
    };
    compute();
    const id = setInterval(compute, RETARGET_INTERVAL_MS);
    return () => clearInterval(id);
  }, [roles, edgeWeights, cx, cy, radius]);

  // -------------------------------------------------------------------------
  // Heatmap bucketization. Merges live realtime events with the scrubbed
  // historical timeline. The scrubber maps progress [0,1] over the
  // contribution time range to a virtual "playhead" time; events on or
  // before that playhead are rebucketed by their offset from the playhead
  // so they appear naturally in the 60s window.
  // -------------------------------------------------------------------------
  const historicalRange = useMemo(() => {
    if (historicalActivity.length === 0) return null;
    const start = historicalActivity[0].ts;
    const end = historicalActivity[historicalActivity.length - 1].ts;
    return { start, end, span: Math.max(1, end - start) };
  }, [historicalActivity]);

  const heatmap = useMemo(() => {
    const now = Date.now();
    const buckets = new Map<string, number[]>();
    for (const r of roles) buckets.set(r.id, new Array(HEATMAP_BUCKET_COUNT).fill(0));

    // Live activity (real-time wallclock).
    for (const ev of activity) {
      const age = now - ev.ts;
      if (age < 0 || age > HEATMAP_WINDOW_MS) continue;
      const idx = HEATMAP_BUCKET_COUNT - 1 - Math.floor(age / HEATMAP_BUCKET_MS);
      if (idx < 0 || idx >= HEATMAP_BUCKET_COUNT) continue;
      const arr = buckets.get(ev.roleId);
      if (arr) arr[idx] += 1;
    }

    // Scrubbed historical activity. Anything at or before the virtual
    // playhead appears in the window, aged by its offset from the playhead.
    if (historicalRange && historicalActivity.length > 0) {
      const playheadTs =
        historicalRange.start + scrubProgress * historicalRange.span;
      for (const ev of historicalActivity) {
        const age = playheadTs - ev.ts;
        if (age < 0 || age > HEATMAP_WINDOW_MS) continue;
        const idx =
          HEATMAP_BUCKET_COUNT - 1 - Math.floor(age / HEATMAP_BUCKET_MS);
        if (idx < 0 || idx >= HEATMAP_BUCKET_COUNT) continue;
        const arr = buckets.get(ev.roleId);
        if (arr) arr[idx] += 1;
      }
    }

    return buckets;
  }, [activity, roles, historicalActivity, historicalRange, scrubProgress]);

  const sortedRoles = useMemo(
    () => [...roles].sort((a, b) => b.authorityRank - a.authorityRank),
    [roles],
  );

  /** Per-role list of (peer, weight) pairs sorted desc, for hover tooltips. */
  const pairwiseByRole = useMemo(() => {
    const map = new Map<string, Array<{ peer: RoleNode; weight: number }>>();
    for (const a of roles) {
      const others: Array<{ peer: RoleNode; weight: number }> = [];
      for (const b of roles) {
        if (a.id === b.id) continue;
        const w = edgeWeights.get(pairKey(a.id, b.id)) ?? 0;
        others.push({ peer: b, weight: w });
      }
      others.sort((x, y) => y.weight - x.weight);
      map.set(a.id, others);
    }
    return map;
  }, [roles, edgeWeights]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (connState === "connecting" && roles.length === 0) {
    return (
      <div
        className="flex h-full w-full items-center justify-center"
        data-testid="agent-affinity-spring-loading"
      >
        <span className="animate-pulse text-sm text-white/50">Connecting…</span>
      </div>
    );
  }

  if (connState === "error" && roles.length === 0) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-1"
        data-testid="agent-affinity-spring-error"
      >
        <span className="text-sm text-white/60">Affinity feed unavailable</span>
        {errorMsg && <span className="text-[10px] text-white/30">{errorMsg}</span>}
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col bg-white/[0.02] text-white"
      data-testid="agent-affinity-spring"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold text-white/90">Agent Affinity — Spring</h3>
          <DashboardInfo blurb={AFFINITY_SPRING_BLURB} />
        </div>
        <span className="text-[10px] text-white/30">
          {roles.length} role{roles.length === 1 ? "" : "s"} · last 60 s
        </span>
      </div>

      {/* Spring sim — top 70% */}
      <div
        className="relative w-full"
        style={{ height: SPRING_PANEL_HEIGHT }}
        data-testid="affinity-spring-canvas"
      >
        {/* SVG layer for the equilibrium ring guide, edges + weight labels,
            and comets — all drawn beneath the node motion divs. */}
        <svg
          viewBox={`0 0 ${PANEL_WIDTH} ${SPRING_PANEL_HEIGHT}`}
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Equilibrium ring guide — the "zero-spring" layout radius.
              Visible deviation from this circle indicates a spring pull. */}
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke="white"
            strokeOpacity={0.12}
            strokeDasharray="4 6"
            strokeWidth={1}
            data-testid="affinity-spring-equilibrium-ring"
          />

          {/* All affinity edges, always-on with weight numbers at midpoint.
              Skip only true zeros so the dashboard doesn't fabricate
              relationships the backend didn't report. */}
          {roles.map((a, i) =>
            roles.slice(i + 1).map((b) => {
              const sim = edgeWeights.get(pairKey(a.id, b.id)) ?? 0;
              if (sim <= 0) return null;
              const pa = targets.get(a.id);
              const pb = targets.get(b.id);
              if (!pa || !pb) return null;
              const mx = (pa.x + pb.x) / 2;
              const my = (pa.y + pb.y) / 2;
              const label = sim.toFixed(2);
              const labelWidth = label.length * 6 + 8;
              const stroke = Math.max(0.6, sim * 8);
              const opacity = Math.min(0.85, 0.35 + sim * 1.2);
              return (
                <g
                  key={`${a.id}-${b.id}`}
                  data-testid={`affinity-spring-edge-${a.id}-${b.id}`}
                >
                  <line
                    x1={pa.x}
                    y1={pa.y}
                    x2={pb.x}
                    y2={pb.y}
                    stroke="white"
                    strokeOpacity={opacity}
                    strokeWidth={stroke}
                  />
                  <rect
                    x={mx - labelWidth / 2}
                    y={my - 7}
                    width={labelWidth}
                    height={14}
                    rx={3}
                    fill="rgba(15,23,42,0.78)"
                    stroke="rgba(255,255,255,0.18)"
                    strokeWidth={0.5}
                  />
                  <text
                    x={mx}
                    y={my + 3}
                    textAnchor="middle"
                    fontSize={9}
                    fontFamily="ui-monospace, monospace"
                    fill="white"
                    fillOpacity={0.92}
                  >
                    {label}
                  </text>
                </g>
              );
            }),
          )}

          {/* Comets — only when motion is allowed. */}
          {!reduceMotion &&
            comets.map((c) => {
              const from = targets.get(c.fromId);
              const to = targets.get(c.toId);
              if (!from || !to) return null;
              const dx = to.x - from.x;
              const dy = to.y - from.y;
              const elapsed = Date.now() - c.startedAt;
              const t = Math.min(1, elapsed / COMET_DURATION_MS);
              const x = from.x + dx * t;
              const y = from.y + dy * t;
              const opacity = 1 - t;
              return (
                <g key={c.id} pointerEvents="none">
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={x}
                    y2={y}
                    stroke="#60a5fa"
                    strokeWidth={1.2}
                    strokeOpacity={opacity * 0.5}
                  />
                  <circle cx={x} cy={y} r={4} fill="#60a5fa" fillOpacity={opacity} />
                </g>
              );
            })}
        </svg>

        {/* Node layer (motion divs). */}
        {roles.map((r) => {
          const target = targets.get(r.id) ?? { x: cx, y: cy };
          const mass = authorityToMass(r.authorityRank);
          const nodeRadius = radiusForContributions(r.contributionsCount);
          const animate = { x: target.x - nodeRadius, y: target.y - nodeRadius };
          const transition = reduceMotion
            ? { duration: 0 }
            : { type: "spring" as const, stiffness: 80, damping: 14, mass };
          const style: CSSProperties = {
            width: nodeRadius * 2,
            height: nodeRadius * 2,
            background: `${r.color}33`,
            border: `1.5px solid ${r.color}`,
            color: "white",
          };
          // Hover tooltip — name, rank, contribs, top tags, pairwise
          // affinities. Browser-native <title> works with motion.div with no
          // additional JS or libs.
          const topTags = r.domainTags.slice(0, 3).join(", ") || "(none)";
          const topPairs = (pairwiseByRole.get(r.id) ?? [])
            .slice(0, 3)
            .map((p) => `${p.peer.name}=${p.weight.toFixed(2)}`)
            .join(" · ");
          const tooltip =
            `${r.name} · rank ${r.authorityRank} · ${r.contributionsCount} contribs\n` +
            `Tags: ${topTags}\n` +
            `Affinity: ${topPairs || "(none)"}`;
          // Truncate to fit smaller nodes — radius ~14 ≈ 4 chars max.
          const labelMax = Math.max(3, Math.floor(nodeRadius / 3.5));
          const labelText =
            r.name.length > labelMax + 1
              ? r.name.slice(0, labelMax) + "…"
              : r.name;
          return (
            <motion.div
              key={r.id}
              className="absolute flex flex-col items-center justify-center rounded-full text-[10px] font-semibold"
              style={style}
              initial={animate}
              animate={animate}
              transition={transition}
              data-testid={`affinity-spring-node-${r.id}`}
              data-role-name={r.name}
              data-node-radius={nodeRadius}
              title={tooltip}
            >
              <span className="px-1 leading-none">{labelText}</span>
              <span
                className="mt-0.5 rounded px-1 text-[8px] font-mono text-white/80"
                style={{ background: r.color }}
                data-testid={`affinity-spring-rank-${r.id}`}
              >
                r{r.authorityRank}
              </span>
            </motion.div>
          );
        })}
      </div>

      {/* Heatmap — bottom 30% */}
      <div
        className="border-t border-white/10 px-3 py-2"
        style={{ height: HEATMAP_PANEL_HEIGHT }}
        data-testid="affinity-spring-heatmap"
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wide text-white/40">
            Activity · 60s
          </span>
          {/* Play/pause + scrubber for replaying the contribution timeline.
              Disabled when no historical activity has loaded yet. */}
          <div className="flex flex-1 items-center gap-2">
            <button
              type="button"
              onClick={onTogglePlay}
              disabled={historicalActivity.length === 0}
              aria-label={isPlaying ? "Pause activity replay" : "Play activity replay"}
              data-testid={isPlaying ? "spring-activity-pause" : "spring-activity-play"}
              className="rounded border border-white/20 px-1.5 py-0.5 text-[10px] text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {isPlaying ? "⏸" : "▶"}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={scrubProgress}
              onChange={(e) => onScrubChange(parseFloat(e.target.value))}
              disabled={historicalActivity.length === 0}
              aria-label="Scrub activity timeline"
              data-testid="spring-activity-scrub-slider"
              className="h-1 flex-1 cursor-pointer accent-blue-400 disabled:cursor-not-allowed disabled:opacity-30"
            />
            <span
              className="w-8 shrink-0 text-right font-mono text-[9px] text-white/40"
              data-testid="spring-activity-scrub-label"
            >
              {Math.round(scrubProgress * 100)}%
            </span>
          </div>
          <span className="text-[9px] text-white/30">5s buckets</span>
        </div>
        <div className="flex h-[calc(100%-1rem)] flex-col gap-0.5 overflow-hidden">
          {sortedRoles.length === 0 && (
            <span className="text-[10px] text-white/30">No activity yet.</span>
          )}
          {sortedRoles.map((r) => {
            const cells = heatmap.get(r.id) ?? new Array(HEATMAP_BUCKET_COUNT).fill(0);
            return (
              <div
                key={r.id}
                className="flex items-center gap-1"
                data-testid={`affinity-spring-row-${r.id}`}
              >
                <span
                  className="w-20 shrink-0 truncate text-[10px] text-white/60"
                  title={r.name}
                >
                  {r.name}
                </span>
                <div className="flex flex-1 gap-[2px]">
                  {cells.map((count, i) => {
                    const v = clampActivity(count) / 8;
                    return (
                      <div
                        key={i}
                        className="h-3 flex-1 rounded-sm"
                        style={{
                          background: `rgba(96,165,250,${0.08 + v * 0.85})`,
                          outline: count > 0 ? "0.5px solid rgba(255,255,255,0.18)" : "none",
                        }}
                        title={`${count} event${count === 1 ? "" : "s"}`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
