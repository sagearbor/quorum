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
 * Visual encoding (post-2026-05 redesign):
 *  - Real time x-axis with HH:MM tick labels + faint vertical gridlines.
 *  - Chip radius encoded by |Δ| magnitude across the five analysis_deltas
 *    metrics (consensus, completion, blockers, critical_path, role_coverage).
 *  - Tier band: each lane gets a coloured left-edge stripe by authority_rank.
 *  - Same-second jitter: chips colliding on a single pixel are nudged ±2-3px
 *    on the y-axis to stay individually clickable.
 *  - Empty lanes get a diagonal stripe pattern + "awaiting input" hint.
 *  - Chip <title> tooltips include the LLM analysis_rationale snippet.
 *
 * Self-contained: fetches its own roles + contributions + agent_requests via
 * the shared dataProvider, mirroring the pattern used by AgentAffinityGraphRiver.
 * Tailwind + framer-motion only — no new deps.
 *
 * Spec: Answer the question "is this decision actually moving through the
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
  "**Decision Waterfall.** Swim-lanes by authority rank. Contributions drop down as they engage lower-rank roles. Chip size = magnitude of the analysis delta (sum of |Δ| across consensus/completion/blockers/critical_path/role_coverage). A decision that reaches the bottom is ready to commit.";

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
  /** Optional pre-computed single-number sentiment delta (legacy / fallback). */
  analysis_delta?: number;
  /** LLM-emitted per-metric deltas (consensus, completion, blockers,
   *  critical_path, role_coverage). Used to size chips by magnitude. */
  analysis_deltas?: Record<string, number>;
  /** LLM-emitted rationale string — surfaced in the chip <title> tooltip. */
  analysis_rationale?: string;
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
  /** Chip radius in px — encodes |Δ| magnitude. */
  radius: number;
  color: string;
  delta: number; // -1..1 (rough sign for tint)
  /** Sum-of-absolute-deltas magnitude for hover label. */
  magnitude: number;
  createdAt: number;
  text: string;
  /** First 120 chars of analysis_rationale (or content) for the title tooltip. */
  rationale: string;
  /** Role display name — surfaced in the tooltip. */
  roleName: string;
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

// Chip radius bounds (px). 4 is the smallest legible dot; 12 keeps even loud
// chips from blocking the lane label.
const RADIUS_MIN = 4;
const RADIUS_MAX = 12;
// Magnitude that maps to radius=RADIUS_MAX. Calibrated against the live
// clinical-trial quorum where strong moves sit around |Δ|=30-45 across the
// five metrics; 40 keeps mid-strength chips visibly larger than no-op chips
// without flattening the top end.
const MAGNITUDE_ANCHOR = 40;

// Tier band stripe colours, keyed by authority_rank. Higher rank = warmer
// amber (more visual weight); lower rank fades into slate.
const TIER_STRIPE_COLORS: Record<number, string> = {
  5: "rgba(251, 191, 36, 0.95)", // warm amber
  4: "rgba(252, 211, 77, 0.75)", // lighter amber
  3: "rgba(148, 163, 184, 0.7)", // gray
  2: "rgba(100, 116, 139, 0.7)", // slate
  1: "rgba(71, 85, 105, 0.7)", // darker slate
};
const TIER_STRIPE_DEFAULT = "rgba(100, 116, 139, 0.55)";

function tierStripeColor(rank: number): string {
  if (rank in TIER_STRIPE_COLORS) return TIER_STRIPE_COLORS[rank];
  if (rank >= 5) return TIER_STRIPE_COLORS[5];
  if (rank <= 1) return TIER_STRIPE_COLORS[1];
  return TIER_STRIPE_DEFAULT;
}

/** Sign-of-engagement heuristic from raw text. */
function deltaFromText(content: string, override?: number): number {
  if (typeof override === "number" && !Number.isNaN(override)) {
    return Math.max(-1, Math.min(1, override));
  }
  if (SUPPORTIVE_RE.test(content)) return 0.6;
  if (DISSENT_RE.test(content)) return -0.6;
  return 0;
}

/** Sum of absolute values across the per-metric deltas dict. */
function magnitudeFromDeltas(
  deltas: Record<string, number> | undefined,
  fallbackDelta?: number,
): number {
  if (deltas && Object.keys(deltas).length > 0) {
    let sum = 0;
    for (const v of Object.values(deltas)) {
      if (typeof v === "number" && Number.isFinite(v)) sum += Math.abs(v);
    }
    return sum;
  }
  if (typeof fallbackDelta === "number" && Number.isFinite(fallbackDelta)) {
    // Legacy scalar delta is in [-1..1]. Scale to a comparable order by
    // assuming a "moderate" event ~= 0.5 * MAGNITUDE_ANCHOR.
    return Math.abs(fallbackDelta) * (MAGNITUDE_ANCHOR / 2);
  }
  return 0;
}

/** Normalise magnitude [0..1] then map to radius [RADIUS_MIN..RADIUS_MAX]. */
function radiusFromMagnitude(mag: number): number {
  const norm = Math.max(0, Math.min(1, mag / MAGNITUDE_ANCHOR));
  return RADIUS_MIN + norm * (RADIUS_MAX - RADIUS_MIN);
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

/** Format an epoch ms as HH:MM:SS relative to the local zone. */
function fmtClockSec(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

/** Pick "nice" tick spacing in ms for a given span and target tick count. */
function niceTickStepMs(spanMs: number, targetTicks: number): number {
  if (spanMs <= 0) return 60_000;
  const raw = spanMs / Math.max(1, targetTicks);
  const candidates = [
    15_000,
    30_000,
    60_000,
    2 * 60_000,
    5 * 60_000,
    10 * 60_000,
    15 * 60_000,
    30 * 60_000,
    60 * 60_000,
    2 * 3_600_000,
    6 * 3_600_000,
    12 * 3_600_000,
    24 * 3_600_000,
  ];
  for (const c of candidates) {
    if (c >= raw) return c;
  }
  return candidates[candidates.length - 1];
}

/** Build 5-8 tick timestamps spanning [tMin..tMax] aligned to whole units. */
function buildTickTimes(tMin: number, tMax: number, target = 6): number[] {
  if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax <= tMin) {
    return [tMin];
  }
  const step = niceTickStepMs(tMax - tMin, target);
  const first = Math.ceil(tMin / step) * step;
  const ticks: number[] = [];
  for (let t = first; t <= tMax + 1; t += step) {
    ticks.push(t);
    if (ticks.length >= 10) break;
  }
  // Drop ticks that would crowd the right edge by < 10% of the span.
  const minGap = (tMax - tMin) * 0.05;
  return ticks.filter((t) => t - tMin >= 0 && tMax - t >= -minGap);
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
  /** Computed for the x-axis renderer. */
  tMin: number;
  tMax: number;
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

  // First pass: build chips, tracking per-(lane,second) collisions so we can
  // jitter colliding chips off the lane midline.
  type ProtoChip = Omit<Chip, "y"> & {
    laneY: number;
    bucketKey: string;
  };

  const protoChips: ProtoChip[] = contributions
    .filter((c) => roleIndex.has(c.role_id))
    .map((c) => {
      const idx = roleIndex.get(c.role_id)!;
      const lane = lanes[idx];
      const delta = deltaFromText(c.content, c.analysis_delta);
      const magnitude = magnitudeFromDeltas(c.analysis_deltas, c.analysis_delta);
      const radius = radiusFromMagnitude(magnitude);
      const tMs = safeTime(c.created_at);
      const secondBucket = Math.floor(tMs / 1000);
      const rationaleSource =
        (c.analysis_rationale && c.analysis_rationale.trim()) || c.content || "";
      const rationale =
        rationaleSource.length > 120
          ? rationaleSource.slice(0, 120) + "…"
          : rationaleSource;
      return {
        id: c.id,
        roleId: c.role_id,
        laneIndex: idx,
        x: xFromTime(tMs),
        laneY: lane.y,
        radius,
        color: chipColor(lane.color, delta),
        delta,
        magnitude,
        createdAt: tMs,
        text: c.content,
        rationale,
        roleName: lane.role.name,
        bucketKey: `${idx}|${secondBucket}`,
      };
    });

  // Count collisions per (lane, second) bucket so we can spread within-lane
  // overlapping chips vertically. Single-chip buckets stay on the midline.
  const bucketCounts = new Map<string, number>();
  for (const p of protoChips) {
    bucketCounts.set(p.bucketKey, (bucketCounts.get(p.bucketKey) ?? 0) + 1);
  }
  const bucketSeen = new Map<string, number>();
  const maxJitter = Math.min(3, Math.max(2, laneHeight / 22)); // 2-3 px

  const chips: Chip[] = protoChips.map((p) => {
    const total = bucketCounts.get(p.bucketKey) ?? 1;
    if (total <= 1) {
      return { ...p, y: p.laneY } as Chip;
    }
    // Spread N chips symmetrically across [-maxJitter..+maxJitter].
    const seenIdx = bucketSeen.get(p.bucketKey) ?? 0;
    bucketSeen.set(p.bucketKey, seenIdx + 1);
    // Map seenIdx in [0..total-1] to a symmetric offset.
    const t = total === 1 ? 0.5 : seenIdx / (total - 1);
    const offset = (t - 0.5) * 2 * maxJitter;
    return { ...p, y: p.laneY + offset } as Chip;
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
    tMin,
    tMax,
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
            const rawDeltas = raw.analysis_deltas;
            let deltas: Record<string, number> | undefined;
            if (rawDeltas && typeof rawDeltas === "object" && !Array.isArray(rawDeltas)) {
              const out: Record<string, number> = {};
              for (const [k, v] of Object.entries(rawDeltas as Record<string, unknown>)) {
                const n = typeof v === "number" ? v : Number(v);
                if (Number.isFinite(n)) out[k] = n;
              }
              if (Object.keys(out).length > 0) deltas = out;
            }
            return {
              id: String(raw.id ?? ""),
              role_id: String(raw.role_id ?? ""),
              content: String(raw.content ?? ""),
              created_at: String(raw.created_at ?? new Date().toISOString()),
              analysis_delta:
                typeof raw.analysis_delta === "number"
                  ? (raw.analysis_delta as number)
                  : undefined,
              analysis_deltas: deltas,
              analysis_rationale:
                typeof raw.analysis_rationale === "string"
                  ? (raw.analysis_rationale as string)
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
  // Strip of space reserved below the lane area for the x-axis tick labels.
  const axisHeight = 22;
  // Width of the tier band stripe pinned to the left of each lane.
  const tierStripeWidth = 5;

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

    return cascadesFromAgentRequests(
      agentRequests,
      baseLayout.chips,
      idx,
      width,
      leftPad,
      rightPad,
      topPad,
      laneHeight,
      baseLayout.tMin,
      baseLayout.tMax,
    );
  }, [baseLayout, agentRequests, safeRoles, width, laneHeight]);

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

  // Axis ticks live in the strip *between* the lane area and the vault.
  const axisTopY = baseLayout?.totalHeight ?? topPad;
  const axisLabelY = axisTopY + 14;
  const ticks = baseLayout
    ? buildTickTimes(baseLayout.tMin, baseLayout.tMax, 6)
    : [];

  // Group chips by lane so we can detect empty lanes for the awaiting-input
  // stripe overlay.
  const chipsByLane = new Map<number, Chip[]>();
  if (baseLayout) {
    for (const ch of baseLayout.chips) {
      const arr = chipsByLane.get(ch.laneIndex);
      if (arr) arr.push(ch);
      else chipsByLane.set(ch.laneIndex, [ch]);
    }
  }

  const totalHeight =
    (baseLayout?.totalHeight ?? topPad) + axisHeight + vaultHeight + 12;

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
            {/* Diagonal stripe pattern used to fill empty-lane backgrounds. */}
            <pattern
              id="dw-empty-stripe"
              width="8"
              height="8"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(-45)"
            >
              <rect width="8" height="8" fill="rgba(255,255,255,0.015)" />
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="8"
                stroke="rgba(255,255,255,0.06)"
                strokeWidth="2"
              />
            </pattern>
          </defs>

          {/* Lane backgrounds + labels + tier stripes */}
          {baseLayout?.lanes.map((lane) => {
            const yTop = lane.y - laneHeight / 2;
            const stripeFill = tierStripeColor(lane.role.authority_rank);
            const labelTint = stripeFill.replace(/[\d.]+\)$/, "0.18)");
            const laneChips = chipsByLane.get(lane.index) ?? [];
            const isEmpty = laneChips.length === 0;
            return (
              <g key={lane.role.id} data-testid={`waterfall-lane-${lane.role.id}`}>
                {/* Subtle label-area tint (left of the plot) using the tier color. */}
                <rect
                  x={0}
                  y={yTop}
                  width={leftPad - 4}
                  height={laneHeight}
                  fill={labelTint}
                />
                {/* Alternating lane row tint across the plot. */}
                <rect
                  x={leftPad - 4}
                  y={yTop}
                  width={width - (leftPad - 4)}
                  height={laneHeight}
                  fill={lane.index % 2 === 0 ? "rgba(255,255,255,0.025)" : "rgba(255,255,255,0.04)"}
                />
                {/* Tier band stripe pinned to the lane's left edge (right of label). */}
                <rect
                  x={leftPad - 4}
                  y={yTop + 2}
                  width={tierStripeWidth}
                  height={laneHeight - 4}
                  fill={stripeFill}
                  rx={1.5}
                  data-testid={`waterfall-tier-stripe-${lane.role.id}`}
                />
                {/* Empty-lane diagonal stripe overlay + "awaiting input" text. */}
                {isEmpty && (
                  <g>
                    <rect
                      x={leftPad + tierStripeWidth}
                      y={yTop + 2}
                      width={width - rightPad - leftPad - tierStripeWidth}
                      height={laneHeight - 4}
                      fill="url(#dw-empty-stripe)"
                      data-testid={`waterfall-empty-lane-${lane.role.id}`}
                    />
                    <text
                      x={(leftPad + (width - rightPad)) / 2}
                      y={lane.y + 3}
                      textAnchor="middle"
                      className="fill-white/30"
                      style={{ fontSize: 10, fontStyle: "italic" }}
                    >
                      awaiting input from {lane.role.name}
                    </text>
                  </g>
                )}
                {/* Lane midline (only meaningful when chips are present). */}
                {!isEmpty && (
                  <line
                    x1={leftPad}
                    x2={width - rightPad}
                    y1={lane.y}
                    y2={lane.y}
                    stroke="rgba(255,255,255,0.05)"
                    strokeDasharray="2 4"
                  />
                )}
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

          {/* X-axis: faint vertical gridlines through the lane area + tick
              labels in the axis strip below it. */}
          {baseLayout && ticks.length > 0 && (
            <g data-testid="waterfall-x-axis">
              {ticks.map((t) => {
                const plotWidth = Math.max(80, width - leftPad - rightPad);
                const xFromTime = (ms: number) => {
                  if (baseLayout.tMax === baseLayout.tMin) {
                    return leftPad + plotWidth / 2;
                  }
                  const r = (ms - baseLayout.tMin) / (baseLayout.tMax - baseLayout.tMin);
                  return leftPad + Math.max(0, Math.min(1, r)) * plotWidth;
                };
                const x = xFromTime(t);
                return (
                  <g key={`tick-${t}`}>
                    {/* Gridline through the lane area. */}
                    <line
                      x1={x}
                      x2={x}
                      y1={topPad}
                      y2={axisTopY}
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth={1}
                      data-testid="waterfall-x-axis-tick"
                    />
                    {/* Tick mark in the axis strip. */}
                    <line
                      x1={x}
                      x2={x}
                      y1={axisTopY}
                      y2={axisTopY + 4}
                      stroke="rgba(255,255,255,0.35)"
                      strokeWidth={1}
                    />
                    {/* HH:MM label. */}
                    <text
                      x={x}
                      y={axisLabelY + 4}
                      textAnchor="middle"
                      className="fill-white/55"
                      style={{ fontSize: 9, fontVariantNumeric: "tabular-nums" }}
                    >
                      {fmtClock(t)}
                    </text>
                  </g>
                );
              })}
              {/* Axis baseline. */}
              <line
                x1={leftPad}
                x2={width - rightPad}
                y1={axisTopY}
                y2={axisTopY}
                stroke="rgba(255,255,255,0.18)"
                strokeWidth={1}
              />
            </g>
          )}

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
            const magnitudeStr = chip.magnitude.toFixed(1);
            const tooltipLine1 = `${chip.roleName} · ${fmtClockSec(chip.createdAt)} · |Δ| ${magnitudeStr}`;
            const tooltipLine2 = chip.rationale;
            const chipNode = (
              <g key={chip.id} data-testid={`waterfall-chip-${chip.id}`}>
                <circle
                  cx={chip.x}
                  cy={chip.y}
                  r={chip.radius}
                  fill={chip.color}
                  fillOpacity={0.9}
                  stroke="rgba(0,0,0,0.6)"
                  strokeWidth={1}
                />
                <title>
                  {tooltipLine1}
                  {tooltipLine2 ? `\n${tooltipLine2}` : ""}
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

          {/* Decision Pending vault — pushed down by the axis strip. */}
          {(() => {
            const vaultTop = axisTopY + axisHeight + 4;
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
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-white/60" />
          <span className="inline-block h-3 w-3 rounded-full bg-white/60" />
          size = |Δ|
        </span>
        <span className="ml-auto">x = HH:MM · y = authority rank (high→low)</span>
      </div>
    </div>
  );
}

export default DecisionWaterfall;
