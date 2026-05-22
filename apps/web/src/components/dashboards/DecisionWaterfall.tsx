"use client";

/**
 * DecisionWaterfall — authority-tiered cascade visualization.
 *
 * Renders one horizontal swim-lane per role, stacked vertically by
 * authority_rank descending (highest authority at the top, lowest at the
 * bottom). Each contribution is a chip in its source role's lane, positioned
 * along the x-axis by timestamp. Thin animated paths show the contribution
 * "cascading" down to lower-authority roles that engaged with it — derived
 * either from agent_requests (explicit from→to relationships) or from
 * contribution co-occurrence (a lower-rank role contributing within a short
 * window after the higher-rank source).
 *
 * Resolved artifact sections animate into a "Decision Pending" vault zone
 * pinned to the bottom of the canvas.
 *
 * Self-contained: fetches its own roles + contributions + agent_requests via
 * the shared dataProvider, mirroring the pattern used by AgentAffinityGraphRiver.
 * Tailwind + framer-motion only — no new deps.
 *
 * Spec: ?  Answer the question "is this decision actually moving through the
 * chain of command, or stuck at one level?" for a Duke clinical audience that
 * recognises the IRB → PI → committee structure.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { DashboardInfo } from "./DashboardInfo";
import {
  getRoles,
  getContributions,
  getArtifact,
  getQuorum,
} from "@/lib/dataProvider";

const WATERFALL_BLURB =
  "**Decision Waterfall.** Swim-lanes by authority rank. Contributions drop down as they engage lower-rank roles. A decision that reaches the bottom is ready to commit. Useful for spotting where a decision is stuck.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DecisionWaterfallProps {
  quorumId: string;
  /** SVG viewport width — defaults to 720. */
  width?: number;
  /** Height of each lane in px — defaults to 56. */
  laneHeight?: number;
  /** Override roles/contributions/agentRequests/artifact (for tests). */
  staticData?: {
    roles: RoleLike[];
    contributions: ContributionLike[];
    agentRequests?: AgentRequestLike[];
    resolvedSectionCount?: number;
    /** When true, render the vault as "Decision Resolved" rather than
     *  "Decision Pending". Mirrors quorum.status === 'resolved' in live mode. */
    quorumResolved?: boolean;
  };
  /** Override the now-clock — used in tests for deterministic layout. */
  nowMs?: number;
}

export interface RoleLike {
  id: string;
  name: string;
  authority_rank: number;
  color?: string;
  // Optional domain tags surfaced by the role-config UI; used for tinting
  // when a contribution doesn't carry its own tag block.
  domain_tags?: string[];
}

export interface ContributionLike {
  id: string;
  role_id: string;
  content: string;
  created_at: string;
  /** Optional pre-computed sentiment delta (positive=supportive, negative=dissenting). */
  analysis_delta?: number;
}

export interface AgentRequestLike {
  id: string;
  from_role_id: string;
  to_role_id: string;
  created_at: string;
}

// Derived per-contribution chip after layout.
interface Chip {
  id: string;
  roleId: string;
  laneIndex: number;
  x: number;
  y: number;
  color: string;
  delta: number; // -1..1 (rough sign for tint)
  createdAt: number;
  text: string;
}

// A cascade arrow: contribution -> later contribution from a lower-rank role.
interface Cascade {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  color: string;
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

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

// Words we treat as supportive vs dissenting when no analysis_delta is set.
const SUPPORTIVE_RE = /\b(agree|support|approve|endorse|concur|aligned)\b/i;
const DISSENT_RE = /\b(disagree|oppose|reject|dissent|concern|risk|block)\b/i;
// Time window (ms) during which a lower-rank contribution counts as
// "engagement" with an earlier higher-rank contribution.
const ENGAGEMENT_WINDOW_MS = 10 * 60_000; // 10 minutes

/** Sign-of-engagement heuristic from raw text. */
function deltaFromText(content: string, override?: number): number {
  if (typeof override === "number" && !Number.isNaN(override)) {
    return Math.max(-1, Math.min(1, override));
  }
  if (SUPPORTIVE_RE.test(content)) return 0.6;
  if (DISSENT_RE.test(content)) return -0.6;
  return 0;
}

/** Tint a base hex by sign — green-ish for support, red-ish for dissent. */
function chipColor(roleColor: string, delta: number): string {
  if (delta > 0.2) return "#34d399";
  if (delta < -0.2) return "#f87171";
  return roleColor;
}

function safeTime(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Format an epoch ms as HH:MM relative to the local zone. */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface LayoutInput {
  roles: RoleLike[];
  contributions: ContributionLike[];
  width: number;
  laneHeight: number;
  leftPad: number;
  rightPad: number;
  topPad: number;
  nowMs: number;
}

interface LayoutResult {
  lanes: { role: RoleLike; y: number; index: number; color: string }[];
  chips: Chip[];
  cascades: Cascade[];
  xMin: number;
  xMax: number;
  totalHeight: number;
}

function layout({
  roles,
  contributions,
  width,
  laneHeight,
  leftPad,
  rightPad,
  topPad,
  nowMs,
}: LayoutInput): LayoutResult {
  // Sort roles by authority_rank desc (highest at the top), tiebreak by name
  // for determinism.
  const sortedRoles = [...roles].sort((a, b) => {
    if (b.authority_rank !== a.authority_rank) {
      return b.authority_rank - a.authority_rank;
    }
    return a.name.localeCompare(b.name);
  });

  const roleIndex = new Map<string, number>();
  sortedRoles.forEach((r, i) => roleIndex.set(r.id, i));

  const lanes = sortedRoles.map((role, i) => {
    const baseColor = role.color || FALLBACK_PALETTE[i % FALLBACK_PALETTE.length];
    return {
      role,
      y: topPad + i * laneHeight + laneHeight / 2,
      index: i,
      color: baseColor,
    };
  });

  // Time axis: use the contribution timestamps (or fall back to now-30min)
  const times = contributions.map((c) => safeTime(c.created_at));
  const tMax = times.length > 0 ? Math.max(...times, nowMs) : nowMs;
  const tMinCandidate =
    times.length > 0 ? Math.min(...times) : nowMs - 30 * 60_000;
  // Ensure at least a 5-minute window so a single chip doesn't pin to the edge.
  const tMin = Math.min(tMinCandidate, tMax - 5 * 60_000);

  const plotWidth = Math.max(80, width - leftPad - rightPad);

  function xFromTime(ms: number): number {
    if (tMax === tMin) return leftPad + plotWidth / 2;
    const t = (ms - tMin) / (tMax - tMin);
    return leftPad + Math.max(0, Math.min(1, t)) * plotWidth;
  }

  const chips: Chip[] = contributions
    .filter((c) => roleIndex.has(c.role_id))
    .map((c) => {
      const idx = roleIndex.get(c.role_id)!;
      const lane = lanes[idx];
      const delta = deltaFromText(c.content, c.analysis_delta);
      return {
        id: c.id,
        roleId: c.role_id,
        laneIndex: idx,
        x: xFromTime(safeTime(c.created_at)),
        y: lane.y,
        color: chipColor(lane.color, delta),
        delta,
        createdAt: safeTime(c.created_at),
        text: c.content,
      };
    });

  // Derive cascades: for each chip in lane k, find the next chip in any lane
  // k' > k (lower authority) within ENGAGEMENT_WINDOW_MS. We connect only the
  // earliest engagement per (source-chip, target-lane) pair to keep the
  // visualisation legible.
  const cascades: Cascade[] = [];
  // Sort chips by time for the lookup.
  const chipsByTime = [...chips].sort((a, b) => a.createdAt - b.createdAt);
  for (const src of chipsByTime) {
    const seenLanes = new Set<number>();
    for (const candidate of chipsByTime) {
      if (candidate.createdAt <= src.createdAt) continue;
      if (candidate.createdAt - src.createdAt > ENGAGEMENT_WINDOW_MS) break;
      if (candidate.laneIndex <= src.laneIndex) continue;
      if (seenLanes.has(candidate.laneIndex)) continue;
      seenLanes.add(candidate.laneIndex);
      cascades.push({
        id: `${src.id}->${candidate.id}`,
        fromX: src.x,
        fromY: src.y,
        toX: candidate.x,
        toY: candidate.y,
        color: src.color,
      });
    }
  }

  return {
    lanes,
    chips,
    cascades,
    xMin: leftPad,
    xMax: leftPad + plotWidth,
    totalHeight: topPad + sortedRoles.length * laneHeight,
  };
}

/** Fold any explicit agent_requests into cascade arrows.  When a request
 *  goes from a higher-rank role to a lower-rank role we draw a stronger
 *  cascade chip-to-chip; the request itself is rendered as a dashed faint
 *  arrow when no matching pair of chips can be found.  */
function cascadesFromAgentRequests(
  requests: AgentRequestLike[],
  chips: Chip[],
  roleLaneIndex: Map<string, number>,
  width: number,
  leftPad: number,
  rightPad: number,
  topPad: number,
  laneHeight: number,
  tMin: number,
  tMax: number,
): Cascade[] {
  const out: Cascade[] = [];
  if (requests.length === 0) return out;
  const plotWidth = Math.max(80, width - leftPad - rightPad);
  const xFromTime = (ms: number) => {
    if (tMax === tMin) return leftPad + plotWidth / 2;
    const t = (ms - tMin) / (tMax - tMin);
    return leftPad + Math.max(0, Math.min(1, t)) * plotWidth;
  };

  for (const req of requests) {
    const fromIdx = roleLaneIndex.get(req.from_role_id);
    const toIdx = roleLaneIndex.get(req.to_role_id);
    if (fromIdx === undefined || toIdx === undefined) continue;
    // Only model cascades that flow downward (higher -> lower authority).
    if (toIdx <= fromIdx) continue;
    const ts = safeTime(req.created_at);

    // Try to anchor on real chips first.
    const srcChip = [...chips]
      .filter((c) => c.laneIndex === fromIdx && c.createdAt <= ts)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const tgtChip = [...chips]
      .filter((c) => c.laneIndex === toIdx && c.createdAt >= ts)
      .sort((a, b) => a.createdAt - b.createdAt)[0];

    const fromX = srcChip ? srcChip.x : xFromTime(ts);
    const toX = tgtChip ? tgtChip.x : xFromTime(ts);
    const fromY = topPad + fromIdx * laneHeight + laneHeight / 2;
    const toY = topPad + toIdx * laneHeight + laneHeight / 2;
    out.push({
      id: `req:${req.id}`,
      fromX,
      fromY,
      toX,
      toY,
      color: srcChip?.color ?? "#a78bfa",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DecisionWaterfall({
  quorumId,
  width = 720,
  laneHeight = 56,
  staticData,
  nowMs,
}: DecisionWaterfallProps) {
  const reduceMotion = useReducedMotion();

  const [roles, setRoles] = useState<RoleLike[] | null>(
    staticData?.roles ?? null,
  );
  const [contributions, setContributions] = useState<ContributionLike[]>(
    staticData?.contributions ?? [],
  );
  const [agentRequests, setAgentRequests] = useState<AgentRequestLike[]>(
    staticData?.agentRequests ?? [],
  );
  const [resolvedCount, setResolvedCount] = useState<number>(
    staticData?.resolvedSectionCount ?? 0,
  );
  const [quorumResolved, setQuorumResolved] = useState<boolean>(
    staticData?.quorumResolved ?? false,
  );
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Fetch roles + contributions + artifact (skipped when staticData is set)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (staticData) return;
    let cancelled = false;

    async function load() {
      try {
        const [rolesRaw, contribsRaw, artifactRaw, quorumRaw] = await Promise.all([
          getRoles(quorumId),
          getContributions(quorumId),
          getArtifact(quorumId),
          getQuorum(quorumId),
        ]);
        if (cancelled || !mountedRef.current) return;

        // The Role / Contribution shape varies slightly between live and demo
        // — be defensive here and only pull what we strictly need.
        const mappedRoles: RoleLike[] = (rolesRaw ?? []).map((r) => {
          const raw = r as unknown as Record<string, unknown>;
          return {
            id: String(raw.id ?? ""),
            name: String(raw.name ?? "Unnamed Role"),
            authority_rank: Number(raw.authority_rank ?? 0),
            color: typeof raw.color === "string" ? raw.color : undefined,
            domain_tags: Array.isArray(raw.domain_tags)
              ? (raw.domain_tags as string[])
              : undefined,
          };
        });

        const mappedContribs: ContributionLike[] = (contribsRaw ?? []).map(
          (c) => {
            const raw = c as unknown as Record<string, unknown>;
            return {
              id: String(raw.id ?? ""),
              role_id: String(raw.role_id ?? ""),
              content: String(raw.content ?? ""),
              created_at: String(raw.created_at ?? new Date().toISOString()),
              analysis_delta:
                typeof raw.analysis_delta === "number"
                  ? (raw.analysis_delta as number)
                  : undefined,
            };
          },
        );

        // Resolved-section counting.  We prefer the explicit
        // `section.status === 'resolved'` marker when sections actually carry
        // a status field (older artifact shapes / future schemas) — but real
        // production artifacts ship sections with only {title, content,
        // source_contribution_ids}, no per-section status.  In that case we
        // fall back to counting *all* sections, because the artifact-synthesis
        // pipeline only emits a section once that slice of the decision has
        // been ratified.  This keeps the vault accurate for resolved quorums
        // instead of always reporting "0 resolved".
        const artifactSections =
          (artifactRaw as unknown as { sections?: Array<Record<string, unknown>> } | null)
            ?.sections;
        let resolved = 0;
        if (Array.isArray(artifactSections) && artifactSections.length > 0) {
          const withStatus = artifactSections.filter(
            (s) => typeof s.status === "string",
          );
          if (withStatus.length > 0) {
            resolved = withStatus.filter((s) => s.status === "resolved").length;
          } else {
            // No per-section status field — every emitted section counts.
            resolved = artifactSections.length;
          }
        }

        // Is the quorum itself resolved?  Drives the vault label between
        // "Decision Pending" and "Decision Resolved".  Note artifact.status
        // is unreliable here — it stays "draft" even on quorums that have
        // been marked resolved via /resolve, since the artifact-synthesis
        // step doesn't always flip it.
        const quorumStatus =
          (quorumRaw as unknown as { status?: string } | null)?.status ?? "";
        const isResolved = quorumStatus === "resolved";

        setRoles(mappedRoles);
        setContributions(mappedContribs);
        setResolvedCount(resolved);
        setQuorumResolved(isResolved);
        setError(null);
      } catch (e) {
        if (cancelled || !mountedRef.current) return;
        setError(e instanceof Error ? e.message : "load failed");
        setRoles([]);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [quorumId, staticData]);

  // Note: We deliberately *don't* subscribe to realtime here.  This dashboard
  // is rendered in the projection carousel, which already remounts on rotate
  // — the parent reload is sufficient cadence for a "is the decision moving"
  // strategic view.  Agent requests are only fetched in the static path.

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------
  const leftPad = 132;
  const rightPad = 24;
  const topPad = 8;
  const vaultHeight = 70;

  const safeRoles = roles ?? [];

  const baseLayout = useMemo(() => {
    if (safeRoles.length === 0) return null;
    return layout({
      roles: safeRoles,
      contributions,
      width,
      laneHeight,
      leftPad,
      rightPad,
      topPad,
      nowMs: nowMs ?? Date.now(),
    });
  }, [safeRoles, contributions, width, laneHeight, nowMs]);

  const requestCascades = useMemo<Cascade[]>(() => {
    if (!baseLayout || agentRequests.length === 0) return [];
    const sorted = [...safeRoles].sort((a, b) => {
      if (b.authority_rank !== a.authority_rank) {
        return b.authority_rank - a.authority_rank;
      }
      return a.name.localeCompare(b.name);
    });
    const idx = new Map<string, number>();
    sorted.forEach((r, i) => idx.set(r.id, i));

    const times = contributions.map((c) => safeTime(c.created_at));
    const now = nowMs ?? Date.now();
    const tMax = times.length > 0 ? Math.max(...times, now) : now;
    const tMin =
      times.length > 0
        ? Math.min(Math.min(...times), tMax - 5 * 60_000)
        : tMax - 30 * 60_000;

    return cascadesFromAgentRequests(
      agentRequests,
      baseLayout.chips,
      idx,
      width,
      leftPad,
      rightPad,
      topPad,
      laneHeight,
      tMin,
      tMax,
    );
  }, [baseLayout, agentRequests, safeRoles, contributions, width, laneHeight, nowMs]);

  // -------------------------------------------------------------------------
  // Loading / empty states
  // -------------------------------------------------------------------------
  if (!staticData && roles === null) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="decision-waterfall-loading"
      >
        <span className="text-sm text-white/40 animate-pulse">
          Loading waterfall…
        </span>
      </div>
    );
  }

  if (safeRoles.length === 0) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 text-center"
        data-testid="decision-waterfall-empty"
      >
        <p className="text-sm text-white/40">
          Waterfall fills as decisions cascade through authority tiers — no
          decisions in flight yet.
        </p>
        {error && (
          <p className="text-[10px] text-red-400/70" data-testid="decision-waterfall-error">
            {error}
          </p>
        )}
      </div>
    );
  }

  const allCascades: Cascade[] = baseLayout
    ? [...baseLayout.cascades, ...requestCascades]
    : [];

  const totalHeight = (baseLayout?.totalHeight ?? topPad) + vaultHeight + 12;

  return (
    <div
      className="flex h-full w-full flex-col gap-2 overflow-y-auto p-2"
      data-testid="decision-waterfall"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold text-white/90">
            Decision Waterfall
          </h3>
          <DashboardInfo blurb={WATERFALL_BLURB} />
        </div>
        <span className="text-xs text-white/40" data-testid="decision-waterfall-vault-count">
          {resolvedCount} resolved
        </span>
      </div>

      <div className="relative w-full">
        <svg
          width={width}
          height={totalHeight}
          viewBox={`0 0 ${width} ${totalHeight}`}
          className="block max-w-full"
          aria-label="Decision waterfall — contributions cascading through authority tiers"
        >
          <defs>
            <marker
              id="dw-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>

          {/* Lane backgrounds + labels */}
          {baseLayout?.lanes.map((lane) => {
            const yTop = lane.y - laneHeight / 2;
            return (
              <g key={lane.role.id} data-testid={`waterfall-lane-${lane.role.id}`}>
                <rect
                  x={0}
                  y={yTop}
                  width={width}
                  height={laneHeight}
                  fill={lane.index % 2 === 0 ? "rgba(255,255,255,0.025)" : "rgba(255,255,255,0.04)"}
                />
                <line
                  x1={leftPad}
                  x2={width - rightPad}
                  y1={lane.y}
                  y2={lane.y}
                  stroke="rgba(255,255,255,0.05)"
                  strokeDasharray="2 4"
                />
                {/* Authority pip */}
                <circle
                  cx={leftPad - 16}
                  cy={lane.y}
                  r={4}
                  fill={lane.color}
                  fillOpacity={0.85}
                />
                <text
                  x={leftPad - 26}
                  y={lane.y - 2}
                  textAnchor="end"
                  className="fill-white/80"
                  style={{ fontSize: 11, fontWeight: 600 }}
                >
                  {lane.role.name.length > 16
                    ? lane.role.name.slice(0, 15) + "…"
                    : lane.role.name}
                </text>
                <text
                  x={leftPad - 26}
                  y={lane.y + 11}
                  textAnchor="end"
                  className="fill-white/40"
                  style={{ fontSize: 9 }}
                >
                  rank {lane.role.authority_rank}
                </text>
              </g>
            );
          })}

          {/* Cascade paths */}
          {allCascades.map((c) => {
            const midY = (c.fromY + c.toY) / 2;
            const d = `M ${c.fromX} ${c.fromY} C ${c.fromX} ${midY}, ${c.toX} ${midY}, ${c.toX} ${c.toY}`;
            if (reduceMotion) {
              return (
                <path
                  key={c.id}
                  d={d}
                  stroke={c.color}
                  strokeOpacity={0.5}
                  strokeWidth={1.2}
                  fill="none"
                  data-testid="waterfall-cascade"
                />
              );
            }
            return (
              <motion.path
                key={c.id}
                d={d}
                stroke={c.color}
                strokeOpacity={0.5}
                strokeWidth={1.2}
                fill="none"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 0.9, ease: "easeOut" }}
                data-testid="waterfall-cascade"
              />
            );
          })}

          {/* Contribution chips */}
          {baseLayout?.chips.map((chip) => {
            const radius = 8;
            const chipNode = (
              <g key={chip.id} data-testid={`waterfall-chip-${chip.id}`}>
                <circle
                  cx={chip.x}
                  cy={chip.y}
                  r={radius}
                  fill={chip.color}
                  fillOpacity={0.9}
                  stroke="rgba(0,0,0,0.6)"
                  strokeWidth={1}
                />
                <title>
                  {fmtClock(chip.createdAt)} —{" "}
                  {chip.text.slice(0, 80)}
                  {chip.text.length > 80 ? "…" : ""}
                </title>
              </g>
            );
            if (reduceMotion) return chipNode;
            return (
              <motion.g
                key={chip.id}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35 }}
              >
                {chipNode}
              </motion.g>
            );
          })}

          {/* Decision Pending vault */}
          {(() => {
            const vaultTop = (baseLayout?.totalHeight ?? topPad) + 8;
            const vaultCenterX = width / 2;
            const vaultCenterY = vaultTop + vaultHeight / 2;
            return (
              <g data-testid="decision-waterfall-vault">
                <rect
                  x={leftPad - 8}
                  y={vaultTop}
                  width={width - leftPad - rightPad + 8}
                  height={vaultHeight}
                  rx={8}
                  fill="rgba(52, 211, 153, 0.06)"
                  stroke="rgba(52, 211, 153, 0.3)"
                  strokeDasharray="4 4"
                />
                <text
                  x={leftPad}
                  y={vaultTop + 18}
                  className="fill-emerald-300/80"
                  style={{ fontSize: 11, fontWeight: 600 }}
                  data-testid="decision-waterfall-vault-label"
                >
                  {quorumResolved ? "Decision Resolved" : "Decision Pending"}
                </text>
                <text
                  x={leftPad}
                  y={vaultTop + 34}
                  className="fill-white/40"
                  style={{ fontSize: 9 }}
                >
                  {quorumResolved
                    ? "Quorum closed — artifact synthesized."
                    : "Resolved artifact sections drop in here."}
                </text>
                {/* Vault icon */}
                <g
                  transform={`translate(${vaultCenterX + 80}, ${vaultCenterY - 12})`}
                  className="fill-emerald-300/70"
                >
                  <rect width={28} height={22} rx={3} fill="none" stroke="currentColor" strokeWidth={1.4} />
                  <circle cx={14} cy={11} r={4.5} fill="none" stroke="currentColor" strokeWidth={1.4} />
                  <line x1={14} y1={2} x2={14} y2={6} stroke="currentColor" strokeWidth={1.4} />
                </g>
                {/* Resolved-count chips inside vault */}
                {Array.from({ length: Math.min(resolvedCount, 6) }).map((_, i) => {
                  const cx = leftPad + 200 + i * 22;
                  const cy = vaultTop + vaultHeight / 2;
                  if (reduceMotion) {
                    return (
                      <circle
                        key={i}
                        cx={cx}
                        cy={cy}
                        r={7}
                        fill="#34d399"
                        fillOpacity={0.9}
                        data-testid="waterfall-vault-chip"
                      />
                    );
                  }
                  return (
                    <motion.circle
                      key={i}
                      cx={cx}
                      cy={cy}
                      r={7}
                      fill="#34d399"
                      fillOpacity={0.9}
                      initial={{ opacity: 0, y: -20 }}
                      animate={{ opacity: 0.9, y: 0 }}
                      transition={{ duration: 0.5, delay: 0.15 * i }}
                      data-testid="waterfall-vault-chip"
                    />
                  );
                })}
              </g>
            );
          })()}
        </svg>

        {/* Sparse-state hint */}
        {baseLayout && baseLayout.chips.length === 0 && (
          <div
            className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-xs text-white/40"
            data-testid="decision-waterfall-sparse"
          >
            Lanes are live — drop a contribution to start the cascade.
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="mt-1 flex flex-wrap items-center gap-3 px-1 text-[10px] text-white/50">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
          supportive
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-red-400" />
          dissenting
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-slate-400" />
          neutral
        </span>
        <span className="ml-auto">x = time · y = authority rank (high→low)</span>
      </div>
    </div>
  );
}

export default DecisionWaterfall;
