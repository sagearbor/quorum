import { describe, it, expect, vi, afterEach } from "vitest";
import { createMockStream, createMockSnapshot, type StreamState } from "@/lib/mockStream";

describe("createMockSnapshot", () => {
  it("returns valid initial state at progress=0", () => {
    const snap = createMockSnapshot(0);
    expect(snap.healthScore).toBeGreaterThanOrEqual(0);
    expect(snap.healthScore).toBeLessThanOrEqual(100);
    expect(snap.metrics.completion_pct).toBeGreaterThanOrEqual(0);
    expect(snap.metrics.consensus_score).toBeGreaterThanOrEqual(0);
    expect(snap.metrics.role_coverage_pct).toBeGreaterThanOrEqual(0);
    expect(snap.metrics.critical_path_score).toBeGreaterThanOrEqual(0);
    expect(snap.metrics.blocker_score).toBeGreaterThanOrEqual(0);
    expect(snap.history.length).toBeGreaterThan(0);
  });

  it("returns higher scores at progress=1 than progress=0", () => {
    // Run multiple times to account for jitter
    let higherCount = 0;
    for (let i = 0; i < 20; i++) {
      const early = createMockSnapshot(0.1);
      const late = createMockSnapshot(0.9);
      if (late.healthScore > early.healthScore) higherCount++;
    }
    // At least 80% of trials should show higher scores at progress=0.9
    expect(higherCount).toBeGreaterThanOrEqual(16);
  });

  it("includes recent contributions", () => {
    const snap = createMockSnapshot(0.5);
    expect(snap.recentContributions.length).toBeGreaterThan(0);
    expect(snap.recentContributions[0]).toHaveProperty("id");
    expect(snap.recentContributions[0]).toHaveProperty("role_name");
    expect(snap.recentContributions[0]).toHaveProperty("content");
  });

  it("history snapshots have timestamps and metrics", () => {
    const snap = createMockSnapshot(0.5);
    for (const h of snap.history) {
      expect(h.timestamp).toBeGreaterThan(0);
      expect(h.score).toBeGreaterThanOrEqual(0);
      expect(h.score).toBeLessThanOrEqual(100);
      expect(h.metrics).toBeDefined();
    }
  });
});

describe("createMockStream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits initial state immediately (synchronously)", () => {
    const states: StreamState[] = [];
    const unsub = createMockStream("test-quorum", (s) => states.push(s));
    // Initial state is emitted synchronously
    expect(states.length).toBe(1);
    expect(states[0].history.length).toBeGreaterThan(0);
    unsub();
  });

  it("emits updates over time", async () => {
    vi.useFakeTimers();
    const states: StreamState[] = [];
    const unsub = createMockStream("test-quorum", (s) => states.push(s), 100);

    // Initial emission
    expect(states.length).toBe(1);

    // Advance 3 intervals
    vi.advanceTimersByTime(350);
    expect(states.length).toBe(4); // 1 initial + 3 ticks

    unsub();
    vi.useRealTimers();
  });

  it("health scores generally increase over time", async () => {
    vi.useFakeTimers();
    const states: StreamState[] = [];
    const unsub = createMockStream("test-quorum", (s) => states.push(s), 100, 5000);

    // Let it run for the full duration
    vi.advanceTimersByTime(5000);

    const scores = states.map((s) => s.healthScore);
    const firstFew = scores.slice(0, 5);
    const lastFew = scores.slice(-5);
    const avgFirst = firstFew.reduce((a, b) => a + b, 0) / firstFew.length;
    const avgLast = lastFew.reduce((a, b) => a + b, 0) / lastFew.length;

    expect(avgLast).toBeGreaterThan(avgFirst);

    unsub();
    vi.useRealTimers();
  });

  it("unsubscribe stops emission", () => {
    vi.useFakeTimers();
    const states: StreamState[] = [];
    const unsub = createMockStream("test-quorum", (s) => states.push(s), 100);

    vi.advanceTimersByTime(250);
    const countBefore = states.length;

    unsub();
    vi.advanceTimersByTime(500);
    expect(states.length).toBe(countBefore);

    vi.useRealTimers();
  });

  it("generates contributions periodically", () => {
    vi.useFakeTimers();
    const states: StreamState[] = [];
    const unsub = createMockStream("test-quorum", (s) => states.push(s), 100);

    // Advance enough ticks to generate contributions (every 3rd tick)
    vi.advanceTimersByTime(1000);

    const lastState = states[states.length - 1];
    expect(lastState.recentContributions.length).toBeGreaterThan(0);

    unsub();
    vi.useRealTimers();
  });
});
