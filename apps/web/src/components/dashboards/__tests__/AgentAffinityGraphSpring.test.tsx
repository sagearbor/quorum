import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  AgentAffinityGraphSpring,
  extractTagsFromContent,
  jaccard,
} from "../AgentAffinityGraphSpring";

// ---------------------------------------------------------------------------
// Mock the supabase module so the import inside the component resolves
// without hitting createClient (which requires real env vars).
// ---------------------------------------------------------------------------
vi.mock("@/lib/supabase", () => {
  const chan = {
    on() {
      return chan;
    },
    subscribe() {
      return chan;
    },
  };
  return {
    supabase: {
      channel: () => chan,
      removeChannel: () => {},
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: [] }),
        }),
      }),
    },
  };
});

beforeEach(() => {
  // Mock fetch so the role-status request resolves deterministically.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            role_id: "role-a",
            name: "Sponsor",
            status: "active",
            contributions_count: 4,
            blocked_by_names: [],
          },
          {
            role_id: "role-b",
            name: "IRB",
            status: "active",
            contributions_count: 2,
            blocked_by_names: [],
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe("extractTagsFromContent", () => {
  it("parses a single [tags: ...] block", () => {
    const out = extractTagsFromContent("hello world [tags: foo, bar, baz]");
    expect(out).toEqual(["foo", "bar", "baz"]);
  });

  it("parses multiple blocks and lowercases", () => {
    const out = extractTagsFromContent("[tag: X] some text [tags: Y, Z]");
    expect(out).toEqual(["x", "y", "z"]);
  });

  it("returns empty array for content without tags", () => {
    expect(extractTagsFromContent("no tags here")).toEqual([]);
    expect(extractTagsFromContent("")).toEqual([]);
  });
});

describe("jaccard", () => {
  it("returns 0 for empty sets", () => {
    expect(jaccard([], ["a"])).toBe(0);
    expect(jaccard(["a"], [])).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    expect(jaccard(["a", "b"], ["b", "a"])).toBe(1);
  });

  it("returns intersection / union otherwise", () => {
    // {a,b,c} ∩ {b,c,d} = 2; ∪ = 4; → 0.5
    expect(jaccard(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// Render test
// ---------------------------------------------------------------------------

describe("AgentAffinityGraphSpring", () => {
  it("renders the spring + heatmap panel once roles load", async () => {
    render(<AgentAffinityGraphSpring quorumId="quorum-xyz" />);
    // Initial state: connecting.
    expect(screen.getByTestId("agent-affinity-spring-loading")).toBeInTheDocument();

    // After fetch resolves we should see both halves of the panel.
    await waitFor(() => {
      expect(screen.getByTestId("agent-affinity-spring")).toBeInTheDocument();
    });
    expect(screen.getByTestId("affinity-spring-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("affinity-spring-heatmap")).toBeInTheDocument();
    // Nodes for both fetched roles.
    expect(screen.getByTestId("affinity-spring-node-role-a")).toBeInTheDocument();
    expect(screen.getByTestId("affinity-spring-node-role-b")).toBeInTheDocument();
  });

  it("shows the error state if the role-status fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    render(<AgentAffinityGraphSpring quorumId="quorum-err" />);
    await waitFor(() => {
      expect(screen.getByTestId("agent-affinity-spring-error")).toBeInTheDocument();
    });
  });
});
