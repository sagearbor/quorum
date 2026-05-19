"use client";

/**
 * /about/data-flow — Animated walkthrough of a SINGLE contribution's journey
 * through the Quorum pipeline, from form submit to chart bump.
 *
 * Same UX idiom as /about: autoplay / manual / show-full-pipeline modes,
 * keyboard ←/→/space, prefers-reduced-motion respected.
 *
 * Self-contained file — does not import from AboutExperience.tsx.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

// -----------------------------------------------------------------------------
// Pipeline phases — 7-step contribution journey
// -----------------------------------------------------------------------------

type PhaseId =
  | "submit"
  | "insert"
  | "analyzer"
  | "conflict"
  | "score"
  | "broadcast"
  | "chart";

interface Phase {
  id: PhaseId;
  index: number;
  eyebrow: string;
  title: string;
  body: string;
  tier?: 1 | 2 | 3 | null;
  /** Index of the pipeline box (0..6) that "lights up" for this phase. */
  boxIndex: number;
  /** Optional human/role node id that lights up on the left column. */
  roleId?: string;
  /** A short label that the right-column toast renders when this phase hits. */
  toast?: string;
}

const PHASES: Phase[] = [
  {
    id: "submit",
    index: 0,
    eyebrow: "01 / Submit",
    title: "Legal fills the structured form.",
    body:
      "A human (or an agent) posts to /quorums/{id}/contribute. Required fields per role: position, rationale, risk_appetite, must_haves.",
    tier: null,
    boxIndex: 0,
    roleId: "r-legal",
  },
  {
    id: "insert",
    index: 1,
    eyebrow: "02 / Persist",
    title: "INSERT into contributions.",
    body:
      "FastAPI validates against the role's required_fields schema, then INSERTs a row. The contribution_id is returned to the client immediately.",
    tier: null,
    boxIndex: 1,
  },
  {
    id: "analyzer",
    index: 2,
    eyebrow: "03 / Tier-2 Analyzer",
    title: "One LLM call: tag, score, rationale.",
    body:
      "GPT-4o-mini reads the contribution + role definition and returns { tags, score_deltas, rationale }. ~$0.001 per contribution. Tier-1 keyword extraction runs in parallel.",
    tier: 2,
    boxIndex: 2,
  },
  {
    id: "conflict",
    index: 3,
    eyebrow: "04 / Conflict Detector",
    title: "Conditional — fires only on overlap.",
    body:
      "If ≥2 roles wrote to the same structured field (e.g. both Legal and Clinical set risk_appetite), a second Tier-2 call surfaces the disagreement and writes a conflict row.",
    tier: 2,
    boxIndex: 3,
  },
  {
    id: "score",
    index: 4,
    eyebrow: "05 / Health Score",
    title: "calculate_health_score() recomputes.",
    body:
      "Composite + 5 sub-metrics (completion, consensus, momentum, breadth, conflict_load) are recomputed deterministically, factoring in the analyzer's score_deltas.",
    tier: 1,
    boxIndex: 4,
    toast: "Legal: −8 consensus, +5 completion",
  },
  {
    id: "broadcast",
    index: 5,
    eyebrow: "06 / Broadcast",
    title: "UPDATE quorums → realtime channel.",
    body:
      "A single transaction updates quorums.heat_score, metrics, and llm_metric_deltas. Supabase realtime fans the row change out to every subscribed client.",
    tier: null,
    boxIndex: 5,
  },
  {
    id: "chart",
    index: 6,
    eyebrow: "07 / Chart",
    title: "useQuorumLive appends a point.",
    body:
      "The chart redraws with a step-function bump. A floating toast surfaces 'Legal contributed: −8 consensus, +5 completion' — auditable, replayable.",
    tier: null,
    boxIndex: 6,
  },
];

// -----------------------------------------------------------------------------
// Pipeline boxes — center column horizontal flow
// -----------------------------------------------------------------------------

interface PipelineBox {
  label: string;
  sub: string;
  /** Optional tier tag rendered as a small pill inside the box. */
  tier?: 1 | 2 | 3;
  /** Render with a dashed border to signal "conditional / may not fire". */
  conditional?: boolean;
}

const BOXES: PipelineBox[] = [
  { label: "POST /contribute", sub: "form submit" },
  { label: "contributions", sub: "INSERT row" },
  { label: "Tier-2 Analyzer", sub: "tags + deltas", tier: 2 },
  { label: "Conflict Detector", sub: "if overlap", tier: 2, conditional: true },
  { label: "calculate_health_score()", sub: "composite + 5 metrics", tier: 1 },
  { label: "UPDATE quorums", sub: "realtime fanout" },
  { label: "useQuorumLive", sub: "chart redraws" },
];

// -----------------------------------------------------------------------------
// Left column — minimal role hub diagram (Legal lights up at step 0)
// -----------------------------------------------------------------------------

interface RoleNode {
  id: string;
  label: string;
  angle: number;
  rank: 1 | 2 | 3 | 4;
}

const HUB_CX = 130;
const HUB_CY = 160;
const HUB_R = 28;
const RING_R = 92;

const ROLE_NODES: RoleNode[] = [
  { id: "r-pi", label: "PI", angle: -90, rank: 4 },
  { id: "r-legal", label: "Legal", angle: -25, rank: 3 },
  { id: "r-ethics", label: "Ethics", angle: 40, rank: 3 },
  { id: "r-patient", label: "Patient", angle: 105, rank: 1 },
  { id: "r-stats", label: "Stats", angle: 170, rank: 2 },
  { id: "r-clinical", label: "Clinical", angle: -150, rank: 2 },
];

const RANK_COLORS: Record<number, { ring: string; fill: string; text: string }> = {
  1: { ring: "rgba(94,234,212,0.6)", fill: "rgba(20,40,42,0.9)", text: "#5eead4" },
  2: { ring: "rgba(56,189,248,0.7)", fill: "rgba(15,32,48,0.9)", text: "#7dd3fc" },
  3: { ring: "rgba(167,139,250,0.75)", fill: "rgba(28,22,48,0.92)", text: "#c4b5fd" },
  4: { ring: "rgba(252,165,165,0.8)", fill: "rgba(46,22,28,0.94)", text: "#fca5a5" },
};

function polar(angleDeg: number, radius: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: HUB_CX + Math.cos(rad) * radius, y: HUB_CY + Math.sin(rad) * radius };
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

type Mode = "auto" | "manual" | "all";

const AUTO_INTERVAL_MS = 6500;

export function DataFlowExperience() {
  const reduceMotion = useReducedMotion();
  const [mode, setMode] = useState<Mode>(reduceMotion ? "all" : "auto");
  const [phaseIndex, setPhaseIndex] = useState(0);

  useEffect(() => {
    if (reduceMotion) setMode("all");
  }, [reduceMotion]);

  const activePhase = PHASES[phaseIndex];

  useEffect(() => {
    if (mode !== "auto") return;
    const t = setInterval(() => {
      setPhaseIndex((i) => (i + 1) % PHASES.length);
    }, AUTO_INTERVAL_MS);
    return () => clearInterval(t);
  }, [mode]);

  const advance = useCallback(
    () => setPhaseIndex((i) => (i + 1) % PHASES.length),
    [],
  );
  const retreat = useCallback(
    () => setPhaseIndex((i) => (i - 1 + PHASES.length) % PHASES.length),
    [],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      )
        return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setMode((m) => (m === "auto" ? "manual" : m === "manual" ? "auto" : m));
      } else if (e.key === "ArrowRight") {
        if (mode === "auto") setMode("manual");
        advance();
      } else if (e.key === "ArrowLeft") {
        if (mode === "auto") setMode("manual");
        retreat();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, retreat, mode]);

  const visible: Set<PhaseId> = useMemo(() => {
    if (mode === "all") return new Set(PHASES.map((p) => p.id));
    return new Set([activePhase.id]);
  }, [mode, activePhase.id]);

  // Show chart bump and toast once the score-or-later phase is reached.
  const chartFilled = mode === "all" || phaseIndex >= 4;
  const showToast = mode === "all" || phaseIndex >= 6;

  return (
    <div className="relative min-h-[calc(100vh-3rem)] overflow-hidden bg-[#06070a] text-stone-200">
      <Backdrop />
      <ModeSwitcher mode={mode} onChange={setMode} />

      {/* --- Header ---------------------------------------------------- */}
      <header className="relative z-10 px-6 md:px-12 pt-10 pb-4">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-[10px] tracking-[0.32em] text-stone-500 uppercase">
              Quorum &nbsp;/&nbsp; data flow
            </div>
            <h1 className="mt-3 font-serif text-4xl md:text-6xl leading-[0.95] tracking-tight text-stone-100">
              When <em className="not-italic text-amber-300/90">Legal</em>{" "}
              contributes, the{" "}
              <em className="not-italic text-sky-300/90">chart moves</em>.
            </h1>
          </div>
          <div className="md:max-w-xs text-sm leading-relaxed text-stone-400 md:text-right">
            One contribution, seven stops. POST → INSERT → LLM → score → realtime
            → frontend hook → chart bump. Below is the trace.
          </div>
        </div>
      </header>

      {/* --- Main canvas ---------------------------------------------- */}
      <section className="relative z-10 px-6 md:px-12 pt-2 pb-10">
        <div className="relative aspect-[16/9] w-full rounded-2xl border border-stone-800/80 bg-gradient-to-br from-stone-950/80 via-[#0a0c12]/90 to-stone-950/40 overflow-hidden">
          {/* 3-column grid inside the canvas */}
          <div className="absolute inset-0 grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)_220px] gap-0">
            {/* Left: hub + role pings */}
            <div className="hidden lg:block relative">
              <RoleHub activeRoleId={activePhase.roleId} allOn={mode === "all"} />
            </div>

            {/* Center: 7-box horizontal flow */}
            <div className="relative">
              <PipelineFlow
                activeBoxIndex={mode === "all" ? -1 : activePhase.boxIndex}
                mode={mode}
              />
            </div>

            {/* Right: mini chart + toast */}
            <div className="hidden lg:block relative">
              <MiniChart filled={chartFilled} bumped={chartFilled} />
              <AnimatePresence>
                {showToast && (
                  <motion.div
                    key="toast"
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 16 }}
                    transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                    className="absolute top-[160px] left-2 right-2"
                  >
                    <div className="rounded-lg border border-amber-700/50 bg-[#06070a]/95 backdrop-blur px-3 py-2 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.8)]">
                      <div className="text-[9px] tracking-[0.28em] uppercase text-amber-300/80">
                        Legal contributed
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-stone-300 leading-snug">
                        −8 consensus
                        <br />
                        +5 completion
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Cost meter */}
          <CostMeter activeTier={mode === "all" ? null : activePhase.tier ?? null} />

          {/* Caption overlay */}
          <AnimatePresence mode="wait">
            {mode !== "all" && (
              <motion.div
                key={activePhase.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                className="absolute bottom-20 left-5 right-5 md:right-auto md:max-w-[55%]"
              >
                <div className="rounded-xl border border-stone-800/90 bg-[#06070a]/95 backdrop-blur-sm px-5 py-4 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.8)]">
                  <div className="text-[10px] tracking-[0.32em] uppercase text-amber-300/90">
                    {activePhase.eyebrow}
                  </div>
                  <div className="mt-2 font-serif text-2xl md:text-3xl text-stone-100 leading-tight">
                    {activePhase.title}
                  </div>
                  <div className="mt-2 text-sm text-stone-300 leading-relaxed">
                    {activePhase.body}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <FloatingControls
            mode={mode}
            phaseIndex={phaseIndex}
            onPrev={() => {
              if (mode === "auto") setMode("manual");
              retreat();
            }}
            onNext={() => {
              if (mode === "auto") setMode("manual");
              advance();
            }}
            onTogglePlay={() => setMode((m) => (m === "auto" ? "manual" : "auto"))}
          />
        </div>

        {/* Phase rail under the canvas */}
        <div className="mt-6">
          <PhaseRail
            phaseIndex={phaseIndex}
            mode={mode}
            onPick={(i) => {
              if (mode === "auto") setMode("manual");
              setPhaseIndex(i);
            }}
          />
        </div>
      </section>

      {/* --- Long-form notes ----------------------------------------- */}
      <LongForm />

      <footer className="relative z-10 px-6 md:px-12 pb-12 pt-6 border-t border-stone-900">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 text-xs text-stone-500">
          <div className="tracking-[0.22em] uppercase">
            Quorum — multi-agent coordination
          </div>
          <div className="font-mono text-[10px] text-stone-600">
            Pipeline trace · {new Date().getFullYear()}
          </div>
        </div>
      </footer>
    </div>
  );
}

// =============================================================================
// RoleHub — minimal hub with 6 roles; the active role pings
// =============================================================================

function RoleHub({
  activeRoleId,
  allOn,
}: {
  activeRoleId: string | undefined;
  allOn: boolean;
}) {
  return (
    <svg
      viewBox="0 0 260 320"
      className="absolute inset-0 w-full h-full"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <pattern id="df-dots" x="0" y="0" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" fill="rgba(231,229,228,0.05)" />
        </pattern>
        <radialGradient id="df-hubGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(250,204,21,0.3)" />
          <stop offset="100%" stopColor="rgba(28,25,23,0)" />
        </radialGradient>
      </defs>
      <rect width="260" height="320" fill="url(#df-dots)" />

      {/* Ring */}
      <circle
        cx={HUB_CX}
        cy={HUB_CY}
        r={RING_R}
        fill="none"
        stroke="rgba(231,229,228,0.06)"
        strokeDasharray="2 4"
      />

      {/* Spokes */}
      {ROLE_NODES.map((r) => {
        const p = polar(r.angle, RING_R);
        const lit = allOn || activeRoleId === r.id;
        return (
          <line
            key={`sp-${r.id}`}
            x1={HUB_CX}
            y1={HUB_CY}
            x2={p.x}
            y2={p.y}
            stroke={lit ? "rgba(251,191,36,0.45)" : "rgba(231,229,228,0.07)"}
            strokeWidth={lit ? 1.2 : 0.8}
          />
        );
      })}

      {/* Hub */}
      <circle cx={HUB_CX} cy={HUB_CY} r={HUB_R + 14} fill="url(#df-hubGrad)" />
      <circle
        cx={HUB_CX}
        cy={HUB_CY}
        r={HUB_R}
        fill="rgba(15,15,18,0.95)"
        stroke="rgba(251,191,36,0.55)"
        strokeWidth={1.2}
      />
      <text
        x={HUB_CX}
        y={HUB_CY - 2}
        textAnchor="middle"
        fontFamily="serif"
        fontStyle="italic"
        fontSize="13"
        fill="rgba(251,191,36,0.9)"
      >
        quorum
      </text>
      <text
        x={HUB_CX}
        y={HUB_CY + 11}
        textAnchor="middle"
        fontSize="6"
        letterSpacing="2"
        fill="rgba(231,229,228,0.35)"
      >
        HUB
      </text>

      {/* Role nodes */}
      {ROLE_NODES.map((r) => {
        const p = polar(r.angle, RING_R);
        const c = RANK_COLORS[r.rank];
        const lit = allOn || activeRoleId === r.id;
        const right = p.x > HUB_CX + 4;
        const left = p.x < HUB_CX - 4;
        const labelX = right ? p.x + 14 : left ? p.x - 14 : p.x;
        const anchor: "start" | "end" | "middle" = right
          ? "start"
          : left
          ? "end"
          : "middle";
        return (
          <g key={r.id}>
            <motion.circle
              cx={p.x}
              cy={p.y}
              r={lit ? 12 : 9}
              fill={c.fill}
              stroke={lit ? c.text : c.ring}
              strokeWidth={lit ? 1.6 : 1}
              initial={false}
              animate={{ r: lit ? 12 : 9 }}
              transition={{ duration: 0.4 }}
            />
            {lit && (
              <motion.circle
                cx={p.x}
                cy={p.y}
                r={10}
                fill="none"
                stroke={c.text}
                strokeOpacity={0.5}
                initial={{ r: 10, opacity: 0.7 }}
                animate={{ r: 22, opacity: 0 }}
                transition={{ duration: 1.6, repeat: Infinity }}
              />
            )}
            <text
              x={labelX}
              y={p.y + 3}
              textAnchor={anchor}
              fontSize="9"
              fill={lit ? c.text : "rgba(231,229,228,0.45)"}
              fontFamily="ui-sans-serif, system-ui"
            >
              {r.label}
            </text>
          </g>
        );
      })}

      {/* Pulse from active role → hub when one is active */}
      {activeRoleId && !allOn && (() => {
        const r = ROLE_NODES.find((rn) => rn.id === activeRoleId);
        if (!r) return null;
        const p = polar(r.angle, RING_R);
        return (
          <motion.circle
            r={3}
            fill="rgba(251,191,36,0.95)"
            initial={{ cx: p.x, cy: p.y, opacity: 0 }}
            animate={{ cx: [p.x, HUB_CX], cy: [p.y, HUB_CY], opacity: [0, 1, 1, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          />
        );
      })()}

      <text
        x={HUB_CX}
        y={300}
        textAnchor="middle"
        fontSize="8"
        letterSpacing="2"
        fill="rgba(231,229,228,0.4)"
      >
        ROLES
      </text>
    </svg>
  );
}

// =============================================================================
// PipelineFlow — 7-box horizontal flow with traveling pulse
// =============================================================================

function PipelineFlow({
  activeBoxIndex,
  mode,
}: {
  activeBoxIndex: number;
  mode: Mode;
}) {
  const allOn = mode === "all";
  return (
    <div className="absolute inset-0 flex flex-col justify-center px-2 py-12">
      <div className="text-[10px] tracking-[0.32em] uppercase text-stone-500 mb-3 text-center">
        Pipeline
      </div>
      <div className="relative">
        {/* Stacked column of boxes — each row has an arrow underneath */}
        <ol className="flex flex-col gap-2">
          {BOXES.map((box, i) => {
            const lit = allOn || i <= activeBoxIndex;
            const isActive = !allOn && i === activeBoxIndex;
            const borderColor = isActive
              ? "border-amber-400/80"
              : lit
              ? "border-stone-600"
              : "border-stone-800";
            const borderStyle = box.conditional ? "border-dashed" : "border-solid";
            return (
              <li key={box.label} className="relative">
                <motion.div
                  initial={false}
                  animate={{
                    boxShadow: isActive
                      ? "0 0 0 1px rgba(251,191,36,0.4), 0 8px 24px -12px rgba(251,191,36,0.5)"
                      : "0 0 0 0 rgba(0,0,0,0)",
                    backgroundColor: isActive
                      ? "rgba(28,22,12,0.85)"
                      : lit
                      ? "rgba(15,15,18,0.85)"
                      : "rgba(10,10,12,0.55)",
                  }}
                  transition={{ duration: 0.4 }}
                  className={`relative rounded-lg border ${borderStyle} ${borderColor} px-3 py-2 flex items-center justify-between gap-3`}
                >
                  <div className="flex flex-col">
                    <div
                      className={`font-mono text-[11px] tracking-tight ${
                        isActive
                          ? "text-amber-200"
                          : lit
                          ? "text-stone-200"
                          : "text-stone-500"
                      }`}
                    >
                      {box.label}
                    </div>
                    <div
                      className={`text-[9px] uppercase tracking-[0.22em] mt-0.5 ${
                        isActive ? "text-amber-300/70" : "text-stone-500"
                      }`}
                    >
                      {box.sub}
                    </div>
                  </div>
                  {box.tier && (
                    <span
                      className={`shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[8px] tracking-widest uppercase ${
                        isActive
                          ? "border-amber-400/60 text-amber-300"
                          : "border-stone-700 text-stone-500"
                      }`}
                    >
                      T{box.tier}
                    </span>
                  )}
                </motion.div>
                {/* Down-arrow between rows */}
                {i < BOXES.length - 1 && (
                  <div className="flex justify-center -my-0.5">
                    <motion.svg
                      width="10"
                      height="12"
                      viewBox="0 0 10 12"
                      initial={false}
                      animate={{
                        opacity: lit && (allOn || i < activeBoxIndex) ? 1 : 0.35,
                      }}
                      transition={{ duration: 0.3 }}
                    >
                      <path
                        d="M5 0 L5 9 M2 6 L5 9 L8 6"
                        fill="none"
                        stroke={
                          lit && (allOn || i < activeBoxIndex)
                            ? "rgba(251,191,36,0.7)"
                            : "rgba(231,229,228,0.2)"
                        }
                        strokeWidth="1.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </motion.svg>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

// =============================================================================
// MiniChart — small chart that bumps step-function style when triggered
// =============================================================================

function MiniChart({ filled, bumped }: { filled: boolean; bumped: boolean }) {
  // Baseline curve before the contribution lands, then step-up after.
  const baseline = "M 2 36 C 14 34 22 33 32 32 C 44 31 56 30 70 29";
  const bumpUp =
    "M 70 29 L 78 29 L 78 22 C 86 21 96 18 110 14 C 122 11 130 10 140 9";
  const bumpStraight = "M 70 29 L 140 28";
  const bumpPath = bumped ? bumpUp : bumpStraight;
  return (
    <div className="absolute top-6 left-2 right-2 select-none">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[9px] tracking-[0.28em] uppercase text-stone-500">
          Health chart
        </div>
        <div className="text-[8px] font-mono text-emerald-400/70 flex items-center gap-1">
          <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
          LIVE
        </div>
      </div>
      <svg viewBox="0 0 142 48" className="w-full h-20">
        <line x1="0" y1="46" x2="142" y2="46" stroke="rgba(231,229,228,0.1)" strokeWidth="0.5" />
        <line x1="0" y1="2" x2="142" y2="2" stroke="rgba(231,229,228,0.05)" strokeWidth="0.5" />
        {/* Vertical "now" line at x=70 — where the contribution lands */}
        <line
          x1="70"
          y1="2"
          x2="70"
          y2="46"
          stroke="rgba(252,211,77,0.35)"
          strokeWidth="0.8"
          strokeDasharray="1 2"
        />
        <path
          d={baseline}
          fill="none"
          stroke="rgba(125,211,252,0.85)"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
        <motion.path
          key={`bump-${bumped ? "y" : "n"}`}
          d={bumpPath}
          fill="none"
          stroke={bumped ? "rgba(251,191,36,0.95)" : "rgba(125,211,252,0.5)"}
          strokeWidth="1.4"
          strokeLinecap="round"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: filled ? 1 : 0, opacity: filled ? 1 : 0.4 }}
          transition={{ duration: 0.9, ease: "easeOut" }}
        />
        {bumped && (
          <motion.circle
            cx="78"
            cy="22"
            r="2.4"
            fill="rgba(251,191,36,0.95)"
            initial={{ scale: 0 }}
            animate={{ scale: [0, 1.6, 1] }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          />
        )}
      </svg>
      <div className="flex justify-between text-[8px] text-stone-600 font-mono mt-0.5">
        <span>t = 0</span>
        <span>t = now</span>
      </div>
    </div>
  );
}

// =============================================================================
// CostMeter
// =============================================================================

function CostMeter({ activeTier }: { activeTier: 1 | 2 | 3 | null }) {
  const tiers: Array<{ n: 1 | 2 | 3; label: string; cost: string }> = [
    { n: 1, label: "Score recompute", cost: "$0" },
    { n: 2, label: "Analyzer + conflict", cost: "≈ $0.001 / turn" },
    { n: 3, label: "Synthesis (resolve)", cost: "≈ $0.02 once" },
  ];
  return (
    <div className="absolute left-5 bottom-5 select-none z-10">
      <div className="text-[9px] tracking-[0.32em] uppercase text-stone-500 mb-2">
        LLM cost ladder
      </div>
      <div className="flex flex-col gap-1.5">
        {tiers.map((t) => {
          const on = activeTier === t.n || activeTier === null;
          return (
            <div
              key={t.n}
              className={`flex items-center gap-2 transition-opacity duration-500 ${
                on ? "opacity-100" : "opacity-30"
              }`}
            >
              <div
                className={`w-1.5 h-1.5 rounded-full transition-colors duration-500 ${
                  activeTier === t.n
                    ? "bg-amber-300 shadow-[0_0_8px_rgba(251,191,36,0.7)]"
                    : "bg-stone-600"
                }`}
              />
              <div className="font-mono text-[10px] text-stone-400 tracking-wide">
                <span className="text-stone-500">tier {t.n}</span> · {t.label}{" "}
                <span className="text-stone-600">— {t.cost}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// PhaseRail — horizontal under the canvas
// =============================================================================

function PhaseRail({
  phaseIndex,
  mode,
  onPick,
}: {
  phaseIndex: number;
  mode: Mode;
  onPick: (i: number) => void;
}) {
  return (
    <aside className="rounded-2xl border border-stone-800/80 bg-stone-950/60 p-5">
      <div className="text-[10px] tracking-[0.32em] uppercase text-stone-500 mb-3">
        Seven stops in the trace
      </div>
      <ol className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        {PHASES.map((p) => {
          const active = mode !== "all" && p.index === phaseIndex;
          const visited = mode === "all" || p.index <= phaseIndex;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p.index)}
                aria-label={`${p.eyebrow} — ${p.title}`}
                aria-current={active ? "step" : undefined}
                className={`w-full text-left transition-colors duration-300 ${
                  active
                    ? "text-stone-100"
                    : visited
                    ? "text-stone-400"
                    : "text-stone-600"
                }`}
              >
                <div
                  className={`font-mono text-[10px] ${
                    active
                      ? "text-amber-300"
                      : visited
                      ? "text-stone-500"
                      : "text-stone-700"
                  }`}
                >
                  {p.eyebrow.split(" /")[0]}
                </div>
                <div className="font-serif text-[14px] leading-snug mt-1">
                  {p.title}
                </div>
                {active && (
                  <motion.div
                    layoutId="dfPhaseBar"
                    className="h-px bg-gradient-to-r from-amber-300/80 via-amber-300/30 to-transparent mt-2"
                    transition={{ duration: 0.4 }}
                  />
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

// =============================================================================
// FloatingControls
// =============================================================================

function FloatingControls({
  mode,
  phaseIndex,
  onPrev,
  onNext,
  onTogglePlay,
}: {
  mode: Mode;
  phaseIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onTogglePlay: () => void;
}) {
  if (mode === "all") {
    return (
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
        <div className="rounded-full border border-stone-800/80 bg-[#06070a]/85 backdrop-blur px-4 py-1.5 text-[10px] tracking-[0.28em] uppercase text-stone-500 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.8)]">
          full pipeline view ·{" "}
          <kbd className="px-1 py-0.5 mx-0.5 rounded bg-stone-900 border border-stone-800 font-mono text-[9px] text-stone-400">
            ←
          </kbd>
          <kbd className="px-1 py-0.5 mx-0.5 rounded bg-stone-900 border border-stone-800 font-mono text-[9px] text-stone-400">
            →
          </kbd>{" "}
          step phases
        </div>
      </div>
    );
  }
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
      <div className="flex flex-col items-center gap-1.5 pointer-events-auto">
        <div className="flex items-center gap-3 rounded-full border border-stone-800/80 bg-[#06070a]/85 backdrop-blur px-3 py-1.5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.8)]">
          <button
            type="button"
            onClick={onPrev}
            aria-label="Previous phase"
            className="w-7 h-7 rounded-full border border-stone-800 text-stone-400 hover:text-amber-200 hover:border-amber-700 transition-colors flex items-center justify-center text-[11px]"
          >
            ◀
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={mode === "auto" ? "Pause autoplay" : "Resume autoplay"}
            className="px-3 h-7 rounded-full border border-stone-800 text-stone-400 hover:text-amber-200 hover:border-amber-700 transition-colors flex items-center gap-2 text-[10px] uppercase tracking-[0.24em]"
          >
            {mode === "auto" ? "❚❚ pause" : "▶ play"}
          </button>
          <button
            type="button"
            onClick={onNext}
            aria-label="Next phase"
            className="w-7 h-7 rounded-full border border-stone-800 text-stone-400 hover:text-amber-200 hover:border-amber-700 transition-colors flex items-center justify-center text-[11px]"
          >
            ▶
          </button>
          <div className="ml-1 flex items-center gap-1">
            {PHASES.map((p, i) => (
              <div
                key={p.id}
                className={`h-1 rounded-full transition-all duration-500 ${
                  i === phaseIndex ? "w-5 bg-amber-300" : "w-1 bg-stone-700"
                }`}
              />
            ))}
          </div>
        </div>
        <div className="text-[9px] font-mono tracking-[0.18em] uppercase text-stone-600">
          <kbd className="px-1 py-0.5 mx-0.5 rounded bg-stone-900/70 border border-stone-800 text-stone-500">
            space
          </kbd>{" "}
          play/pause ·{" "}
          <kbd className="px-1 py-0.5 mx-0.5 rounded bg-stone-900/70 border border-stone-800 text-stone-500">
            ←
          </kbd>
          <kbd className="px-1 py-0.5 mx-0.5 rounded bg-stone-900/70 border border-stone-800 text-stone-500">
            →
          </kbd>{" "}
          step
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// ModeSwitcher
// =============================================================================

function ModeSwitcher({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const options: Array<{ id: Mode; label: string }> = [
    { id: "auto", label: "Autoplay" },
    { id: "manual", label: "Manual" },
    { id: "all", label: "Show full pipeline" },
  ];
  return (
    <div className="absolute top-4 right-4 md:top-6 md:right-6 z-20">
      <div className="inline-flex items-center gap-1 rounded-full border border-stone-800 bg-stone-950/70 backdrop-blur p-1">
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={`px-3 py-1 rounded-full text-[10px] tracking-[0.22em] uppercase transition-colors ${
              mode === opt.id
                ? "bg-amber-300/15 text-amber-200"
                : "text-stone-500 hover:text-stone-200"
            }`}
            aria-pressed={mode === opt.id}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// Backdrop
// =============================================================================

function Backdrop() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 30%, rgba(251,191,36,0.06), transparent 60%), radial-gradient(ellipse 60% 60% at 80% 100%, rgba(94,234,212,0.04), transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.55) 100%)",
        }}
      />
    </>
  );
}

// =============================================================================
// LongForm — static notes about what each layer guarantees
// =============================================================================

function LongForm() {
  return (
    <section className="relative z-10 px-6 md:px-12 py-16 border-t border-stone-900">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12">
        <div className="md:col-span-4">
          <div className="text-[10px] tracking-[0.32em] uppercase text-stone-500">
            What each layer guarantees
          </div>
          <h2 className="font-serif text-3xl md:text-4xl text-stone-100 mt-3 leading-tight">
            From form submit<br />
            <span className="text-stone-500">to chart bump.</span>
          </h2>
        </div>
        <div className="md:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-8">
          <Detail
            num="01"
            title="Structured forms, not chat"
            body="Every role has a required_fields schema (position, rationale, risk_appetite, must_haves...). The form is generated from that schema. Free-form chat is layered on top — not the canonical input."
          />
          <Detail
            num="02"
            title="One Tier-2 call per contribution"
            body="The analyzer is a single GPT-4o-mini call. It returns { tags, score_deltas, rationale } as JSON. Tags grow the quorum's shared vocabulary; score_deltas feed health metrics."
          />
          <Detail
            num="03"
            title="Conditional conflict detection"
            body="The conflict detector only fires when ≥2 roles overlap on a structured field. Most contributions skip it. When it does fire, it writes a conflict row that the dashboard surfaces."
          />
          <Detail
            num="04"
            title="Deterministic score, LLM-informed deltas"
            body="calculate_health_score() is pure Python — no LLM. It composes the 5 sub-metrics deterministically, but reads llm_metric_deltas as input. That separation makes the score replayable."
          />
          <Detail
            num="05"
            title="One UPDATE, atomic"
            body="A single transaction writes quorums.heat_score, metrics, and llm_metric_deltas. Supabase realtime broadcasts the changed row. No staged writes, no torn reads."
          />
          <Detail
            num="06"
            title="Frontend listens, doesn't poll"
            body="useQuorumLive(quorumId) subscribes to the Postgres changes channel. New point arrives, chart redraws, toast surfaces. The hook is the only frontend integration point with realtime state."
          />
        </div>
      </div>
    </section>
  );
}

function Detail({ num, title, body }: { num: string; title: string; body: string }) {
  return (
    <div>
      <div className="flex items-baseline gap-3 mb-2">
        <span className="font-mono text-[10px] text-amber-400/80 tracking-widest">
          {num}
        </span>
        <h3 className="font-serif text-lg text-stone-100">{title}</h3>
      </div>
      <p className="text-sm text-stone-400 leading-relaxed">{body}</p>
    </div>
  );
}
