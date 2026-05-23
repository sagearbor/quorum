import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import {
  AgentAffinityGraphRiver,
  affinityTint,
  chooseInitialViewMode,
  parseTags,
} from "../AgentAffinityGraphRiver";

// ---------------------------------------------------------------------------
// Mock @/lib/supabase to keep the realtime subscription a no-op in jsdom.
// The component imports it lazily via dynamic import().
// ---------------------------------------------------------------------------
vi.mock("@/lib/supabase", () => {
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  return {
    supabase: {
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Default fetch fixture — role-status + affinity-graph + state, all happy.
// Individual tests can override via vi.stubGlobal('fetch', ...).
// ---------------------------------------------------------------------------

function defaultFetch(
  opts: {
    quorumStatus?: string;
    resolvedAt?: string | null;
    contributions?: Array<{ created_at: string }>;
    edges?: Array<{
      source: string;
      target: string;
      weight: number;
      interactionType?: string;
    }>;
  } = {},
) {
  const {
    quorumStatus = "active",
    resolvedAt = null,
    contributions = [],
    edges = [
      {
        source: "role-1",
        target: "role-2",
        weight: 0.3,
        interactionType: "collaborative",
      },
    ],
  } = opts;
  return vi.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("/affinity-graph")) {
      return new Response(
        JSON.stringify({
          nodes: [
            { id: "role-1", label: "IRB Officer", tags: ["ethics"] },
            { id: "role-2", label: "Site Coordinator", tags: ["site"] },
          ],
          edges,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (typeof url === "string" && url.includes("/state")) {
      return new Response(
        JSON.stringify({
          quorum: { status: quorumStatus, resolved_at: resolvedAt },
          contributions,
          artifact: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify([
        {
          role_id: "role-1",
          name: "IRB Officer",
          status: "active",
          contributions_count: 0,
        },
        {
          role_id: "role-2",
          name: "Site Coordinator",
          status: "active",
          contributions_count: 0,
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

beforeEach(() => {
  // Clear persisted view-mode between tests so each test exercises the
  // density-driven default unless it sets its own value.
  try {
    window.localStorage.removeItem("riverAffinityViewMode");
  } catch {
    // ignore in environments without localStorage
  }
  vi.stubGlobal("fetch", defaultFetch());
});

describe("AgentAffinityGraphRiver", () => {
  it("renders without error and shows the listening hint when sparse", async () => {
    render(<AgentAffinityGraphRiver quorumId="quorum-test" />);

    expect(screen.getByTestId("agent-affinity-river-loading")).toBeTruthy();

    await waitFor(() =>
      expect(screen.getByTestId("agent-affinity-river")).toBeTruthy(),
    );

    expect(
      screen.getByTestId("agent-affinity-river-listening"),
    ).toBeTruthy();

    const svg = document.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-label")).toBe(
      "Agent affinity river streamgraph",
    );
  });

  it("renders the empty-state hint when role-status returns no roles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.includes("/affinity-graph")) {
          return new Response(JSON.stringify({ nodes: [], edges: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (typeof url === "string" && url.includes("/state")) {
          return new Response(
            JSON.stringify({ quorum: { status: "active" }, contributions: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    render(<AgentAffinityGraphRiver quorumId="quorum-empty" />);
    await waitFor(() =>
      expect(screen.getByTestId("agent-affinity-river-empty")).toBeTruthy(),
    );
  });

  it("renders the stream/bars toggle and persists the user choice", async () => {
    render(<AgentAffinityGraphRiver quorumId="quorum-toggle" />);
    await waitFor(() =>
      expect(screen.getByTestId("agent-affinity-river")).toBeTruthy(),
    );
    const stream = screen.getByTestId("river-view-mode-stream");
    const bars = screen.getByTestId("river-view-mode-bars");
    expect(stream).toBeTruthy();
    expect(bars).toBeTruthy();

    fireEvent.click(bars);
    expect(window.localStorage.getItem("riverAffinityViewMode")).toBe("bars");

    fireEvent.click(stream);
    expect(window.localStorage.getItem("riverAffinityViewMode")).toBe("stream");
  });

  it("renders the resolved-at marker for resolved quorums", async () => {
    const resolvedAtIso = new Date(Date.UTC(2026, 4, 23, 10, 0, 0)).toISOString();
    vi.stubGlobal(
      "fetch",
      defaultFetch({
        quorumStatus: "resolved",
        resolvedAt: resolvedAtIso,
        contributions: [
          { created_at: new Date(Date.UTC(2026, 4, 23, 9, 45, 0)).toISOString() },
          { created_at: new Date(Date.UTC(2026, 4, 23, 9, 55, 0)).toISOString() },
        ],
      }),
    );
    render(<AgentAffinityGraphRiver quorumId="quorum-resolved" />);
    await waitFor(() =>
      expect(screen.getByTestId("agent-affinity-river")).toBeTruthy(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("river-resolved-marker")).toBeTruthy(),
    );
    // Header swaps to "full lifetime" for resolved quorums.
    expect(screen.getByText(/full lifetime/)).toBeTruthy();
  });

  it("renders the y-axis label decoration", async () => {
    render(<AgentAffinityGraphRiver quorumId="quorum-decor" />);
    await waitFor(() =>
      expect(screen.getByTestId("agent-affinity-river")).toBeTruthy(),
    );
    expect(screen.getByTestId("river-y-axis-decor")).toBeTruthy();
  });

  it("renders pair-weight chips next to role labels", async () => {
    render(<AgentAffinityGraphRiver quorumId="quorum-chips" />);
    await waitFor(() =>
      expect(screen.getByTestId("agent-affinity-river")).toBeTruthy(),
    );
    // role-labels group exists; chips render inside it (one per non-empty edge).
    expect(screen.getByTestId("river-role-labels")).toBeTruthy();
    const chipGroups = document.querySelectorAll(
      "[data-testid='river-pair-chips']",
    );
    expect(chipGroups.length).toBeGreaterThan(0);
  });
});

describe("parseTags", () => {
  it("extracts canonical tags from a [tags: ...] block", () => {
    expect(
      parseTags("hello world [tags: IRB, Adverse Event, timeline] and more"),
    ).toEqual(["irb", "adverse_event", "timeline"]);
  });

  it("supports both [tag: ...] and [tags: ...] forms", () => {
    expect(parseTags("foo [tag: budget] bar [tags: safety, ethics]")).toEqual([
      "budget",
      "safety",
      "ethics",
    ]);
  });

  it("returns an empty array for input with no tag blocks", () => {
    expect(parseTags("just a plain sentence with no tags")).toEqual([]);
    expect(parseTags("")).toEqual([]);
  });
});

describe("affinityTint", () => {
  it("clamps to the cool end at 0 and warm end at 1", () => {
    expect(affinityTint(0)).toBe("rgb(100, 116, 139)");
    expect(affinityTint(1)).toBe("rgb(251, 146, 60)");
  });

  it("interpolates monotonically across the range", () => {
    const a = affinityTint(0.25);
    const b = affinityTint(0.75);
    expect(a).not.toBe(b);
    // The red channel should increase as affinity climbs.
    const ra = parseInt(a.match(/rgb\((\d+)/)?.[1] ?? "0", 10);
    const rb = parseInt(b.match(/rgb\((\d+)/)?.[1] ?? "0", 10);
    expect(rb).toBeGreaterThan(ra);
  });
});

describe("chooseInitialViewMode (density default)", () => {
  it("defaults to BARS when sparse (< 1.5 events/min)", () => {
    // Sophie's live quorum: 19 contributions across 15 min -> 1.27 / min.
    expect(chooseInitialViewMode(19, 15)).toBe("bars");
  });

  it("defaults to STREAM when dense (>= 1.5 events/min)", () => {
    expect(chooseInitialViewMode(60, 30)).toBe("stream");
  });

  it("defaults to BARS for empty data", () => {
    expect(chooseInitialViewMode(0, 0)).toBe("bars");
    expect(chooseInitialViewMode(10, 0)).toBe("bars");
  });
});
