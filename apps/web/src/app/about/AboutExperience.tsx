"use client";

/**
 * /about — Animated walkthrough of the Quorum system.
 *
 * Built for the Duke Tech Expo: Sophie uses this page instead of slides.
 * Three modes:
 *   1. autoplay (default)  — phases cross-fade every ~6.5s, looping
 *   2. manual              — ◀ / ▶, arrow keys, spacebar to pause
 *   3. all                 — every overlay visible at once for Q&A
 *
 * Respects prefers-reduced-motion (skips animation, defaults to "all").
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

// -----------------------------------------------------------------------------
// Phase definitions
// -----------------------------------------------------------------------------

type PhaseId =
  | "setup"
  | "stations"
  | "contribution"
  | "facilitator"
  | "a2a"
  | "synthesis"
  | "artifact";

interface Phase {
  id: PhaseId;
  index: number;
  eyebrow: string;
  title: string;
  body: string;
  tier?: 1 | 2 | 3 | null;
  /** Short hover hint — which canvas element to watch for this phase */
  watch: string;
}

const PHASES: Phase[] = [
  {
    id: "setup",
    index: 0,
    eyebrow: "01 / Setup",
    title: "An architect names the problem.",
    body: "One LLM call generates 4–6 roles — each with persona, authority rank, domain tags, and temperature. No N+1 round-trips.",
    tier: 3,
    watch: "Watch: hub → roles burst",
  },
  {
    id: "stations",
    index: 1,
    eyebrow: "02 / Stations",
    title: "People pair to roles.",
    body: "Scan a QR code at any station. Multiple humans rotate through stations during the event.",
    tier: null,
    watch: "Watch: person glyphs light up",
  },
  {
    id: "contribution",
    index: 2,
    eyebrow: "03 / Contribution",
    title: "Structured input, live signals.",
    body: "Tier 1 keyword extraction runs deterministically (free). Tier 2 conflict detection fires when fields overlap (cheap). The health chart climbs in real time.",
    tier: 1,
    watch: "Watch: roles → hub ingest + chart climb",
  },
  {
    id: "facilitator",
    index: 3,
    eyebrow: "04 / Facilitator",
    title: "Chat freely, agents tag back.",
    body: "Each reply includes a [tags: …] block. Those tags grow the quorum's shared vocabulary and decide who talks to whom next.",
    tier: 2,
    watch: "Watch: cyan replies surface tags",
  },
  {
    id: "a2a",
    index: 4,
    eyebrow: "05 / Agent ↔ Agent",
    title: "Overlap fires A2A pings.",
    body: "When one agent's tags overlap another agent's domain, they ping each other directly. Amber notifications surface the exchange to humans.",
    tier: 2,
    watch: "Watch: amber arcs between roles",
  },
  {
    id: "synthesis",
    index: 5,
    eyebrow: "06 / Synthesis",
    title: "One Tier-3 call closes the loop.",
    body: "POST /resolve fires a single GPT-4o synthesis over every contribution + agent exchange. Optimistic locking on the artifact write prevents lost updates.",
    tier: 3,
    watch: "Watch: hub flares + spokes thicken inward",
  },
  {
    id: "artifact",
    index: 6,
    eyebrow: "07 / Artifact",
    title: "An audit-trailed decision.",
    body: "Downloadable. Versioned. Replayable. Plus a real-time dashboard of how the quorum got there.",
    tier: null,
    watch: "Watch: document glyph emerges above hub",
  },
];

// -----------------------------------------------------------------------------
// Geometry — ring of role nodes around a hub
// -----------------------------------------------------------------------------

const CX = 400;
const CY = 360;
const HUB_R = 46;
const RING_R = 220;

interface RoleNode {
  id: string;
  label: string;
  rank: 1 | 2 | 3 | 4; // authority rank tier — color-codes node
  angle: number; // degrees
  hasPerson?: boolean;
  domain: string;
}

// 6 role nodes around the ring, evenly spaced starting near the top
const ROLES: RoleNode[] = [
  { id: "r1", label: "Principal Investigator", rank: 4, angle: -90, domain: "ethics·strategy", hasPerson: true },
  { id: "r2", label: "Ethics Board", rank: 3, angle: -30, domain: "ethics·consent" },
  { id: "r3", label: "Biostatistician", rank: 2, angle: 30, domain: "stats·power" },
  { id: "r4", label: "Patient Advocate", rank: 1, angle: 90, domain: "consent·outcomes", hasPerson: true },
  { id: "r5", label: "Regulatory", rank: 3, angle: 150, domain: "FDA·protocols" },
  { id: "r6", label: "Clinician", rank: 2, angle: -150, domain: "outcomes·care" },
];

// Color per authority rank — single accent family, varying intensity
const RANK_COLORS: Record<number, { ring: string; fill: string; text: string }> = {
  1: { ring: "rgba(94,234,212,0.6)", fill: "rgba(20,40,42,0.9)", text: "#5eead4" },
  2: { ring: "rgba(56,189,248,0.7)", fill: "rgba(15,32,48,0.9)", text: "#7dd3fc" },
  3: { ring: "rgba(167,139,250,0.75)", fill: "rgba(28,22,48,0.92)", text: "#c4b5fd" },
  4: { ring: "rgba(252,165,165,0.8)", fill: "rgba(46,22,28,0.94)", text: "#fca5a5" },
};

// A2A overlap edges (drawn between role pairs when phase = "a2a")
const A2A_EDGES: Array<[string, string]> = [
  ["r1", "r5"], // PI ↔ Regulatory
  ["r2", "r4"], // Ethics ↔ Patient
  ["r3", "r6"], // Stats ↔ Clinician
];

function polar(angleDeg: number, radius: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + Math.cos(rad) * radius, y: CY + Math.sin(rad) * radius };
}

/** Build the SVG path d-string for an A2A arc between two points. */
function a2aPathD(pa: { x: number; y: number }, pb: { x: number; y: number }) {
  // Quadratic control point bowed toward hub center (matches drawn arc)
  const mx = (pa.x + pb.x) / 2;
  const my = (pa.y + pb.y) / 2;
  const cx = CX + (mx - CX) * 0.45;
  const cy = CY + (my - CY) * 0.45;
  return `M ${pa.x} ${pa.y} Q ${cx} ${cy} ${pb.x} ${pb.y}`;
}

// -----------------------------------------------------------------------------
// Spring physics — gentle Hooke's law sim on the role ring
// -----------------------------------------------------------------------------

interface NodeState {
  id: string;
  /** Resting (anchor) position — the original ring slot */
  ax: number;
  ay: number;
  /** Current position */
  x: number;
  y: number;
  /** Velocity */
  vx: number;
  vy: number;
}

/**
 * Custom hook: lightweight spring sim over the 6 role nodes.
 *
 * Each node is anchored to its ring position with a soft spring (so they
 * drift back). When two roles are connected via an active A2A edge, an
 * additional spring pulls them toward each other (rest length < ring chord).
 *
 * Returns `positions[role.id] = { x, y }` for the consumer to read.
 * When `frozen` is true (e.g. reduce-motion or "all" mode), positions snap
 * to anchors and the loop short-circuits.
 */
function useRoleSpringSim({
  activeEdges,
  frozen,
}: {
  activeEdges: Array<[string, string]>;
  frozen: boolean;
}) {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(() => {
    const m: Record<string, { x: number; y: number }> = {};
    for (const role of ROLES) {
      const p = polar(role.angle, RING_R);
      m[role.id] = { x: p.x, y: p.y };
    }
    return m;
  });

  // Mutable physics state — survives renders without triggering them
  const stateRef = useRef<NodeState[]>(
    ROLES.map((r) => {
      const p = polar(r.angle, RING_R);
      return { id: r.id, ax: p.x, ay: p.y, x: p.x, y: p.y, vx: 0, vy: 0 };
    }),
  );

  const edgesRef = useRef(activeEdges);
  edgesRef.current = activeEdges;
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  useEffect(() => {
    if (frozen) {
      // Snap to anchors
      for (const n of stateRef.current) {
        n.x = n.ax;
        n.y = n.ay;
        n.vx = 0;
        n.vy = 0;
      }
      const snap: Record<string, { x: number; y: number }> = {};
      for (const n of stateRef.current) snap[n.id] = { x: n.x, y: n.y };
      setPositions(snap);
      return;
    }

    let raf = 0;
    let lastEmit = 0;
    const EMIT_MS = 1000 / 30; // 30fps for React state, sim still runs every frame
    const ANCHOR_K = 0.012; // anchor spring stiffness (low = drifty)
    const EDGE_K = 0.004; // A2A pull stiffness
    const REST_FRAC = 0.55; // pull toward each other; rest length = REST_FRAC * default chord
    const DAMPING = 0.86;
    const MAX_DELTA = 14; // clamp displacement from anchor

    const tick = (now: number) => {
      const nodes = stateRef.current;
      const edges = edgesRef.current;

      // Anchor springs — pull each node back to its slot
      for (const n of nodes) {
        const dx = n.ax - n.x;
        const dy = n.ay - n.y;
        n.vx += dx * ANCHOR_K;
        n.vy += dy * ANCHOR_K;
      }

      // Edge springs — A2A pairs pull together
      for (const [a, b] of edges) {
        const na = nodes.find((n) => n.id === a);
        const nb = nodes.find((n) => n.id === b);
        if (!na || !nb) continue;
        const dxA = nb.ax - na.ax;
        const dyA = nb.ay - na.ay;
        const restLen = Math.hypot(dxA, dyA) * REST_FRAC;
        const dx = nb.x - na.x;
        const dy = nb.y - na.y;
        const dist = Math.max(Math.hypot(dx, dy), 0.001);
        const stretch = dist - restLen;
        const ux = dx / dist;
        const uy = dy / dist;
        const f = stretch * EDGE_K;
        na.vx += ux * f;
        na.vy += uy * f;
        nb.vx -= ux * f;
        nb.vy -= uy * f;
      }

      // Integrate + damping + clamp
      for (const n of nodes) {
        n.vx *= DAMPING;
        n.vy *= DAMPING;
        n.x += n.vx;
        n.y += n.vy;
        // Clamp distance from anchor
        const ddx = n.x - n.ax;
        const ddy = n.y - n.ay;
        const d = Math.hypot(ddx, ddy);
        if (d > MAX_DELTA) {
          const k = MAX_DELTA / d;
          n.x = n.ax + ddx * k;
          n.y = n.ay + ddy * k;
          n.vx *= 0.5;
          n.vy *= 0.5;
        }
      }

      // Emit at ~30fps to React
      if (now - lastEmit > EMIT_MS) {
        const snap: Record<string, { x: number; y: number }> = {};
        for (const n of nodes) snap[n.id] = { x: n.x, y: n.y };
        setPositions(snap);
        lastEmit = now;
      }

      if (!frozenRef.current) {
        raf = requestAnimationFrame(tick);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frozen]);

  return positions;
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

type Mode = "auto" | "manual" | "all";

const AUTO_INTERVAL_MS = 6500;

export function AboutExperience() {
  const reduceMotion = useReducedMotion();

  // Default to "all" when reduced motion is set
  const [mode, setMode] = useState<Mode>(reduceMotion ? "all" : "auto");
  const [phaseIndex, setPhaseIndex] = useState(0);

  // Sync mode when reduce-motion flips after mount
  useEffect(() => {
    if (reduceMotion) setMode("all");
  }, [reduceMotion]);

  const activePhase = PHASES[phaseIndex];

  // ---- autoplay ticker -----------------------------------------------------
  useEffect(() => {
    if (mode !== "auto") return;
    const t = setInterval(() => {
      setPhaseIndex((i) => (i + 1) % PHASES.length);
    }, AUTO_INTERVAL_MS);
    return () => clearInterval(t);
  }, [mode]);

  // ---- keyboard ------------------------------------------------------------
  const advance = useCallback(() => setPhaseIndex((i) => (i + 1) % PHASES.length), []);
  const retreat = useCallback(
    () => setPhaseIndex((i) => (i - 1 + PHASES.length) % PHASES.length),
    [],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
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

  // Which phases are "visible" on the diagram
  const visible: Set<PhaseId> = useMemo(() => {
    if (mode === "all") return new Set(PHASES.map((p) => p.id));
    return new Set([activePhase.id]);
  }, [mode, activePhase.id]);

  // Active A2A edges drive both the drawn arcs AND the spring pulls.
  // When "all" mode is on, freeze the sim so the diagram reads as a clean ref.
  // Reduce-motion also freezes.
  const a2aOn = visible.has("a2a");
  const physicsFrozen = mode === "all" || Boolean(reduceMotion);
  const activeEdges = useMemo<Array<[string, string]>>(
    () => (a2aOn ? A2A_EDGES : []),
    [a2aOn],
  );
  const rolePositions = useRoleSpringSim({
    activeEdges,
    frozen: physicsFrozen,
  });

  return (
    <div className="relative min-h-[calc(100vh-3rem)] overflow-hidden bg-[#06070a] text-stone-200">
      {/* --- Backdrop atmosphere -------------------------------------- */}
      <Backdrop />

      {/* --- Mode switcher (top-right) -------------------------------- */}
      <ModeSwitcher mode={mode} onChange={setMode} />

      {/* --- Header band ---------------------------------------------- */}
      <header className="relative z-10 px-6 md:px-12 pt-10 pb-4">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-[10px] tracking-[0.32em] text-stone-500 uppercase">
              Quorum &nbsp;/&nbsp; the system, in motion
            </div>
            <h1 className="mt-3 font-serif text-4xl md:text-6xl leading-[0.95] tracking-tight text-stone-100">
              How a room of <em className="not-italic text-amber-300/90">people</em> and{" "}
              <em className="not-italic text-sky-300/90">agents</em> reaches one decision.
            </h1>
          </div>
          <div className="md:max-w-xs text-sm leading-relaxed text-stone-400 md:text-right">
            A live wiring diagram of the platform. Watch a phase pass, step
            through manually, or pin it all open for Q&amp;A.
          </div>
        </div>
      </header>

      {/* --- HERO: diagram + caption rail ----------------------------- */}
      <section className="relative z-10 px-6 md:px-12 pt-2 pb-10">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-8 items-start">
          {/* Diagram canvas */}
          <div className="relative aspect-[4/3] w-full rounded-2xl border border-stone-800/80 bg-gradient-to-br from-stone-950/80 via-[#0a0c12]/90 to-stone-950/40 overflow-hidden">
            <DiagramCanvas
              visible={visible}
              activePhase={activePhase.id}
              mode={mode}
              rolePositions={rolePositions}
            />

            {/* Cost meter (bottom-left) */}
            <CostMeter activeTier={mode === "all" ? null : activePhase.tier ?? null} />

            {/* Mini chart (top-right inside canvas) */}
            <MiniChart
              activePhase={activePhase.id}
              mode={mode}
              phaseIndex={phaseIndex}
            />

            {/* Phase caption overlay — near-opaque so it reads cleanly */}
            <AnimatePresence mode="wait">
              {mode !== "all" && (
                <motion.div
                  key={activePhase.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute bottom-20 left-5 right-5 md:right-auto md:max-w-[60%]"
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

            {/* In-canvas floating controls (always visible alongside the visual) */}
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

          {/* Phase rail (right column) */}
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

      {/* --- Long-form prose below ------------------------------------ */}
      <LongForm />

      {/* --- Footer --------------------------------------------------- */}
      <footer className="relative z-10 px-6 md:px-12 pb-12 pt-6 border-t border-stone-900">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 text-xs text-stone-500">
          <div className="tracking-[0.22em] uppercase">
            Quorum — multi-agent coordination
          </div>
          <div className="font-mono text-[10px] text-stone-600">
            Duke Tech Expo · {new Date().getFullYear()}
          </div>
        </div>
      </footer>
    </div>
  );
}

// =============================================================================
// Diagram canvas — hub, ring of roles, animated message pulses
// =============================================================================

interface DiagramProps {
  visible: Set<PhaseId>;
  activePhase: PhaseId;
  mode: Mode;
  rolePositions: Record<string, { x: number; y: number }>;
}

function DiagramCanvas({ visible, activePhase, mode, rolePositions }: DiagramProps) {
  // Roles always render — they're the backbone of the diagram
  const synthActive = activePhase === "synthesis" || mode === "all";
  const artifactActive = activePhase === "artifact" || mode === "all";

  return (
    <svg
      viewBox="0 0 800 720"
      className="absolute inset-0 w-full h-full"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        {/* Hub radial gradient */}
        <radialGradient id="hubGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(250,204,21,0.35)" />
          <stop offset="60%" stopColor="rgba(146,64,14,0.25)" />
          <stop offset="100%" stopColor="rgba(28,25,23,0.0)" />
        </radialGradient>
        {/* Soft glow under hub */}
        <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Dotted grid */}
        <pattern id="dots" x="0" y="0" width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.7" fill="rgba(231,229,228,0.06)" />
        </pattern>
        {/* A2A edge gradient (amber) */}
        <linearGradient id="amberEdge" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(251,191,36,0)" />
          <stop offset="50%" stopColor="rgba(251,191,36,0.85)" />
          <stop offset="100%" stopColor="rgba(251,191,36,0)" />
        </linearGradient>
        {/* Reusable A2A path definitions — referenced by pulse animateMotion */}
        {A2A_EDGES.map(([a, b], i) => {
          const ra = ROLES.find((r) => r.id === a)!;
          const rb = ROLES.find((r) => r.id === b)!;
          const fallbackA = polar(ra.angle, RING_R);
          const fallbackB = polar(rb.angle, RING_R);
          const pa = rolePositions[a] ?? fallbackA;
          const pb = rolePositions[b] ?? fallbackB;
          // Pull arc endpoints slightly inward (matches drawn arc start/end)
          const shrink = (
            p: { x: number; y: number },
            anchor: { x: number; y: number },
          ) => {
            const dx = anchor.x - p.x;
            const dy = anchor.y - p.y;
            const d = Math.hypot(dx, dy) || 1;
            return { x: p.x + (dx / d) * 10, y: p.y + (dy / d) * 10 };
          };
          const start = shrink(pa, { x: CX, y: CY });
          const end = shrink(pb, { x: CX, y: CY });
          return (
            <path key={`a2a-path-${i}`} id={`a2aPath-${i}`} d={a2aPathD(start, end)} />
          );
        })}
      </defs>

      {/* dot grid */}
      <rect width="800" height="720" fill="url(#dots)" />

      {/* concentric tracking rings (decorative) */}
      <circle cx={CX} cy={CY} r={RING_R + 40} fill="none" stroke="rgba(231,229,228,0.04)" strokeDasharray="2 6" />
      <circle cx={CX} cy={CY} r={RING_R} fill="none" stroke="rgba(231,229,228,0.07)" />
      <circle cx={CX} cy={CY} r={RING_R - 60} fill="none" stroke="rgba(231,229,228,0.04)" strokeDasharray="1 8" />

      {/* spokes from hub to each role — thicken during synthesis */}
      {ROLES.map((role) => {
        const fallback = polar(role.angle, RING_R);
        const p = rolePositions[role.id] ?? fallback;
        return (
          <motion.line
            key={`spoke-${role.id}`}
            x1={CX}
            y1={CY}
            x2={p.x}
            y2={p.y}
            stroke="rgba(231,229,228,0.08)"
            initial={false}
            animate={{
              strokeWidth: synthActive ? 1.8 : 1,
              stroke: synthActive
                ? "rgba(251,191,36,0.45)"
                : "rgba(231,229,228,0.08)",
            }}
            transition={{ duration: 0.6 }}
          />
        );
      })}

      {/* A2A overlap edges (curve between roles), only when a2a or all */}
      {(visible.has("a2a") || mode === "all") &&
        A2A_EDGES.map(([a, b], i) => {
          const ra = ROLES.find((r) => r.id === a)!;
          const rb = ROLES.find((r) => r.id === b)!;
          const fallbackA = polar(ra.angle, RING_R);
          const fallbackB = polar(rb.angle, RING_R);
          const pa = rolePositions[a] ?? fallbackA;
          const pb = rolePositions[b] ?? fallbackB;
          const shrink = (
            p: { x: number; y: number },
            anchor: { x: number; y: number },
          ) => {
            const dx = anchor.x - p.x;
            const dy = anchor.y - p.y;
            const d = Math.hypot(dx, dy) || 1;
            return { x: p.x + (dx / d) * 10, y: p.y + (dy / d) * 10 };
          };
          const start = shrink(pa, { x: CX, y: CY });
          const end = shrink(pb, { x: CX, y: CY });
          const d = a2aPathD(start, end);
          return (
            <motion.path
              key={`a2a-${i}`}
              d={d}
              fill="none"
              stroke="url(#amberEdge)"
              strokeWidth={1.4}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 0.85 }}
              transition={{ duration: 0.9, delay: i * 0.18, ease: "easeOut" }}
            />
          );
        })}

      {/* Hub — pulses bright amber during synthesis */}
      <g filter="url(#softGlow)">
        <motion.circle
          cx={CX}
          cy={CY}
          r={HUB_R + 28}
          fill="url(#hubGrad)"
          initial={false}
          animate={{
            scale: synthActive ? [1, 1.12, 1.04] : 1,
            opacity: synthActive ? [0.7, 1, 0.85] : 0.7,
          }}
          transition={{
            duration: synthActive ? 1.4 : 0.6,
            repeat: synthActive ? Infinity : 0,
            repeatType: "reverse",
          }}
          style={{ transformOrigin: `${CX}px ${CY}px`, transformBox: "fill-box" } as React.CSSProperties}
        />
        <motion.circle
          cx={CX}
          cy={CY}
          r={HUB_R}
          fill="rgba(15,15,18,0.95)"
          initial={false}
          animate={{
            stroke: synthActive
              ? "rgba(252,211,77,0.95)"
              : "rgba(251,191,36,0.55)",
            strokeWidth: synthActive ? 1.8 : 1.2,
          }}
          transition={{ duration: 0.5 }}
        />
        <text
          x={CX}
          y={CY - 4}
          textAnchor="middle"
          fontFamily="serif"
          fontStyle="italic"
          fontSize="18"
          fill="rgba(251,191,36,0.9)"
        >
          quorum
        </text>
        <text
          x={CX}
          y={CY + 14}
          textAnchor="middle"
          fontSize="8"
          letterSpacing="2"
          fill="rgba(231,229,228,0.35)"
        >
          HUB
        </text>
      </g>

      {/* Artifact glyph — appears above hub during the artifact phase */}
      <AnimatePresence>
        {artifactActive && (
          <ArtifactGlyph key="artifact-glyph" />
        )}
      </AnimatePresence>

      {/* Role nodes */}
      {ROLES.map((role) => {
        const fallback = polar(role.angle, RING_R);
        const pos = rolePositions[role.id] ?? fallback;
        return (
          <RoleGlyph
            key={role.id}
            role={role}
            mode={mode}
            activePhase={activePhase}
            pos={pos}
          />
        );
      })}

      {/* Animated pulses traveling along edges / arcs */}
      <PulseLayer
        activePhase={activePhase}
        mode={mode}
        rolePositions={rolePositions}
      />
    </svg>
  );
}

// -----------------------------------------------------------------------------

function ArtifactGlyph() {
  // A small document/envelope glyph that emerges above the hub.
  // Positioned at (CX, CY - HUB_R - 36).
  const ox = CX;
  const oy = CY - HUB_R - 38;
  return (
    <motion.g
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      style={{ transformBox: "fill-box" } as React.CSSProperties}
    >
      {/* glow */}
      <motion.circle
        cx={ox}
        cy={oy + 12}
        r={28}
        fill="rgba(251,191,36,0.12)"
        animate={{ opacity: [0.5, 0.9, 0.5] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
      />
      {/* document rectangle */}
      <rect
        x={ox - 16}
        y={oy - 2}
        width="32"
        height="40"
        rx="2.5"
        fill="rgba(15,15,18,0.95)"
        stroke="rgba(252,211,77,0.85)"
        strokeWidth="1.3"
      />
      {/* folded corner */}
      <path
        d={`M ${ox + 8} ${oy - 2} L ${ox + 16} ${oy + 6} L ${ox + 8} ${oy + 6} Z`}
        fill="rgba(252,211,77,0.18)"
        stroke="rgba(252,211,77,0.85)"
        strokeWidth="1"
      />
      {/* text lines */}
      <line x1={ox - 11} y1={oy + 12} x2={ox + 7} y2={oy + 12} stroke="rgba(231,229,228,0.55)" strokeWidth="1" strokeLinecap="round" />
      <line x1={ox - 11} y1={oy + 18} x2={ox + 11} y2={oy + 18} stroke="rgba(231,229,228,0.4)" strokeWidth="1" strokeLinecap="round" />
      <line x1={ox - 11} y1={oy + 24} x2={ox + 9} y2={oy + 24} stroke="rgba(231,229,228,0.4)" strokeWidth="1" strokeLinecap="round" />
      <line x1={ox - 11} y1={oy + 30} x2={ox + 5} y2={oy + 30} stroke="rgba(231,229,228,0.3)" strokeWidth="1" strokeLinecap="round" />
      {/* tiny "AUDIT" tag */}
      <text x={ox} y={oy - 8} textAnchor="middle" fontSize="6" letterSpacing="2" fill="rgba(252,211,77,0.85)">
        AUDIT
      </text>
    </motion.g>
  );
}

// -----------------------------------------------------------------------------

function RoleGlyph({
  role,
  mode,
  activePhase,
  pos,
}: {
  role: RoleNode;
  mode: Mode;
  activePhase: PhaseId;
  pos: { x: number; y: number };
}) {
  const colors = RANK_COLORS[role.rank];
  // The person glyph "lights up" only on stations + contribution + facilitator phases
  const personActive: boolean = Boolean(
    role.hasPerson &&
      (mode === "all" ||
        activePhase === "stations" ||
        activePhase === "contribution" ||
        activePhase === "facilitator"),
  );

  // Where the person sits — offset further out along the spoke (anchor-based).
  // Use the anchor angle so persons don't jitter along with the spring sim.
  const personP = polar(role.angle, RING_R + 70);

  return (
    <g>
      {/* Role pill node — animated position from the spring sim */}
      <motion.g
        animate={{ x: pos.x, y: pos.y }}
        transition={{ type: "tween", duration: 0 }}
      >
        <g>
          <circle r={26} fill={colors.fill} stroke={colors.ring} strokeWidth={1.4} />
          <circle r={32} fill="none" stroke={colors.ring} strokeOpacity={0.25} strokeWidth={1} strokeDasharray="2 4" />
          {/* rank dots inside */}
          {Array.from({ length: role.rank }).map((_, i) => (
            <circle
              key={i}
              cx={(i - (role.rank - 1) / 2) * 6}
              cy={0}
              r={1.6}
              fill={colors.text}
            />
          ))}
        </g>
      </motion.g>

      {/* Role name label — anchored to original ring slot (labels don't jitter) */}
      <RoleLabel role={role} colors={colors} />

      {/* Person glyph (SVG) — only on roles with hasPerson */}
      {role.hasPerson && (
        <motion.g
          initial={false}
          animate={{
            opacity: personActive ? 1 : 0.18,
            scale: personActive ? 1 : 0.85,
          }}
          transition={{ duration: 0.5 }}
          style={{ transformOrigin: `${personP.x}px ${personP.y}px`, transformBox: "fill-box" } as React.CSSProperties}
        >
          <PersonGlyph cx={personP.x} cy={personP.y} active={personActive} />
        </motion.g>
      )}
    </g>
  );
}

function RoleLabel({
  role,
  colors,
}: {
  role: RoleNode;
  colors: { text: string };
}) {
  // Labels anchor to the original ring slot, not the live spring position,
  // so labels stay readable as nodes vibrate.
  const anchor = polar(role.angle, RING_R);
  const cx = anchor.x;
  const cy = anchor.y;
  // Anchor + offset depends on which side of the hub the role is on
  const right = cx > CX + 6;
  const left = cx < CX - 6;
  const labelX = right ? cx + 36 : left ? cx - 36 : cx;
  const labelY = cy;
  const textAnchor: "start" | "end" | "middle" = right ? "start" : left ? "end" : "middle";

  // Two lines: name + domain tags
  return (
    <g>
      <text
        x={labelX}
        y={labelY - 2}
        textAnchor={textAnchor}
        fontSize="11"
        letterSpacing="0.5"
        fontFamily="ui-sans-serif, system-ui"
        fill={colors.text}
      >
        {role.label}
      </text>
      <text
        x={labelX}
        y={labelY + 12}
        textAnchor={textAnchor}
        fontSize="8.5"
        letterSpacing="1.5"
        fontFamily="ui-monospace, monospace"
        fill="rgba(231,229,228,0.35)"
      >
        rank·{role.rank} · {role.domain}
      </text>
    </g>
  );
}

function PersonGlyph({ cx, cy, active }: { cx: number; cy: number; active: boolean }) {
  const stroke = active ? "rgba(94,234,212,0.95)" : "rgba(94,234,212,0.45)";
  return (
    <g transform={`translate(${cx - 10} ${cy - 14})`}>
      <circle cx="10" cy="6" r="4" fill="none" stroke={stroke} strokeWidth="1.4" />
      <path
        d="M 2 22 Q 10 14 18 22"
        fill="none"
        stroke={stroke}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {active && (
        <circle cx="10" cy="6" r="7" fill="none" stroke={stroke} strokeOpacity="0.3" strokeWidth="0.9">
          <animate attributeName="r" values="6;10;6" dur="2.2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.6;0;0.6" dur="2.2s" repeatCount="indefinite" />
        </circle>
      )}
    </g>
  );
}

// -----------------------------------------------------------------------------
// PulseLayer — small dots travelling along edges according to active phase
// -----------------------------------------------------------------------------

function PulseLayer({
  activePhase,
  mode,
  rolePositions,
}: {
  activePhase: PhaseId;
  mode: Mode;
  rolePositions: Record<string, { x: number; y: number }>;
}) {
  // Linear (straight-line) pulses: hub↔role, person↔role
  const linearPulses = useMemo(
    () => phaseLinearPulses(activePhase, mode, rolePositions),
    [activePhase, mode, rolePositions],
  );

  // Curved A2A pulses — follow the same bezier as the drawn arc.
  // Toggled on whenever a2a edges are visible.
  const showA2A = activePhase === "a2a" || mode === "all";

  return (
    <g>
      {linearPulses.map((pulse, i) => {
        const { key, ...rest } = pulse;
        return <Pulse key={`${key}-${i}`} {...rest} />;
      })}

      {showA2A &&
        A2A_EDGES.map((_, i) => (
          <CurvedPulse
            key={`curved-a2a-${i}`}
            pathId={`a2aPath-${i}`}
            color="rgba(251,191,36,0.95)"
            radius={3.3}
            duration={1.6}
            delay={i * 0.25}
          />
        ))}
      {showA2A &&
        A2A_EDGES.map((_, i) => (
          <CurvedPulse
            key={`curved-a2a-rev-${i}`}
            pathId={`a2aPath-${i}`}
            color="rgba(251,191,36,0.7)"
            radius={2.6}
            duration={1.6}
            delay={i * 0.25 + 0.8}
            reverse
          />
        ))}
    </g>
  );
}

interface PulseSpec {
  key: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
  radius: number;
  duration: number;
  delay: number;
}

/**
 * Linear pulses only — A2A curved pulses live on their own SVG paths via mpath.
 */
function phaseLinearPulses(
  activePhase: PhaseId,
  mode: Mode,
  rolePositions: Record<string, { x: number; y: number }>,
): PulseSpec[] {
  const out: PulseSpec[] = [];
  const posFor = (id: string, angle: number) =>
    rolePositions[id] ?? polar(angle, RING_R);

  // SETUP: hub → all roles (single LLM call dispatching roles)
  if (activePhase === "setup" || mode === "all") {
    ROLES.forEach((role, i) => {
      const p = posFor(role.id, role.angle);
      out.push({
        key: `setup-${role.id}`,
        from: { x: CX, y: CY },
        to: { x: p.x, y: p.y },
        color: "rgba(196,181,253,0.95)", // violet — LLM
        radius: 3.4,
        duration: 1.6,
        delay: i * 0.12,
      });
    });
  }

  // STATIONS / CONTRIBUTION: person → role (teal)
  if (activePhase === "stations" || activePhase === "contribution" || mode === "all") {
    ROLES.filter((r) => r.hasPerson).forEach((role, i) => {
      const rolePt = posFor(role.id, role.angle);
      const personPt = polar(role.angle, RING_R + 70);
      out.push({
        key: `human-${role.id}`,
        from: personPt,
        to: rolePt,
        color: "rgba(94,234,212,0.95)", // teal — human
        radius: 3,
        duration: 1.9,
        delay: i * 0.45,
      });
    });
  }

  // CONTRIBUTION / FACILITATOR: role → hub (tier 1/2 ingest, violet/cyan)
  if (
    activePhase === "contribution" ||
    activePhase === "facilitator" ||
    mode === "all"
  ) {
    ROLES.forEach((role, i) => {
      // Only some roles fire per cycle
      if (i % 2 === (activePhase === "facilitator" ? 1 : 0)) {
        const p = posFor(role.id, role.angle);
        out.push({
          key: `ingest-${role.id}-${activePhase}`,
          from: { x: p.x, y: p.y },
          to: { x: CX, y: CY },
          color: activePhase === "facilitator"
            ? "rgba(125,211,252,0.95)" // cyan
            : "rgba(196,181,253,0.85)", // violet
          radius: 2.6,
          duration: 1.7,
          delay: 0.15 + (i % 3) * 0.35,
        });
      }
    });
  }

  // SYNTHESIS: every role → hub, slow, violet
  if (activePhase === "synthesis" || mode === "all") {
    ROLES.forEach((role, i) => {
      const p = posFor(role.id, role.angle);
      out.push({
        key: `synth-${role.id}`,
        from: { x: p.x, y: p.y },
        to: { x: CX, y: CY },
        color: "rgba(196,181,253,1)",
        radius: 3.6,
        duration: 2.2,
        delay: i * 0.18,
      });
    });
  }

  // ARTIFACT: a few hub-outward sparkles
  if (activePhase === "artifact" || mode === "all") {
    [0, 2, 4].forEach((i) => {
      const role = ROLES[i];
      const p = posFor(role.id, role.angle);
      out.push({
        key: `artifact-${role.id}`,
        from: { x: CX, y: CY },
        to: { x: p.x, y: p.y },
        color: "rgba(252,211,77,0.85)",
        radius: 2.4,
        duration: 2.0,
        delay: 0.4 + i * 0.18,
      });
    });
  }

  return out;
}

function Pulse({ from, to, color, radius, duration, delay }: Omit<PulseSpec, "key">) {
  return (
    <motion.circle
      r={radius}
      fill={color}
      initial={{ cx: from.x, cy: from.y, opacity: 0 }}
      animate={{
        cx: [from.x, to.x],
        cy: [from.y, to.y],
        opacity: [0, 1, 1, 0],
      }}
      transition={{
        duration,
        delay,
        repeat: Infinity,
        repeatDelay: 0.3,
        ease: "easeInOut",
        times: [0, 0.1, 0.85, 1],
      }}
    />
  );
}

/**
 * Curved pulse: a dot that traverses an existing SVG <path> via animateMotion.
 *
 * We use SVG's native animateMotion + mpath here because Framer Motion doesn't
 * natively animate along a path. animateMotion is well-supported and means the
 * dot literally follows the same bezier the arc was drawn with — no straight
 * lines, no math duplication.
 */
function CurvedPulse({
  pathId,
  color,
  radius,
  duration,
  delay,
  reverse = false,
}: {
  pathId: string;
  color: string;
  radius: number;
  duration: number;
  delay: number;
  reverse?: boolean;
}) {
  return (
    <g>
      <circle r={radius} fill={color} opacity={0}>
        <animateMotion
          dur={`${duration}s`}
          begin={`${delay}s`}
          repeatCount="indefinite"
          keyPoints={reverse ? "1;0" : "0;1"}
          keyTimes="0;1"
          calcMode="linear"
        >
          <mpath href={`#${pathId}`} />
        </animateMotion>
        {/* fade-in / fade-out keyframes synced to the motion duration */}
        <animate
          attributeName="opacity"
          values="0;1;1;0"
          keyTimes="0;0.12;0.85;1"
          dur={`${duration}s`}
          begin={`${delay}s`}
          repeatCount="indefinite"
        />
      </circle>
    </g>
  );
}

// =============================================================================
// CostMeter — Tier 1 / 2 / 3 ladder
// =============================================================================

function CostMeter({ activeTier }: { activeTier: 1 | 2 | 3 | null }) {
  const tiers: Array<{ n: 1 | 2 | 3; label: string; cost: string }> = [
    { n: 1, label: "Keyword extract", cost: "$0" },
    { n: 2, label: "Conflict / facilitator", cost: "≈ $0.001 / turn" },
    { n: 3, label: "Synthesis", cost: "≈ $0.02 once" },
  ];
  return (
    <div className="absolute left-5 bottom-5 select-none">
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
// MiniChart — decorative health chart, dips during a2a/synthesis
// Progressively reveals as phases advance.
// =============================================================================

function MiniChart({
  activePhase,
  mode,
  phaseIndex,
}: {
  activePhase: PhaseId;
  mode: Mode;
  phaseIndex: number;
}) {
  // Two wavy paths. They climb during contribution; one dips during a2a; both spike at synthesis.
  const dipped = activePhase === "a2a" || activePhase === "synthesis";
  // Static path data — we just shift opacity / dash to simulate movement
  // Top line (consensus)
  const consensus = "M 0 38 C 18 36 28 30 44 28 C 60 26 72 22 90 16 C 110 10 120 8 140 8";
  // Bottom line (variance) — dips when a2a
  const variance = dipped
    ? "M 0 22 C 18 24 30 32 50 38 C 70 44 92 38 110 30 C 122 24 132 24 140 22"
    : "M 0 22 C 20 21 35 18 55 16 C 80 14 100 12 140 10";

  // How much of the chart is "drawn so far" — phase 0 = ~14%, phase 6 = 100%.
  // In "all" mode, show the whole chart.
  const lastIdx = PHASES.length - 1; // 6
  const reveal =
    mode === "all"
      ? 1
      : Math.max(0.14, (phaseIndex + 1) / (lastIdx + 1));

  // Live signals: a small ticking dot on the top line
  return (
    <div className="absolute right-5 top-5 w-[180px] select-none">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[9px] tracking-[0.32em] uppercase text-stone-500">
          Health · live signals
        </div>
        <div className="text-[8px] font-mono text-emerald-400/70 flex items-center gap-1">
          <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
          ON
        </div>
      </div>
      <svg viewBox="0 0 140 48" className="w-full h-12">
        <line x1="0" y1="46" x2="140" y2="46" stroke="rgba(231,229,228,0.1)" strokeWidth="0.5" />
        <line x1="0" y1="2" x2="140" y2="2" stroke="rgba(231,229,228,0.05)" strokeWidth="0.5" />
        {/* Progressive reveal marker — a soft vertical line at the current frontier */}
        <motion.line
          x1={0}
          x2={0}
          y1={2}
          y2={46}
          stroke="rgba(252,211,77,0.5)"
          strokeWidth="0.8"
          strokeDasharray="1 2"
          initial={false}
          animate={{ x1: reveal * 140, x2: reveal * 140 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        />
        <motion.path
          d={consensus}
          fill="none"
          stroke="rgba(125,211,252,0.85)"
          strokeWidth="1.2"
          strokeLinecap="round"
          initial={false}
          animate={{ pathLength: reveal, opacity: 1 }}
          transition={{ duration: 0.9, ease: "easeOut" }}
          style={{ pathLength: reveal } as React.CSSProperties}
        />
        <motion.path
          d={variance}
          fill="none"
          stroke="rgba(251,191,36,0.7)"
          strokeWidth="1.2"
          strokeLinecap="round"
          initial={false}
          animate={{ pathLength: reveal, opacity: 1 }}
          transition={{ duration: 0.9, ease: "easeOut" }}
          key={`v-${dipped ? "d" : "u"}`}
        />
      </svg>
      <div className="flex justify-between text-[8px] text-stone-600 font-mono mt-0.5">
        <span>t = 0</span>
        <span>t = resolve</span>
      </div>
    </div>
  );
}

// =============================================================================
// PhaseRail — right column list of phases
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
        the seven phases
      </div>
      <ol className="space-y-2.5">
        {PHASES.map((p) => {
          const active = mode !== "all" && p.index === phaseIndex;
          const visited = mode === "all" || p.index <= phaseIndex;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p.index)}
                title={p.watch}
                aria-label={`${p.eyebrow} — ${p.title}. ${p.watch}.`}
                className={`group w-full text-left transition-colors duration-300 ${
                  active ? "text-stone-100" : visited ? "text-stone-400" : "text-stone-600"
                }`}
                aria-current={active ? "step" : undefined}
              >
                <div className="flex items-baseline gap-3">
                  <span
                    className={`font-mono text-[10px] w-8 shrink-0 ${
                      active
                        ? "text-amber-300"
                        : visited
                        ? "text-stone-500"
                        : "text-stone-700"
                    }`}
                  >
                    {p.eyebrow.split(" /")[0]}
                  </span>
                  <span className="font-serif text-[15px] leading-snug group-hover:text-stone-100">
                    {p.title}
                  </span>
                </div>
                {/* Watch hint — visible when active, hover-revealed otherwise */}
                <div
                  className={`mt-1 ml-11 text-[10px] tracking-[0.18em] uppercase font-mono transition-opacity duration-300 ${
                    active
                      ? "text-amber-300/80 opacity-100"
                      : "text-stone-500 opacity-0 group-hover:opacity-100"
                  }`}
                >
                  {p.watch}
                </div>
                {active && (
                  <motion.div
                    layoutId="phaseRailBar"
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
// FloatingControls — pinned inside the canvas so they're always visible
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
  // In "all" mode, show a slimmer hint bar (no prev/next/play).
  if (mode === "all") {
    return (
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
        <div className="rounded-full border border-stone-800/80 bg-[#06070a]/85 backdrop-blur px-4 py-1.5 text-[10px] tracking-[0.28em] uppercase text-stone-500 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.8)]">
          full system view ·{" "}
          <kbd className="px-1 py-0.5 mx-0.5 rounded bg-stone-900 border border-stone-800 font-mono text-[9px] text-stone-400">←</kbd>
          <kbd className="px-1 py-0.5 mx-0.5 rounded bg-stone-900 border border-stone-800 font-mono text-[9px] text-stone-400">→</kbd>{" "}
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
          <kbd className="px-1 py-0.5 mx-0.5 rounded bg-stone-900/70 border border-stone-800 text-stone-500">space</kbd>{" "}
          play/pause ·{" "}
          <kbd className="px-1 py-0.5 mx-0.5 rounded bg-stone-900/70 border border-stone-800 text-stone-500">←</kbd>
          <kbd className="px-1 py-0.5 mx-0.5 rounded bg-stone-900/70 border border-stone-800 text-stone-500">→</kbd>{" "}
          step
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// ModeSwitcher (top-right)
// =============================================================================

function ModeSwitcher({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const options: Array<{ id: Mode; label: string }> = [
    { id: "auto", label: "Autoplay" },
    { id: "manual", label: "Manual" },
    { id: "all", label: "Show full system" },
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
// Backdrop — radial vignette + grain
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
      {/* subtle vignette */}
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
// LongForm — static below-the-fold prose
// =============================================================================

function LongForm() {
  return (
    <section className="relative z-10 px-6 md:px-12 py-16 border-t border-stone-900">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12">
        <div className="md:col-span-4">
          <div className="text-[10px] tracking-[0.32em] uppercase text-stone-500">
            For the longer read
          </div>
          <h2 className="font-serif text-3xl md:text-4xl text-stone-100 mt-3 leading-tight">
            People decide.<br />
            <span className="text-stone-500">Agents shape the path.</span>
          </h2>
        </div>
        <div className="md:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-8">
          <Detail
            num="01"
            title="One LLM call, six roles"
            body="The architect describes the problem in plain English. A single Tier-3 call returns a quorum of 4–6 roles, each with persona, authority rank, domain tags, and temperature. No N+1 round-trips, no per-role spawning."
          />
          <Detail
            num="02"
            title="Stations & QR pairing"
            body="A station is a physical workstation with its own URL. Scanning the QR pairs a person to a role. People rotate freely during the event — the role's state persists."
          />
          <Detail
            num="03"
            title="Tiered cost"
            body="Tier 1 is deterministic and free. Tier 2 only fires when structured fields overlap. Tier 3 fires exactly once at /resolve. Cost is bounded by quorum size, not turn count."
          />
          <Detail
            num="04"
            title="Tags as routing"
            body="Each agent reply ends with a [tags: …] block. Tags grow a shared vocabulary. They also decide A2A overlap — when one agent's tags intersect another's domain, the agents ping each other directly."
          />
          <Detail
            num="05"
            title="Live signals"
            body="Option B: the chart's lines reflect signal content, not turn count. Lines can dip — when an A2A exchange surfaces a real conflict, variance widens before consensus reconverges."
          />
          <Detail
            num="06"
            title="One synthesis, no lost writes"
            body="POST /quorums/{id}/resolve fires a single GPT-4o call over every contribution and agent exchange. The artifact write uses optimistic locking (version + CAS) — concurrent resolves return 409, never overwrite."
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
