import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { AgentAffinityGraphHeatmap } from "../AgentAffinityGraphHeatmap";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Stub out the dataProvider subscription so we don't try to talk to Supabase.
vi.mock("@/lib/dataProvider", () => ({
  subscribeToContributions: vi.fn(() => () => {}),
}));

// Stub the Supabase client so the dynamic import resolves without throwing.
vi.mock("@/lib/supabase", () => ({
  supabase: {
    channel: () => ({
      on: () => ({ subscribe: () => ({}) }),
    }),
    removeChannel: vi.fn(),
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AgentAffinityGraphHeatmap", () => {
  it("renders the matrix when staticRoles are provided", async () => {
    render(
      <AgentAffinityGraphHeatmap
        quorumId="quorum-test"
        staticRoles={[
          { role_id: "r1", name: "IRB Officer", authority_rank: 3 },
          { role_id: "r2", name: "Site Coord", authority_rank: 2 },
          { role_id: "r3", name: "Sponsor", authority_rank: 1 },
        ]}
      />,
    );

    // Initial tick (effect) runs synchronously inside React's batch; we still
    // run timers to flush the matchMedia + cluster pass.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The container with the matrix should exist.
    expect(screen.getByTestId("agent-affinity-heatmap")).toBeTruthy();

    // 3 x 3 = 9 cells should be rendered.
    const cells = [
      "cell-r1-r1",
      "cell-r1-r2",
      "cell-r1-r3",
      "cell-r2-r1",
      "cell-r2-r2",
      "cell-r2-r3",
      "cell-r3-r1",
      "cell-r3-r2",
      "cell-r3-r3",
    ];
    for (const id of cells) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it("shows a loading state when no staticRoles are passed (REST not stubbed)", () => {
    // fetch is undefined in jsdom -> the component sets loadError but
    // initially must show the loading placeholder.
    render(<AgentAffinityGraphHeatmap quorumId="quorum-x" />);
    expect(screen.getByTestId("agent-affinity-heatmap-loading")).toBeTruthy();
  });
});
