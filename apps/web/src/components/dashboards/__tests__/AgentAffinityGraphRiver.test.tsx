import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  AgentAffinityGraphRiver,
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

beforeEach(() => {
  // Default fetch — return a small role list so the river renders, and a
  // matching affinity-graph response since the component fetches both in
  // parallel via Promise.all.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/affinity-graph")) {
        return new Response(
          JSON.stringify({
            nodes: [
              { id: "role-1", label: "IRB Officer", tags: ["ethics"] },
              { id: "role-2", label: "Site Coordinator", tags: ["site"] },
            ],
            edges: [
              {
                source: "role-1",
                target: "role-2",
                weight: 0.3,
                interactionType: "collaborative",
              },
            ],
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
    }),
  );
});

describe("AgentAffinityGraphRiver", () => {
  it("renders without error and shows the listening hint when sparse", async () => {
    render(<AgentAffinityGraphRiver quorumId="quorum-test" />);

    // Initial loading state
    expect(screen.getByTestId("agent-affinity-river-loading")).toBeTruthy();

    // After fetch resolves, river canvas appears
    await waitFor(() =>
      expect(screen.getByTestId("agent-affinity-river")).toBeTruthy(),
    );

    // With zero events the sparse hint should be visible
    expect(
      screen.getByTestId("agent-affinity-river-listening"),
    ).toBeTruthy();

    // SVG canvas is present
    const svg = document.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-label")).toBe(
      "Agent affinity river streamgraph",
    );
  });

  it("renders the empty-state hint when role-status returns no roles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(<AgentAffinityGraphRiver quorumId="quorum-empty" />);
    await waitFor(() =>
      expect(screen.getByTestId("agent-affinity-river-empty")).toBeTruthy(),
    );
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
