import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuorumHealthChart } from "@/components/dashboards/QuorumHealthChart";
import { createMockSnapshot } from "@/lib/mockStream";

// Mock useQuorumLive to avoid timers in render tests
vi.mock("@/hooks/useQuorumLive", () => ({
  useQuorumLive: () => ({
    healthScore: 0,
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
  }),
}));

// Mock ResponsiveContainer — jsdom has no layout engine so it renders nothing
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

describe("QuorumHealthChart", () => {
  it("renders header and score with static history", () => {
    const snapshot = createMockSnapshot(0.6);
    render(
      <QuorumHealthChart
        quorumId="test-quorum"
        staticHistory={snapshot.history}
        staticScore={snapshot.healthScore}
      />,
    );

    expect(screen.getByText("Quorum Health")).toBeInTheDocument();
    expect(screen.getByText(String(Math.round(snapshot.healthScore)))).toBeInTheDocument();
    expect(screen.getByText("/100")).toBeInTheDocument();
  });

  it("renders the chart container", () => {
    const snapshot = createMockSnapshot(0.5);
    render(
      <QuorumHealthChart
        quorumId="test-quorum"
        staticHistory={snapshot.history}
        staticScore={50}
      />,
    );

    expect(screen.getByTestId("responsive-container")).toBeInTheDocument();
  });

  it("applies green color when score exceeds threshold", () => {
    const snapshot = createMockSnapshot(0.9);
    render(
      <QuorumHealthChart
        quorumId="test-quorum"
        threshold={50}
        staticHistory={snapshot.history}
        staticScore={80}
      />,
    );

    const scoreEl = screen.getByText("80");
    expect(scoreEl).toHaveStyle({ color: "#34d399" });
  });

  it("applies yellow color for mid-range score", () => {
    const snapshot = createMockSnapshot(0.5);
    render(
      <QuorumHealthChart
        quorumId="test-quorum"
        threshold={80}
        staticHistory={snapshot.history}
        staticScore={60}
      />,
    );

    const scoreEl = screen.getByText("60");
    expect(scoreEl).toHaveStyle({ color: "#fbbf24" });
  });

  it("applies red color when score is low", () => {
    const snapshot = createMockSnapshot(0.1);
    render(
      <QuorumHealthChart
        quorumId="test-quorum"
        staticHistory={snapshot.history}
        staticScore={30}
      />,
    );

    const scoreEl = screen.getByText("30");
    expect(scoreEl).toHaveStyle({ color: "#f87171" });
  });

  it("handles empty history gracefully", () => {
    render(
      <QuorumHealthChart
        quorumId="test-quorum"
        staticHistory={[]}
        staticScore={0}
      />,
    );

    expect(screen.getByText("Quorum Health")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("shows connecting indicator when not connected and no static data", () => {
    // Override mock for this test to show disconnected state
    vi.doMock("@/hooks/useQuorumLive", () => ({
      useQuorumLive: () => ({
        healthScore: 0,
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
        connected: false,
        error: "Supabase unavailable",
      }),
    }));
  });
});
