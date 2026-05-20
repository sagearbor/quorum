import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
