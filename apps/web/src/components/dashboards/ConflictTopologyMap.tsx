"use client";

/**
 * ConflictTopologyMap — network graph that surfaces *where disagreement lives*
 * in a quorum.
 *
 * Each role is a node arranged on a stable ring layout (no d3-force). An edge
 * is drawn between two roles ONLY when a conflict is detected between them.
 *
 * Conflict detection — fully client-side, no new backend endpoint needed.
 * For every pair (A, B) of roles in the quorum we look for:
 *
 *   1. **Field overlap** — both roles produced contributions whose
 *      `structured_fields` share a key (e.g. both wrote about
 *      `patient_consent`).  Each shared field is one "potential conflict".
 *
 *   2. **Opposing analysis_deltas** — both roles emitted Tier-2 analyzer
 *      `analysis_deltas` for the same metric with opposing signs (one pushed
 *      consensus up, the other pushed it down).  Each opposing metric is
 *      one "active conflict".
 *
 * Edges accumulate evidence from both signals; the heaviest evidence
 * wins for colour (red = at least one opposing delta, green = field overlap
 * only / resolved).  Thickness scales 1..5 with the total conflict count.
 *
 * Component is self-contained: takes only { quorumId } as a prop.  Pulls
 * roles + contributions from the shared dataProvider and subscribes to
 * realtime contribution inserts so the topology re-computes live.
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
  "**Conflict Topology Map.** Edges show where roles disagree on the same question. Thicker red = more conflicts. Click an edge to see the opposing positions side-by-side. A clean graph means consensus; a tangled graph means the quorum is wrestling.";

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

/**
 * Detect conflict edges from a list of contributions and roles.
 *
 * Pure function — exported so tests can drive it with deterministic fixtures
 * and so the live component can re-run it whenever the contribution list
 * mutates.
 */
export function detectConflictEdges(
  roles: RoleRow[],
  contributions: ContribRow[],
): ConflictEdge[] {
  if (roles.length < 2 || contributions.length < 2) return [];

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

  // Collect analysis_deltas per role keyed by metric.  Sign = sum of signs of
  // the deltas this role emitted on the metric, then re-signed at the end.
  const deltaSignByRole = new Map<string, Map<string, number>>();
  for (const r of roles) deltaSignByRole.set(r.id, new Map());
  for (const c of contributions) {
    const m = deltaSignByRole.get(c.role_id);
    if (!m) continue;
    const deltas = c.analysis_deltas ?? {};
    for (const [metric, v] of Object.entries(deltas)) {
      if (typeof v !== "number" || v === 0) continue;
      const prior = m.get(metric) ?? 0;
      m.set(metric, prior + sign(v));
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
        });
      }

      // (2) Opposing analysis_deltas on the same metric
      const emptyDeltaMap: Map<string, number> = new Map();
      const deltasA = deltaSignByRole.get(a.id) ?? emptyDeltaMap;
      const deltasB = deltaSignByRole.get(b.id) ?? emptyDeltaMap;
      const metricKeysA: string[] = Array.from(deltasA.keys());
      for (const metric of metricKeysA) {
        if (!deltasB.has(metric)) continue;
        const sa = sign(deltasA.get(metric)!);
        const sb = sign(deltasB.get(metric)!);
        if (sa !== 0 && sb !== 0 && sa !== sb) {
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
          });
        }
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

function nodeRadius(authorityRank: number | undefined): number {
  // 16 (rank 0) .. 30 (rank 5+)
  const rank = authorityRank ?? 0;
  return Math.min(30, 16 + rank * 2.5);
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
          <h3 className="text-sm font-semibold text-white/90">Conflict Topology</h3>
          <DashboardInfo blurb={CONFLICT_BLURB} />
        </div>
        <div className="flex items-center gap-3 text-[10px] text-white/40">
          <span className="flex items-center gap-1">
            <span className="inline-block h-[3px] w-5 rounded" style={{ background: "#f87171" }} />
            active conflict
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-[3px] w-5 rounded" style={{ background: "#34d399" }} />
            field overlap
          </span>
        </div>
      </div>

      {connState !== "ready" && roles.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-white/40">
          {connState === "connecting"
            ? "Connecting…"
            : "No conflicts detected yet — waiting for roles. Edges appear when two roles disagree on a shared structured field or push the same metric in opposite directions."}
        </div>
      ) : (
        <div className="relative flex-1 min-h-0">
          <svg
            viewBox={`0 0 ${PANEL_WIDTH} ${PANEL_HEIGHT}`}
            className="h-full w-full"
            role="img"
            aria-label="Conflict topology map"
            data-testid="conflict-topology-svg"
          >
            {/* Edges first */}
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
                    strokeOpacity={dim ? 0.15 : isSelected ? 1 : 0.75}
                    initial={reduceMotion ? false : { pathLength: 0 }}
                    animate={reduceMotion ? undefined : { pathLength: 1 }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                    style={{ pointerEvents: "none" }}
                    data-testid={`conflict-edge-${edge.source}-${edge.target}`}
                  />
                  {/* Edge label with field count */}
                  <text
                    x={(a.x + b.x) / 2}
                    y={(a.y + b.y) / 2 - 4}
                    textAnchor="middle"
                    fontSize={10}
                    fill={stroke}
                    fillOpacity={dim ? 0.2 : 0.85}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {edge.evidence[0]?.field}
                    {edge.count > 1 ? ` +${edge.count - 1}` : ""}
                  </text>
                </g>
              );
            })}

            {/* Nodes */}
            {roles.map((role) => {
              const p = positions.get(role.id);
              if (!p) return null;
              const r = nodeRadius(role.authority_rank);
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
                >
                  <circle
                    r={r}
                    fill={fill}
                    fillOpacity={dim ? 0.1 : 0.25}
                    stroke={fill}
                    strokeWidth={1.5}
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

          {/* Empty-conflicts hint overlay (nodes present, no edges).
              Copy varies by signal-richness of the data we DID see, so the
              audience can tell "no inputs yet" apart from "agents legitimately
              agreed".  Heuristic: any role with >=2 contributions means there
              was enough material to surface tension if it existed. */}
          {edges.length === 0 && roles.length > 0 && (
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
                      {e.signA !== null && e.signB !== null
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
