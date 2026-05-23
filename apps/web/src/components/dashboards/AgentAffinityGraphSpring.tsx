"use client";

/**
 * AgentAffinityGraphSpring — Spring-physics + activity-heatmap variant of the
 * agent affinity dashboard.
 *
 * Top 70%: live spring-simulated graph.  Each role is a circle; positions
 *          re-target every 2 s based on the pairwise affinity weights
 *          returned by the backend `/quorums/{id}/affinity-graph` endpoint
 *          (word-level overlap via `compute_tag_relevance`). Nodes whose
 *          weights are high pull toward each other; pairs without an edge
 *          in the response have no force between them. Authority rank →
 *          node "mass" → spring inertia (heavier nodes resist motion).
 *          Animation uses Framer Motion's built-in spring transition.
 *
 *          Previously this used a client-side exact-match Jaccard over
 *          `[tags: ...]` blocks from contributions, which returned ~0 for
 *          every pair because LLM-emitted tags are short generic words
 *          ("policy", "risk") while persona domain_tags are compound
 *          ("policy_compliance"). The nodes stayed isolated in a ring.
 *
 * Bottom 30%: 60 s activity heatmap.  Rows = roles (sorted by authority_rank
 *             desc), columns = 12 x 5 s buckets.  Cell intensity = count of
 *             station_messages + agent_requests for that role in that bucket.
 *             Cells age leftward as time advances.
 *
 * When a new agent_request arrives, an SVG comet animates from source → target.
 *
 * Self-contained: takes only { quorumId } as a prop.  Fetches its own data
 * from /api/quorums/{id}/role-status (REST) and subscribes to Supabase
 * realtime channels for `contributions`, `station_messages`, and
 * `agent_requests`.  Renders a "connecting…" state when data is unavailable.
 *
 * Sophie wires this into the carousel and view-toggle in a separate commit.
 */

import {
  useEffect,
  useMemo,
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
const NODE_RADIUS = 22;
const RETARGET_INTERVAL_MS = 2000;
const HEATMAP_BUCKET_MS = 5000;
const HEATMAP_BUCKET_COUNT = 12;
const HEATMAP_WINDOW_MS = HEATMAP_BUCKET_MS * HEATMAP_BUCKET_COUNT;
const COMET_DURATION_MS = 1400;
/** How often to poll the backend `/affinity-graph` endpoint for refreshed
 *  pairwise weights. */
const AFFINITY_REFRESH_MS = 15_000;

const AFFINITY_SPRING_BLURB =
  "**Agent Affinity (Spring + Heatmap).** Each circle is an AI role; nodes drift via a spring simulation toward neighbours whose recent `[tags: ...]` overlap (Jaccard) is highest. Higher-authority roles are heavier and move more slowly. The strip below is a 60 s activity heatmap — cell intensity = combined station messages + agent-to-agent requests in that 5 s bucket. Comets show live A2A traffic.";

// Fallback colour palette used when a role has no explicit colour.
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
  /** Persona's persistent domain_tags (from agent_configs).  Used as the
   *  baseline tag set so affinity has signal before any contributions arrive. */
  domain_tags?: string[];
}

interface RoleNode {
  id: string;
  name: string;
  authorityRank: number;
  color: string;
  /** Persona's persistent domain_tags — used as the baseline tag set when
   *  no contributions have arrived yet, so the spring sim has signal at t=0. */
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
 *  pairwise weights come from the backend `/affinity-graph` endpoint, which
 *  uses word-level overlap (`compute_tag_relevance`). */
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
 * Algorithm: start from the ring layout, then apply a single relaxation
 * pass where every pair of roles nudges toward each other proportional to
 * the backend-computed affinity weight (word-level overlap via
 * `compute_tag_relevance`, served by `/quorums/{id}/affinity-graph`).
 * Roles without an edge in the response keep their ring position. This is
 * intentionally cheap — Framer's spring transition smooths between frames.
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
      // Pull each toward the other, scaled by similarity.  0.4 keeps the
      // graph from collapsing to a single point even at sim=1.
      const k = sim * 0.4;
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
          color: meta?.color || FALLBACK_COLORS[i % FALLBACK_COLORS.length],
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
              // Push to the activity heatmap; pairwise affinity comes from
              // the backend `/affinity-graph` poll, so we no longer need to
              // re-derive tags from contribution bodies here.
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
  // Heatmap bucketization
  // -------------------------------------------------------------------------
  const heatmap = useMemo(() => {
    const now = Date.now();
    const buckets = new Map<string, number[]>();
    for (const r of roles) buckets.set(r.id, new Array(HEATMAP_BUCKET_COUNT).fill(0));

    for (const ev of activity) {
      const age = now - ev.ts;
      if (age < 0 || age > HEATMAP_WINDOW_MS) continue;
      // bucket 0 = oldest (left); bucket N-1 = newest (right).
      const idx = HEATMAP_BUCKET_COUNT - 1 - Math.floor(age / HEATMAP_BUCKET_MS);
      if (idx < 0 || idx >= HEATMAP_BUCKET_COUNT) continue;
      const arr = buckets.get(ev.roleId);
      if (arr) arr[idx] += 1;
    }
    return buckets;
  }, [activity, roles]);

  const sortedRoles = useMemo(
    () => [...roles].sort((a, b) => b.authorityRank - a.authorityRank),
    [roles],
  );

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
        {/* SVG layer for comets + faint affinity lines, drawn beneath nodes. */}
        <svg
          viewBox={`0 0 ${PANEL_WIDTH} ${SPRING_PANEL_HEIGHT}`}
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Faint connector lines for pairs with a backend-computed
              affinity weight above the noise floor. */}
          {roles.map((a, i) =>
            roles.slice(i + 1).map((b) => {
              const sim = edgeWeights.get(pairKey(a.id, b.id)) ?? 0;
              if (sim <= 0.05) return null;
              const pa = targets.get(a.id);
              const pb = targets.get(b.id);
              if (!pa || !pb) return null;
              return (
                <line
                  key={`${a.id}-${b.id}`}
                  x1={pa.x}
                  y1={pa.y}
                  x2={pb.x}
                  y2={pb.y}
                  stroke="rgba(255,255,255,0.18)"
                  strokeWidth={0.4 + sim * 2}
                />
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
          const animate = { x: target.x - NODE_RADIUS, y: target.y - NODE_RADIUS };
          const transition = reduceMotion
            ? { duration: 0 }
            : { type: "spring" as const, stiffness: 80, damping: 14, mass };
          const style: CSSProperties = {
            width: NODE_RADIUS * 2,
            height: NODE_RADIUS * 2,
            background: `${r.color}33`,
            border: `1.5px solid ${r.color}`,
            color: "white",
          };
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
            >
              <span className="px-1 leading-none">
                {r.name.length > 9 ? r.name.slice(0, 8) + "…" : r.name}
              </span>
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
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-white/40">
            Activity · 60s
          </span>
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
