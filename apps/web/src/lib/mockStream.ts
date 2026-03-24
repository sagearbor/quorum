/**
 * Mock stream — simulates a live WebSocket stream of health updates.
 * Used only when NEXT_PUBLIC_QUORUM_TEST_MODE=true.
 *
 * Produces HealthMetrics that rise over time, simulating a quorum resolving.
 */

import type { HealthMetrics, HealthSnapshot, StreamContribution, StreamState } from "@quorum/types";

export type { StreamContribution, StreamState };

type StreamCallback = (state: StreamState) => void;

const ROLE_NAMES = ["Principal Investigator", "IRB Representative", "Biostatistician", "Patient Advocate", "Site Coordinator"];
const ROLE_IDS = ["role-pi", "role-irb", "role-bio", "role-patient", "role-site"];
const CONTRIBUTION_SNIPPETS = [
  "Updated inclusion criteria for age range 18-65",
  "Confirmed IRB approval for protocol amendment",
  "Statistical power analysis shows n=240 sufficient",
  "Patient consent form revised for clarity",
  "Site 3 enrollment tracking on schedule",
  "Adverse event reporting pathway confirmed",
  "Data monitoring committee schedule finalized",
  "Blinding procedure validated by pharmacy",
  "Interim analysis plan approved",
  "Endpoint adjudication criteria defined",
];

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function jitter(base: number, range: number): number {
  return base + (Math.random() - 0.5) * range;
}

function generateMetrics(elapsed: number, totalDuration: number): HealthMetrics {
  const progress = clamp(elapsed / totalDuration, 0, 1);
  const eased = easeOut(progress);

  return {
    completion_pct: clamp(jitter(eased * 85 + 10, 6), 0, 100),
    consensus_score: clamp(jitter(eased * 78 + 15, 8), 0, 100),
    role_coverage_pct: clamp(jitter(Math.min(eased * 1.2, 1) * 90 + 10, 4), 0, 100),
    critical_path_score: clamp(jitter(eased * 70 + 20, 10), 0, 100),
    blocker_score: clamp(jitter(eased * 80 + 15, 5), 0, 100),
  };
}

function computeComposite(m: HealthMetrics): number {
  return clamp(
    m.completion_pct * 0.25 +
      m.consensus_score * 0.25 +
      m.role_coverage_pct * 0.2 +
      m.critical_path_score * 0.15 +
      m.blocker_score * 0.15,
    0,
    100,
  );
}

/** Generate a static initial history so the chart isn't empty on first render. */
function generateInitialHistory(count: number, totalDuration: number): HealthSnapshot[] {
  const now = Date.now();
  const intervalMs = 2000;
  const history: HealthSnapshot[] = [];

  for (let i = 0; i < count; i++) {
    const elapsed = (i / count) * totalDuration * 0.3; // first 30% of total
    const metrics = generateMetrics(elapsed, totalDuration);
    const score = computeComposite(metrics);
    history.push({
      timestamp: now - (count - i) * intervalMs,
      score,
      metrics,
    });
  }

  return history;
}

function generateContribution(index: number): StreamContribution {
  const roleIndex = index % ROLE_NAMES.length;
  return {
    id: `mock-contrib-${Date.now()}-${index}`,
    role_id: ROLE_IDS[roleIndex],
    role_name: ROLE_NAMES[roleIndex],
    content: CONTRIBUTION_SNIPPETS[index % CONTRIBUTION_SNIPPETS.length],
    created_at: new Date().toISOString(),
  };
}

/**
 * Start a mock stream for a quorum. Returns an unsubscribe function.
 *
 * @param quorumId - Used for seeding (ignored in mock, but kept for API compat)
 * @param callback - Called on every tick with the latest state
 * @param intervalMs - Tick interval (default 2000ms)
 * @param totalDurationMs - Total time for the quorum to "resolve" (default 120s)
 */
export function createMockStream(
  _quorumId: string,
  callback: StreamCallback,
  intervalMs = 2000,
  totalDurationMs = 120_000,
): () => void {
  const startTime = Date.now();
  const initialHistory = generateInitialHistory(8, totalDurationMs);
  let contributions: StreamContribution[] = [];
  let contribIndex = 0;
  let tick = 0;

  const timer = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const metrics = generateMetrics(elapsed, totalDurationMs);
    const score = computeComposite(metrics);

    const snapshot: HealthSnapshot = {
      timestamp: Date.now(),
      score,
      metrics,
    };

    // Add a new contribution every ~3 ticks
    if (tick % 3 === 0) {
      contributions = [...contributions.slice(-19), generateContribution(contribIndex++)];
    }

    const history = [...initialHistory, ...Array(tick + 1)].map((_, i) => {
      if (i < initialHistory.length) return initialHistory[i];
      const tickElapsed = ((i - initialHistory.length) / (totalDurationMs / intervalMs)) * totalDurationMs;
      const m = generateMetrics(tickElapsed, totalDurationMs);
      return { timestamp: startTime + (i - initialHistory.length) * intervalMs, score: computeComposite(m), metrics: m };
    });

    // Replace last entry with current snapshot
    history[history.length - 1] = snapshot;

    const artifactThreshold = 75;
    let artifact: StreamState["artifact"] = null;
    if (score > artifactThreshold + 10) {
      artifact = { status: "final", version: 2 };
    } else if (score > artifactThreshold) {
      artifact = { status: "pending_ratification", version: 1 };
    }

    callback({
      healthScore: score,
      metrics,
      history: history.slice(-60), // Keep last 60 data points
      recentContributions: contributions,
      artifact,
    });

    tick++;
  }, intervalMs);

  // Emit initial state immediately
  const initialMetrics = generateMetrics(0, totalDurationMs);
  callback({
    healthScore: computeComposite(initialMetrics),
    metrics: initialMetrics,
    history: initialHistory,
    recentContributions: [],
    artifact: null,
  });

  return () => clearInterval(timer);
}

/** Static snapshot for testing / SSR — no timer, no side effects. */
export function createMockSnapshot(progress = 0.5): StreamState {
  const totalDuration = 120_000;
  const elapsed = progress * totalDuration;
  const metrics = generateMetrics(elapsed, totalDuration);
  const score = computeComposite(metrics);
  const history = generateInitialHistory(12, totalDuration);

  return {
    healthScore: score,
    metrics,
    history,
    recentContributions: Array.from({ length: 5 }, (_, i) => generateContribution(i)),
    artifact: score > 75 ? { status: "draft", version: 1 } : null,
  };
}
