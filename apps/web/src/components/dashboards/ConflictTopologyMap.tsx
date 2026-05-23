"use client";

/**
 * ConflictTopologyMap — network graph that shows role relationships in a
 * quorum, with conflicts (red) and collaborations (green) overlaid on a
 * faint baseline of every possible role-pair.
 *
 * Visual layers (bottom → top):
 *   1. Baseline edges — every C(N,2) role pair as a faint dashed gray line.
 *      Establishes the complete graph so the viewer can see "this pair has
 *      no signal" vs "this pair just isn't connected".
 *   2. Collaboration edges — pairs with collaborative interaction in the
 *      backend `/affinity-graph` response. Green.
 *   3. Conflict edges — pairs detected by `detectConflictEdges`. Red.
 *   4. Nodes — sized by `contributions_count` (radius 14–34px), outlined
 *      with stroke width keyed to `authority_rank` (1–3px).
 *
 * Header reframes when the quorum is resolved and no conflicts exist:
 * title becomes "Collaboration Topology" with a green "Consensus reached"
 * badge and a top-right summary chip ("0 conflicts · N collaborations").
 *
 * Conflict detection — fully client-side, two signals:
 *
 *   1. **Field overlap** — both roles produced contributions whose
 *      `structured_fields` share a key (e.g. both wrote about
 *      `patient_consent`). Each shared field is one piece of evidence.
 *
 *   2. **Opposing analysis_deltas** — both roles emitted Tier-2 analyzer
 *      `analysis_deltas` for the same metric with opposing signs. Used as
 *      a fallback when structured_fields is sparse. Each opposing metric
 *      contributes one piece of evidence and flips the edge to "active"
 *      (red). Raw cumulative sums (not just signs) are kept for labels.
 *
 * Edges accumulate evidence from both signals; the heaviest evidence
 * wins for colour. Thickness scales 1..5 with the total conflict count.
 *
 * Self-contained: takes only { quorumId } as a prop. Pulls roles +
 * contributions from the shared dataProvider, fetches /role-status,
 * /affinity-graph, /state from the backend, and subscribes to realtime
 * contribution inserts so the topology re-computes live.
 */

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  getRoles,
  getContributions,
  subscribeToContributions,
} from "@/lib/dataProvider";
import { DashboardInfo } from "./DashboardInfo";

const PANEL_WIDTH = 560;
const PANEL_HEIGHT = 420;

const CONFLICT_BLURB =
  "**Topology Map.** Faint dashed lines show every possible role-pair as a baseline. Green = collaboration (shared interaction weight from /affinity-graph). Red = conflict (shared structured_field or opposing analysis_delta). Node size = contribution count, outline thickness = authority rank. Click a colored edge to see the opposing positions side-by-side.";

// ---------------------------------------------------------------------------
// Local row types (kept loose so we work against either Supabase or demo data)
// ---------------------------------------------------------------------------

interface RoleRow {
  id: string;
  name: string;
  color?: string;
  authority_rank?: number;
}

interface ContribRow {
  id: string;
  role_id: string;
  content?: string;
  structured_fields?: Record<string, string> | null;
  analysis_tags?: string[] | null;
  analysis_deltas?: Record<string, number> | null;
  created_at?: string;
}

/** Subset of /role-status response we use for sizing nodes. */
interface RoleStatusRow {
  role_id: string;
  name?: string;
  contributions_count?: number;
  authority_rank?: number;
}

/** Edge from the backend /affinity-graph endpoint. */
interface AffinityEdge {
  source: string;
  target: string;
  weight: number;
  interactionType?: string;
}

interface AffinityGraphResponse {
  nodes?: Array<{ id: string; label?: string }>;
  edges?: AffinityEdge[];
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface ConflictEvidence {
  /** Structured field both roles wrote to (e.g. "patient_consent"). */
  field: string;
  /** Excerpt from role A's contribution about this field. */
  excerptA: string;
  /** Excerpt from role B's contribution about this field. */
  excerptB: string;
  /** Opposing metric (if signal came from analysis_deltas), or null. */
  metric: string | null;
  /** Sign of A's delta (-1/0/+1), null if not delta-driven. */
  signA: number | null;
  /** Sign of B's delta, null if not delta-driven. */
  signB: number | null;
  /** Raw cumulative delta sum for A on this metric (null if field-based). */
  sumA: number | null;
  /** Raw cumulative delta sum for B on this metric (null if field-based). */
  sumB: number | null;
}

export interface ConflictEdge {
  source: string;
  target: string;
  /** Total number of conflict signals between this pair. */
  count: number;
  /** True if at least one signal is an opposing analysis_delta. */
  active: boolean;
  evidence: ConflictEvidence[];
}

function sign(n: number): number {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

function truncate(text: string | undefined, max = 140): string {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Stable key for an unordered pair of role ids. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Detect conflict edges from a list of contributions and roles.
 *
 * Pure function — exported so tests can drive it with deterministic fixtures
 * and so the live component can re-run it whenever the contribution list
 * mutates.
 *
 * @param roles
 * @param contributions
 * @param opts.deltaMagnitudeThreshold Minimum |sumA| and |sumB| required
 *   for a sign-opposed analysis_delta to count as a conflict. Default
 *   0.05 keeps existing behaviour. Pass a higher number (e.g. 5) to
 *   filter noise on quorums with many small deltas.
 */
export function detectConflictEdges(
  roles: RoleRow[],
  contributions: ContribRow[],
  opts: { deltaMagnitudeThreshold?: number } = {},
): ConflictEdge[] {
  if (roles.length < 2 || contributions.length < 2) return [];
  const deltaMagnitudeThreshold = opts.deltaMagnitudeThreshold ?? 0.05;

  // Index contributions by role
  const byRole = new Map<string, ContribRow[]>();
  for (const r of roles) byRole.set(r.id, []);
  for (const c of contributions) {
    const arr = byRole.get(c.role_id);
    if (arr) arr.push(c);
  }

  // Collect structured-field keys per role (key -> list of contributions)
  const fieldsByRole = new Map<string, Map<string, ContribRow[]>>();
  for (const r of roles) fieldsByRole.set(r.id, new Map());
  for (const c of contributions) {
    const m = fieldsByRole.get(c.role_id);
    if (!m) continue;
    const fields = c.structured_fields ?? {};
    for (const k of Object.keys(fields)) {
      if (!k) continue;
      const arr = m.get(k) ?? [];
      arr.push(c);
      m.set(k, arr);
    }
  }

  // Collect analysis_deltas per role keyed by metric. Stores the raw
  // cumulative sum so we can both check sign-opposition and surface the
  // magnitude on labels ("consensus: A +12 vs B -3").
  const deltaSumByRole = new Map<string, Map<string, number>>();
  for (const r of roles) deltaSumByRole.set(r.id, new Map());
  for (const c of contributions) {
    const m = deltaSumByRole.get(c.role_id);
    if (!m) continue;
    const deltas = c.analysis_deltas ?? {};
    for (const [metric, v] of Object.entries(deltas)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v === 0) continue;
      const prior = m.get(metric) ?? 0;
      m.set(metric, prior + v);
    }
  }

  const edges: ConflictEdge[] = [];

  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      const a = roles[i];
      const b = roles[j];
      const evidence: ConflictEvidence[] = [];
      let active = false;

      // (1) Shared structured_fields → one evidence row per shared key
      const emptyFieldMap: Map<string, ContribRow[]> = new Map();
      const fieldsA = fieldsByRole.get(a.id) ?? emptyFieldMap;
      const fieldsB = fieldsByRole.get(b.id) ?? emptyFieldMap;
      const fieldKeysA: string[] = Array.from(fieldsA.keys());
      for (const field of fieldKeysA) {
        if (!fieldsB.has(field)) continue;
        const arrA = fieldsA.get(field)!;
        const arrB = fieldsB.get(field)!;
        const ca = arrA[arrA.length - 1];
        const cb = arrB[arrB.length - 1];
        evidence.push({
          field,
          excerptA: truncate(ca.structured_fields?.[field] ?? ca.content),
          excerptB: truncate(cb.structured_fields?.[field] ?? cb.content),
          metric: null,
          signA: null,
          signB: null,
          sumA: null,
          sumB: null,
        });
      }

      // (2) Opposing analysis_deltas on the same metric — fallback when
      // structured_fields is sparse. Requires:
      //   * Both roles emitted a delta for this metric.
      //   * Their cumulative sums are sign-opposed.
      //   * |sumA| and |sumB| each exceed the magnitude threshold.
      const emptyDeltaMap: Map<string, number> = new Map();
      const deltasA = deltaSumByRole.get(a.id) ?? emptyDeltaMap;
      const deltasB = deltaSumByRole.get(b.id) ?? emptyDeltaMap;
      const metricKeysA: string[] = Array.from(deltasA.keys());
      for (const metric of metricKeysA) {
        if (!deltasB.has(metric)) continue;
        const sumA = deltasA.get(metric)!;
        const sumB = deltasB.get(metric)!;
        const sa = sign(sumA);
        const sb = sign(sumB);
        if (sa === 0 || sb === 0 || sa === sb) continue;
        if (
          Math.abs(sumA) < deltaMagnitudeThreshold ||
          Math.abs(sumB) < deltaMagnitudeThreshold
        ) {
          continue;
        }
        active = true;
        const latestA = byRole.get(a.id)?.slice(-1)[0];
        const latestB = byRole.get(b.id)?.slice(-1)[0];
        evidence.push({
          field: metric,
          excerptA: truncate(latestA?.content),
          excerptB: truncate(latestB?.content),
          metric,
          signA: sa,
          signB: sb,
          sumA,
          sumB,
        });
      }

      if (evidence.length === 0) continue;
      edges.push({
        source: a.id,
        target: b.id,
        count: evidence.length,
        active,
        evidence,
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface Vec2 {
  x: number;
  y: number;
}

function ringLayout(ids: string[], cx: number, cy: number, radius: number): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  const n = Math.max(1, ids.length);
  ids.forEach((id, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    out.set(id, { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  });
  return out;
}

/**
 * Map a role's contribution count to a node radius in pixels.
 * Linear scale across the observed range [minCount, maxCount] → [14, 34].
 * Falls back to a sensible mid-size when all roles tie.
 */
export function nodeRadiusForCount(
  count: number,
  minCount: number,
  maxCount: number,
): number {
  const lo = 14;
  const hi = 34;
  if (maxCount <= 0) return lo + 4;
  if (maxCount === minCount) return (lo + hi) / 2;
  const c = Math.max(minCount, Math.min(maxCount, count));
  const t = (c - minCount) / (maxCount - minCount);
  return lo + t * (hi - lo);
}

/**
 * Map authority_rank → outline stroke width in pixels (1..3).
 * Rank 0–1 → 1px, 2–3 → 2px, 4+ → 3px.
 */
export function strokeWidthForAuthority(rank: number | undefined): number {
  const r = rank ?? 0;
  if (r >= 4) return 3;
  if (r >= 2) return 2;
  return 1;
}

function edgeWidth(count: number): number {
  // 1..5 conflicts → 1.5..5px
  return Math.max(1.5, Math.min(5, 1.5 + (count - 1) * 1));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ConflictTopologyMapProps {
  quorumId: string;
}

export function ConflictTopologyMap({ quorumId }: ConflictTopologyMapProps) {
  const reduceMotion = useReducedMotion();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [contributions, setContributions] = useState<ContribRow[]>([]);
  const [connState, setConnState] = useState<"connecting" | "ready" | "empty">("connecting");
  const [hoveredRole, setHoveredRole] = useState<string | null>(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  // Backend signals — null until first fetch completes.
  const [roleStatus, setRoleStatus] = useState<RoleStatusRow[] | null>(null);
  const [affinityEdges, setAffinityEdges] = useState<AffinityEdge[]>([]);
  const [quorumStatus, setQuorumStatus] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Load roles + contributions once, then subscribe to live contributions
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!quorumId) return;
    let cancelled = false;

    (async () => {
      try {
        const [r, c] = await Promise.all([
          getRoles(quorumId),
          getContributions(quorumId),
        ]);
        if (cancelled) return;
        setRoles((r as RoleRow[]) ?? []);
        setContributions((c as ContribRow[]) ?? []);
        setConnState(r && r.length > 0 ? "ready" : "empty");
      } catch {
        if (!cancelled) setConnState("empty");
      }
    })();

    const unsub = subscribeToContributions(quorumId, (incoming) => {
      setContributions((prev) => {
        if (prev.some((p) => p.id === incoming.id)) return prev;
        return [...prev, incoming as ContribRow];
      });
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [quorumId]);

  // -------------------------------------------------------------------------
  // Fetch backend signals (role-status for sizing, affinity-graph for
  // collaboration edges, state for the resolved/active header reframe).
  // Failures are silent — the component degrades to its original behavior.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!quorumId) return;
    let cancelled = false;
    const base = process.env.NEXT_PUBLIC_API_URL ?? "";
    if (!base) return;

    (async () => {
      try {
        const [statusRes, affinityRes, stateRes] = await Promise.all([
          fetch(`${base}/quorums/${quorumId}/role-status`).catch(() => null),
          fetch(`${base}/quorums/${quorumId}/affinity-graph`).catch(() => null),
          fetch(`${base}/quorums/${quorumId}/state`).catch(() => null),
        ]);

        if (statusRes && statusRes.ok) {
          try {
            const data: RoleStatusRow[] = await statusRes.json();
            if (!cancelled && Array.isArray(data)) setRoleStatus(data);
          } catch {
            /* ignore malformed payload */
          }
        }

        if (affinityRes && affinityRes.ok) {
          try {
            const graph: AffinityGraphResponse = await affinityRes.json();
            const edges = Array.isArray(graph.edges) ? graph.edges : [];
            if (!cancelled) setAffinityEdges(edges);
          } catch {
            /* ignore malformed payload */
          }
        }

        if (stateRes && stateRes.ok) {
          try {
            const s = await stateRes.json();
            const status = s?.quorum?.status;
            if (!cancelled && typeof status === "string") {
              setQuorumStatus(status);
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* network down — defaults stand */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [quorumId]);

  // -------------------------------------------------------------------------
  // Derive edges + positions
  // -------------------------------------------------------------------------
  const edges = useMemo(
    () => detectConflictEdges(roles, contributions),
    [roles, contributions],
  );

  const positions = useMemo(() => {
    const cx = PANEL_WIDTH / 2;
    const cy = PANEL_HEIGHT / 2 + 6;
    const radius = Math.min(cx, cy) - 70;
    return ringLayout(
      roles.map((r) => r.id),
      cx,
      cy,
      radius,
    );
  }, [roles]);

  const selectedEdge = useMemo(() => {
    if (!selectedEdgeKey) return null;
    return edges.find((e) => `${e.source}|${e.target}` === selectedEdgeKey) ?? null;
  }, [selectedEdgeKey, edges]);

  const roleById = useMemo(() => {
    const m = new Map<string, RoleRow>();
    for (const r of roles) m.set(r.id, r);
    return m;
  }, [roles]);

  // Map from role_id → contributions_count (for node sizing).
  const contributionsByRole = useMemo(() => {
    const m = new Map<string, number>();
    if (roleStatus && roleStatus.length > 0) {
      for (const r of roleStatus) {
        if (typeof r.contributions_count === "number") {
          m.set(r.role_id, r.contributions_count);
        }
      }
    }
    // Fallback: count contributions client-side for any role missing from
    // /role-status (or when the endpoint never replied).
    for (const role of roles) {
      if (!m.has(role.id)) {
        const n = contributions.filter((c) => c.role_id === role.id).length;
        m.set(role.id, n);
      }
    }
    return m;
  }, [roleStatus, roles, contributions]);

  // Range of contribution counts across all roles → node radius scale.
  const contribRange = useMemo(() => {
    const vals = roles
      .map((r) => contributionsByRole.get(r.id) ?? 0)
      .filter((n) => Number.isFinite(n));
    if (vals.length === 0) return { min: 0, max: 0 };
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }, [roles, contributionsByRole]);

  // Map pairKey → collaboration affinity weight (from backend).
  const collaborationByPair = useMemo(() => {
    const m = new Map<string, AffinityEdge>();
    for (const e of affinityEdges) {
      if (!e || !e.source || !e.target) continue;
      if (e.interactionType !== "collaborative") continue;
      m.set(pairKey(e.source, e.target), e);
    }
    return m;
  }, [affinityEdges]);

  // Set of pairKey for conflict edges, so the baseline layer can skip them.
  const conflictPairKeys = useMemo(() => {
    const s = new Set<string>();
    for (const e of edges) s.add(pairKey(e.source, e.target));
    return s;
  }, [edges]);

  // All C(N,2) pairs as baseline edge candidates.
  const baselinePairs = useMemo(() => {
    const out: Array<{ source: string; target: string }> = [];
    for (let i = 0; i < roles.length; i++) {
      for (let j = i + 1; j < roles.length; j++) {
        out.push({ source: roles[i].id, target: roles[j].id });
      }
    }
    return out;
  }, [roles]);

  // Header summary counts.
  const conflictCount = edges.length;
  const collaborationCount = collaborationByPair.size;
  const isResolved = quorumStatus === "resolved";
  const showCollaborationFraming = isResolved && conflictCount === 0;
  const titleText = showCollaborationFraming
    ? "Collaboration Topology"
    : "Conflict Topology";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const containerStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    minHeight: PANEL_HEIGHT,
  };

  return (
    <div
      data-testid="conflict-topology-map"
      className="relative flex h-full w-full flex-col bg-transparent text-white/85"
      style={containerStyle}
    >
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <div className="flex items-center gap-1.5">
          <h3
            className="text-sm font-semibold text-white/90"
            data-testid="conflict-topology-title"
          >
            {titleText}
          </h3>
          <DashboardInfo blurb={CONFLICT_BLURB} />
          {showCollaborationFraming && (
            <span
              data-testid="consensus-reached-badge"
              className="ml-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-[1px] text-[10px] font-medium text-emerald-300"
            >
              Consensus reached
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-white/40">
          {/* Summary chip — always show actual counts so the audience can
              tell "no signal" apart from "broken render". */}
          <span
            data-testid="topology-summary-chip"
            className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-2 py-[1px] text-[10px] text-white/70"
          >
            <span data-testid="topology-summary-conflicts">
              <span
                className="mr-1 inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: "#f87171" }}
                aria-hidden
              />
              {conflictCount} {conflictCount === 1 ? "conflict" : "conflicts"}
            </span>
            <span className="text-white/30">·</span>
            <span data-testid="topology-summary-collaborations">
              <span
                className="mr-1 inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: "#34d399" }}
                aria-hidden
              />
              {collaborationCount}{" "}
              {collaborationCount === 1 ? "collaboration" : "collaborations"}
            </span>
          </span>
        </div>
      </div>

      {connState !== "ready" && roles.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-white/40">
          {connState === "connecting"
            ? "Connecting…"
            : "No roles yet — waiting for the quorum to populate. Edges appear once two roles share a structured field, push the same metric in opposite directions, or accrue collaborative interaction weight."}
        </div>
      ) : (
        <div className="relative flex-1 min-h-0">
          <svg
            viewBox={`0 0 ${PANEL_WIDTH} ${PANEL_HEIGHT}`}
            className="h-full w-full"
            role="img"
            aria-label="Role topology map"
            data-testid="conflict-topology-svg"
          >
            {/* (1) Baseline edges — every possible pair as a faint dashed
                line. Hidden whenever a conflict or collaboration edge
                covers the same pair (those layers render on top below). */}
            {baselinePairs.map((p) => {
              const a = positions.get(p.source);
              const b = positions.get(p.target);
              if (!a || !b) return null;
              const key = pairKey(p.source, p.target);
              const hasCollab = collaborationByPair.has(key);
              const hasConflict = conflictPairKeys.has(key);
              const dim =
                hoveredRole !== null &&
                hoveredRole !== p.source &&
                hoveredRole !== p.target;
              // Always draw the baseline so the complete graph reads as
              // intentional. Slightly fainter when an overlay covers it.
              const opacity = dim
                ? 0.05
                : hasCollab || hasConflict
                  ? 0.08
                  : 0.15;
              return (
                <line
                  key={`baseline-${key}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="#94a3b8"
                  strokeWidth={1}
                  strokeOpacity={opacity}
                  strokeDasharray="2 3"
                  data-testid={`baseline-edge-${p.source}-${p.target}`}
                  style={{ pointerEvents: "none" }}
                />
              );
            })}

            {/* (2) Collaboration edges (from /affinity-graph) — green,
                opacity scaled by weight. Skipped if the same pair already
                has a conflict edge (conflict wins for clarity). */}
            {Array.from(collaborationByPair.entries()).map(([key, edge]) => {
              if (conflictPairKeys.has(key)) return null;
              const a = positions.get(edge.source);
              const b = positions.get(edge.target);
              if (!a || !b) return null;
              const dim =
                hoveredRole !== null &&
                hoveredRole !== edge.source &&
                hoveredRole !== edge.target;
              const w = Math.max(0, Math.min(1, edge.weight));
              const stroke = "#34d399";
              const opacity = dim ? 0.2 : 0.35 + w * 0.55; // 0.35..0.9
              const width = 1.5 + w * 2.5; // 1.5..4
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2;
              const label = w.toFixed(2);
              return (
                <g key={`collab-${key}`}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={stroke}
                    strokeWidth={width}
                    strokeOpacity={opacity}
                    data-testid={`collab-edge-${edge.source}-${edge.target}`}
                    style={{ pointerEvents: "none" }}
                  />
                  {/* Numeric badge — readable from ~10ft. */}
                  <g
                    data-testid={`collab-edge-badge-${edge.source}-${edge.target}`}
                    style={{ pointerEvents: "none" }}
                  >
                    <rect
                      x={mx - 14}
                      y={my - 8}
                      width={28}
                      height={14}
                      rx={7}
                      ry={7}
                      fill="#064e3b"
                      fillOpacity={dim ? 0.4 : 0.92}
                      stroke={stroke}
                      strokeOpacity={dim ? 0.3 : 0.85}
                      strokeWidth={0.75}
                    />
                    <text
                      x={mx}
                      y={my + 3}
                      textAnchor="middle"
                      fontSize={11}
                      fontWeight={600}
                      fill="#bbf7d0"
                      fillOpacity={dim ? 0.4 : 1}
                      style={{ userSelect: "none" }}
                    >
                      {label}
                    </text>
                  </g>
                </g>
              );
            })}

            {/* (3) Conflict edges (detected from contributions). */}
            {edges.map((edge) => {
              const a = positions.get(edge.source);
              const b = positions.get(edge.target);
              if (!a || !b) return null;
              const key = `${edge.source}|${edge.target}`;
              const stroke = edge.active ? "#f87171" : "#34d399";
              const dim =
                hoveredRole !== null &&
                hoveredRole !== edge.source &&
                hoveredRole !== edge.target;
              const isSelected = selectedEdgeKey === key;
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2;
              // Pick the most informative label:
              //   * If we have an analysis_delta evidence row, show
              //     "metric: A +X vs B -Y" (raw sums to 1 decimal).
              //   * Otherwise show the first structured-field name.
              const deltaEv = edge.evidence.find(
                (e) => e.metric !== null && e.sumA !== null && e.sumB !== null,
              );
              const primaryLabel = deltaEv
                ? `${deltaEv.metric}: A ${deltaEv.sumA! >= 0 ? "+" : ""}${deltaEv.sumA!.toFixed(1)} vs B ${deltaEv.sumB! >= 0 ? "+" : ""}${deltaEv.sumB!.toFixed(1)}`
                : edge.evidence[0]?.field ?? "";
              const labelMore = edge.count > 1 ? ` +${edge.count - 1}` : "";
              const badgeText = edge.active
                ? `+${edge.count}`
                : edge.count.toString();
              return (
                <g key={key}>
                  {/* Wide invisible hitbox for easier clicking */}
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="transparent"
                    strokeWidth={14}
                    style={{ cursor: "pointer" }}
                    onClick={() =>
                      setSelectedEdgeKey((cur) => (cur === key ? null : key))
                    }
                    data-testid={`conflict-edge-hit-${edge.source}-${edge.target}`}
                  />
                  <motion.line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={stroke}
                    strokeWidth={edgeWidth(edge.count)}
                    strokeOpacity={dim ? 0.15 : isSelected ? 1 : 0.85}
                    initial={reduceMotion ? false : { pathLength: 0 }}
                    animate={reduceMotion ? undefined : { pathLength: 1 }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                    style={{ pointerEvents: "none" }}
                    data-testid={`conflict-edge-${edge.source}-${edge.target}`}
                  />
                  {/* Edge text label (above the badge) — describes WHAT
                      the disagreement is about. */}
                  <text
                    x={mx}
                    y={my - 12}
                    textAnchor="middle"
                    fontSize={10}
                    fill={stroke}
                    fillOpacity={dim ? 0.2 : 0.85}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {primaryLabel}
                    {labelMore}
                  </text>
                  {/* Numeric badge — magnitude pill (readable from ~10ft). */}
                  <g
                    data-testid={`conflict-edge-badge-${edge.source}-${edge.target}`}
                    style={{ pointerEvents: "none" }}
                  >
                    <rect
                      x={mx - 14}
                      y={my - 7}
                      width={28}
                      height={14}
                      rx={7}
                      ry={7}
                      fill={edge.active ? "#7f1d1d" : "#064e3b"}
                      fillOpacity={dim ? 0.4 : 0.92}
                      stroke={stroke}
                      strokeOpacity={dim ? 0.3 : 0.9}
                      strokeWidth={0.75}
                    />
                    <text
                      x={mx}
                      y={my + 4}
                      textAnchor="middle"
                      fontSize={11}
                      fontWeight={600}
                      fill={edge.active ? "#fecaca" : "#bbf7d0"}
                      fillOpacity={dim ? 0.4 : 1}
                      style={{ userSelect: "none" }}
                    >
                      {badgeText}
                    </text>
                  </g>
                </g>
              );
            })}

            {/* (4) Nodes — sized by contribution count, outline thickness
                keyed to authority_rank. */}
            {roles.map((role) => {
              const p = positions.get(role.id);
              if (!p) return null;
              const count = contributionsByRole.get(role.id) ?? 0;
              const r = nodeRadiusForCount(
                count,
                contribRange.min,
                contribRange.max,
              );
              const outlineW = strokeWidthForAuthority(role.authority_rank);
              const fill = role.color ?? "#60a5fa";
              const dim = hoveredRole !== null && hoveredRole !== role.id;
              return (
                <g
                  key={role.id}
                  transform={`translate(${p.x}, ${p.y})`}
                  onMouseEnter={() => setHoveredRole(role.id)}
                  onMouseLeave={() => setHoveredRole(null)}
                  style={{ cursor: "pointer" }}
                  data-testid={`conflict-node-${role.id}`}
                  data-contribution-count={count}
                  data-authority-rank={role.authority_rank ?? 0}
                  data-node-radius={r.toFixed(1)}
                >
                  <circle
                    r={r}
                    fill={fill}
                    fillOpacity={dim ? 0.1 : 0.25}
                    stroke={fill}
                    strokeWidth={outlineW}
                    strokeOpacity={dim ? 0.3 : 0.9}
                  />
                  <text
                    y={r + 12}
                    textAnchor="middle"
                    fontSize={10}
                    fill="rgba(255,255,255,0.7)"
                    fillOpacity={dim ? 0.3 : 1}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {role.name.length > 16 ? role.name.slice(0, 15) + "…" : role.name}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Empty-conflicts hint overlay — only shown when there are no
              CONFLICTS *and* no COLLABORATION signal *and* the quorum
              isn't already framed as resolved-consensus. Otherwise the
              baseline + summary chip already tell the story. */}
          {edges.length === 0 &&
            collaborationCount === 0 &&
            !showCollaborationFraming &&
            roles.length > 0 && (
              <div className="pointer-events-none absolute inset-x-4 bottom-4 rounded border border-white/10 bg-black/60 px-3 py-2 text-center text-[11px] text-white/55">
                {contributions.length >= roles.length * 2
                  ? "Agents reached consensus — no opposing positions or shared-field disagreements detected across roles."
                  : "No conflicts detected yet. Edges appear when two roles disagree on a shared structured field or push the same metric in opposite directions."}
              </div>
            )}

          {/* Selected-edge detail popover */}
          {selectedEdge && (
            <div
              role="dialog"
              data-testid="conflict-detail-popover"
              className="absolute right-3 top-3 max-w-[280px] rounded border border-white/15 bg-black/90 p-3 text-[11px] leading-relaxed text-white/85 shadow-lg backdrop-blur"
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="font-semibold text-white">
                  {roleById.get(selectedEdge.source)?.name ?? "?"} {" "}
                  <span className="text-white/40">vs</span>{" "}
                  {roleById.get(selectedEdge.target)?.name ?? "?"}
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setSelectedEdgeKey(null)}
                  className="text-white/40 hover:text-white/80"
                >
                  ×
                </button>
              </div>
              <div className="space-y-2">
                {selectedEdge.evidence.slice(0, 3).map((e, i) => (
                  <div key={i} className="rounded bg-white/5 p-2">
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-white/45">
                      {e.field}
                      {e.sumA !== null && e.sumB !== null
                        ? `  (${e.sumA >= 0 ? "+" : ""}${e.sumA.toFixed(1)} vs ${e.sumB >= 0 ? "+" : ""}${e.sumB.toFixed(1)})`
                        : e.signA !== null && e.signB !== null
                          ? `  (${e.signA > 0 ? "+" : ""}${e.signA} vs ${e.signB > 0 ? "+" : ""}${e.signB})`
                          : ""}
                    </div>
                    <div className="text-white/75">
                      <span className="text-white/45">A:</span> {e.excerptA || "—"}
                    </div>
                    <div className="mt-1 text-white/75">
                      <span className="text-white/45">B:</span> {e.excerptB || "—"}
                    </div>
                  </div>
                ))}
                {selectedEdge.evidence.length > 3 && (
                  <div className="text-[10px] text-white/40">
                    +{selectedEdge.evidence.length - 3} more conflict signals
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
