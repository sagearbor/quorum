import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GhostRadar } from "../GhostRadar";
import type { HealthSnapshot } from "@quorum/types";

// ---------------------------------------------------------------------------
// Mocks — same shape as QuorumHealthChart.test.tsx
// ---------------------------------------------------------------------------

vi.mock("@/hooks/useQuorumLive", () => ({
  useQuorumLive: () => ({
    healthScore: 60,
    metrics: {
      completion_pct: 0,
      consensus_score: 0,
      role_coverage_pct: 0,
      critical_path_score: 0,
      blocker_score: 0,
    },
    history: [],
    recentContributions: [],
    artifact: null,
    connected: true,
    error: null,
    llmDeltas: {},
    llmRationales: [],
    a2aEvents: [],
  }),
}));

vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container" style={{ width: 800, height: 400 }}>
        {children}
      </div>
    ),
  };
});

function makeSnap(metrics: HealthSnapshot["metrics"], ts = Date.now()): HealthSnapshot {
  return {
    timestamp: ts,
    // Composite score isn't used by the GhostRadar polygons themselves.
    score: 50,
    metrics,
  };
}

describe("GhostRadar", () => {
  it("renders both ghost and current polygons when history has ≥2 snapshots", () => {
    const initial = makeSnap({
      completion_pct: 10,
      consensus_score: 20,
      role_coverage_pct: 30,
      critical_path_score: 40,
      blocker_score: 50,
    });
    const now = makeSnap({
      completion_pct: 22,
      consensus_score: 16,
      role_coverage_pct: 30,
      critical_path_score: 55,
      blocker_score: 65,
    });

    render(
      <GhostRadar quorumId="q-test" staticHistory={[initial, now]} />,
    );

    // Header + caption mount as the visible contract. Recharts doesn't
    // measure SVG in jsdom (mirrors QuorumHealthChart.test.tsx), so the
    // radar wrap + the 5 delta pills are the stable surface we assert on.
    expect(screen.getByText("Ghost-Trail Radar")).toBeInTheDocument();
    expect(
      screen.getByText("Initial baseline vs. current state"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ghost-radar-wrap")).toBeInTheDocument();
    expect(screen.getByTestId("responsive-container")).toBeInTheDocument();

    // Five delta pills, one per axis.
    expect(screen.getByTestId("pill-Completion")).toBeInTheDocument();
    expect(screen.getByTestId("pill-Consensus")).toBeInTheDocument();
    expect(screen.getByTestId("pill-Role Coverage")).toBeInTheDocument();
    expect(screen.getByTestId("pill-Critical Path")).toBeInTheDocument();
    expect(screen.getByTestId("pill-Path Clear")).toBeInTheDocument();
  });

  it("flips pill color with the sign of the delta", () => {
    // Completion went up (+12), Consensus went down (-4), Role Coverage flat (±0).
    const initial = makeSnap({
      completion_pct: 10,
      consensus_score: 20,
      role_coverage_pct: 30,
      critical_path_score: 40,
      blocker_score: 50,
    });
    const now = makeSnap({
      completion_pct: 22,
      consensus_score: 16,
      role_coverage_pct: 30,
      critical_path_score: 40,
      blocker_score: 50,
    });

    render(
      <GhostRadar quorumId="q-test" staticHistory={[initial, now]} />,
    );

    expect(
      screen.getByTestId("pill-Completion").getAttribute("data-sign"),
    ).toBe("pos");
    expect(
      screen.getByTestId("pill-Consensus").getAttribute("data-sign"),
    ).toBe("neg");
    expect(
      screen.getByTestId("pill-Role Coverage").getAttribute("data-sign"),
    ).toBe("zero");
  });

  it("shows the 'will appear' caption when history is empty", () => {
    render(<GhostRadar quorumId="q-empty" staticHistory={[]} />);
    expect(
      screen.getByText("Ghost will appear as the quorum evolves"),
    ).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Scrub + transport controls
  // -------------------------------------------------------------------------

  function makeHistory(n: number): HealthSnapshot[] {
    const out: HealthSnapshot[] = [];
    const base = Date.now() - n * 1000;
    for (let i = 0; i < n; i += 1) {
      out.push(
        makeSnap(
          {
            completion_pct: i * 5,
            consensus_score: i * 4,
            role_coverage_pct: i * 3,
            critical_path_score: i * 2,
            blocker_score: i,
          },
          base + i * 1000,
        ),
      );
    }
    return out;
  }

  it("renders scrub slider + Play / Loop / Live controls when history is long enough", () => {
    render(<GhostRadar quorumId="q-controls" staticHistory={makeHistory(5)} />);
    expect(screen.getByTestId("ghost-radar-scrub-slider")).toBeInTheDocument();
    expect(screen.getByTestId("ghost-radar-play")).toBeInTheDocument();
    expect(screen.getByTestId("ghost-radar-autoloop")).toBeInTheDocument();
    expect(screen.getByTestId("ghost-radar-live")).toBeInTheDocument();
  });

  it("scrub position is sticky — value persists after the change event (no snap back)", () => {
    render(<GhostRadar quorumId="q-sticky" staticHistory={makeHistory(8)} />);
    const slider = screen.getByTestId(
      "ghost-radar-scrub-slider",
    ) as HTMLInputElement;

    // Move the slider to index 3 and "release" (we don't fire any extra mouse-up
    // because there shouldn't be a snap-back handler anymore).
    fireEvent.change(slider, { target: { value: "3" } });

    expect(slider.value).toBe("3");
    // The label should show the scrubbed snapshot, not "live · now".
    const label = screen.getByTestId("ghost-radar-scrub-label");
    expect(label.textContent).toContain("4/8");
    expect(label.textContent).not.toContain("live");
  });

  it("Live button resets scrubIdx so the slider snaps back to NOW", () => {
    render(<GhostRadar quorumId="q-live" staticHistory={makeHistory(6)} />);
    const slider = screen.getByTestId(
      "ghost-radar-scrub-slider",
    ) as HTMLInputElement;

    fireEvent.change(slider, { target: { value: "2" } });
    expect(slider.value).toBe("2");

    fireEvent.click(screen.getByTestId("ghost-radar-live"));
    // Slider value reflects the latest snapshot index (history.length - 1).
    expect(slider.value).toBe("5");
    expect(screen.getByTestId("ghost-radar-scrub-label").textContent).toContain(
      "live",
    );
  });

  it("auto-loop button toggles aria-pressed", () => {
    render(<GhostRadar quorumId="q-loop" staticHistory={makeHistory(5)} />);
    const loopBtn = screen.getByTestId("ghost-radar-autoloop");
    expect(loopBtn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(loopBtn);
    expect(loopBtn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(loopBtn);
    expect(loopBtn.getAttribute("aria-pressed")).toBe("false");
  });

  describe("Play animation", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("advances the slider one step at a time when Play is pressed", () => {
      render(<GhostRadar quorumId="q-play" staticHistory={makeHistory(6)} />);
      const slider = screen.getByTestId(
        "ghost-radar-scrub-slider",
      ) as HTMLInputElement;
      const playBtn = screen.getByTestId("ghost-radar-play");

      // Initially "live · now" — slider parked on history.length - 1 = 5.
      expect(slider.value).toBe("5");

      // Start play. The effect seeds scrubIdx to 0 immediately on the first
      // effect run (no timer needed for the seed).
      act(() => {
        fireEvent.click(playBtn);
      });
      expect(slider.value).toBe("0");

      // Step forward through history. PLAY_TOTAL_MS / 6 = 1000ms but it's
      // clamped to PLAY_MAX_STEP_MS = 600ms.
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(slider.value).toBe("1");

      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(slider.value).toBe("2");
    });

    it("stops playback when reaching the end and auto-loop is OFF", () => {
      render(<GhostRadar quorumId="q-end" staticHistory={makeHistory(3)} />);
      const slider = screen.getByTestId(
        "ghost-radar-scrub-slider",
      ) as HTMLInputElement;
      const playBtn = screen.getByTestId("ghost-radar-play");

      act(() => {
        fireEvent.click(playBtn);
      });
      expect(slider.value).toBe("0");
      // 3 frames @ 600ms step ceiling (6000/3 = 2000ms clamped to 600).
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(slider.value).toBe("1");
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(slider.value).toBe("2");
      // Next tick — we're at end, no loop → snap back to live.
      act(() => {
        vi.advanceTimersByTime(600);
      });
      // scrubIdx === null → slider parks on history.length - 1 again.
      expect(slider.value).toBe("2");
      expect(screen.getByTestId("ghost-radar-scrub-label").textContent).toContain(
        "live",
      );
      // Play button has flipped back to "Play".
      expect(playBtn.getAttribute("aria-pressed")).toBe("false");
    });

    it("loops back to 0 when auto-loop is ON and end is reached", () => {
      render(<GhostRadar quorumId="q-loop-play" staticHistory={makeHistory(3)} />);
      const slider = screen.getByTestId(
        "ghost-radar-scrub-slider",
      ) as HTMLInputElement;

      // Turn on auto-loop, then play.
      act(() => {
        fireEvent.click(screen.getByTestId("ghost-radar-autoloop"));
        fireEvent.click(screen.getByTestId("ghost-radar-play"));
      });
      expect(slider.value).toBe("0");

      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(slider.value).toBe("1");
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(slider.value).toBe("2");
      // Next tick at end → loop to 0 because autoLoop is ON.
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(slider.value).toBe("0");
      // Still playing.
      expect(
        screen.getByTestId("ghost-radar-play").getAttribute("aria-pressed"),
      ).toBe("true");
    });

    it("scrubbing manually while playing pauses playback", () => {
      render(<GhostRadar quorumId="q-interrupt" staticHistory={makeHistory(5)} />);
      const slider = screen.getByTestId(
        "ghost-radar-scrub-slider",
      ) as HTMLInputElement;
      const playBtn = screen.getByTestId("ghost-radar-play");

      act(() => {
        fireEvent.click(playBtn);
      });
      expect(playBtn.getAttribute("aria-pressed")).toBe("true");

      act(() => {
        fireEvent.change(slider, { target: { value: "1" } });
      });
      expect(playBtn.getAttribute("aria-pressed")).toBe("false");
      expect(slider.value).toBe("1");
    });
  });
});
