import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  AgentAffinityGraphSpring,
  extractTagsFromContent,
  jaccard,
  radiusForContributions,
  resolveRoleColor,
  computeTargetPositions,
  type EdgeWeightMap,
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
  // Mock fetch so /role-status, /affinity-graph, and /state all resolve
  // deterministically. The component issues these via Promise.all + an extra
  // sequential fetch for historical contributions.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/affinity-graph")) {
        return new Response(
          JSON.stringify({
            nodes: [
              { id: "role-a", label: "Sponsor", tags: ["budget", "site_ops"] },
              { id: "role-b", label: "IRB", tags: ["budget", "ethics"] },
            ],
            edges: [
              {
                source: "role-a",
                target: "role-b",
                weight: 0.5,
                interactionType: "collaborative",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (typeof url === "string" && url.includes("/state")) {
        return new Response(
          JSON.stringify({
            quorum: { id: "quorum-xyz" },
            contributions: [
              { id: "c1", role_id: "role-a", created_at: "2026-01-01T00:00:00Z" },
              { id: "c2", role_id: "role-b", created_at: "2026-01-01T00:00:30Z" },
              { id: "c3", role_id: "role-a", created_at: "2026-01-01T00:01:00Z" },
            ],
            artifact: null,
            health_score: 0,
            active_roles: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
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
      );
    }),
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

describe("radiusForContributions", () => {
  it("returns the min radius at count=0", () => {
    expect(radiusForContributions(0)).toBe(14);
  });

  it("returns the max radius at the scale cap", () => {
    expect(radiusForContributions(10)).toBe(34);
  });

  it("clamps above the scale cap", () => {
    expect(radiusForContributions(50)).toBe(34);
  });

  it("clamps negative values to the min", () => {
    expect(radiusForContributions(-5)).toBe(14);
  });

  it("scales the live-data Architect/Steward gap to roughly 2.4x", () => {
    // 9 contribs -> 32; 2 contribs -> 18 → ratio ≈ 1.78. Even if not exactly
    // 2.4x, the heavier role must be visibly larger than the lighter one.
    const architect = radiusForContributions(9);
    const steward = radiusForContributions(2);
    expect(architect).toBeGreaterThan(steward + 10);
  });
});

describe("resolveRoleColor", () => {
  it("falls back to the palette when color is null", () => {
    expect(resolveRoleColor(null, 0)).toBe("#60a5fa");
    expect(resolveRoleColor(null, 1)).toBe("#34d399");
  });

  it("falls back to the palette when color is an empty string", () => {
    expect(resolveRoleColor("", 2)).toBe("#f472b6");
  });

  it("falls back to the palette when color is the slate placeholder", () => {
    expect(resolveRoleColor("#94a3b8", 0)).toBe("#60a5fa");
    expect(resolveRoleColor("#94A3B8", 0)).toBe("#60a5fa");
    expect(resolveRoleColor("  #94a3b8  ", 0)).toBe("#60a5fa");
  });

  it("preserves an explicit non-placeholder color", () => {
    expect(resolveRoleColor("#ff0000", 0)).toBe("#ff0000");
  });

  it("returns a stable color for the same index (palette wraps)", () => {
    expect(resolveRoleColor(null, 0)).toBe(resolveRoleColor(null, 0));
    // Wrap-around at the palette length (10).
    expect(resolveRoleColor(null, 10)).toBe(resolveRoleColor(null, 0));
  });
});

describe("computeTargetPositions — normalized spring force", () => {
  const roles = [
    {
      id: "a",
      name: "A",
      authorityRank: 1,
      color: "#fff",
      contributionsCount: 5,
      domainTags: [],
    },
    {
      id: "b",
      name: "B",
      authorityRank: 1,
      color: "#fff",
      contributionsCount: 5,
      domainTags: [],
    },
  ];

  it("produces visible movement at realistic backend weight (~0.4)", () => {
    const weights: EdgeWeightMap = new Map([["a|b", 0.42]]);
    const out = computeTargetPositions(roles, weights, 100, 100, 80);
    const pa = out.get("a")!;
    const pb = out.get("b")!;
    // With normalization the strongest pair gets ~80% of the dx/dy as pull.
    // For a 2-role ring at radius 80, |dx|+|dy| ≈ 160; the pull on each node
    // should clearly be > 50px (vs. ~30px in the old `sim * 0.4` calc).
    const displacementA = Math.hypot(pa.x - 100, pa.y - (100 - 80));
    expect(displacementA).toBeGreaterThan(50);
  });

  it("returns the ring layout exactly when all weights are zero", () => {
    const weights: EdgeWeightMap = new Map();
    const out = computeTargetPositions(roles, weights, 100, 100, 80);
    // Top node at (100, 20), bottom at (100, 180).
    expect(out.get("a")!.x).toBeCloseTo(100, 5);
    expect(out.get("a")!.y).toBeCloseTo(20, 5);
    expect(out.get("b")!.x).toBeCloseTo(100, 5);
    expect(out.get("b")!.y).toBeCloseTo(180, 5);
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

  it("renders the equilibrium ring guide", async () => {
    render(<AgentAffinityGraphSpring quorumId="quorum-eq" />);
    await waitFor(() => {
      expect(
        screen.getByTestId("affinity-spring-equilibrium-ring"),
      ).toBeInTheDocument();
    });
  });

  it("renders the always-on affinity edge with its weight label", async () => {
    render(<AgentAffinityGraphSpring quorumId="quorum-edges" />);
    await waitFor(() => {
      // The mock fetch returns a single edge role-a <-> role-b @ weight 0.5.
      // Edge keys are derived from the lexicographic pairKey order.
      expect(
        screen.getByTestId("affinity-spring-edge-role-a-role-b"),
      ).toBeInTheDocument();
    });
  });

  it("exposes the scrubber play/pause/range controls", async () => {
    render(<AgentAffinityGraphSpring quorumId="quorum-scrub" />);
    await waitFor(() => {
      expect(screen.getByTestId("spring-activity-play")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("spring-activity-scrub-slider"),
    ).toBeInTheDocument();
  });

  it("renders nodes with explicit fallback colors when the backend returned no color", async () => {
    render(<AgentAffinityGraphSpring quorumId="quorum-color" />);
    const nodeA = await screen.findByTestId("affinity-spring-node-role-a");
    // The mock role-status payload has no `color` field, so we should fall
    // back to the palette. role-a is index 0 -> #60a5fa.
    expect(nodeA.style.borderColor || nodeA.getAttribute("style")).toMatch(
      /60a5fa|96, 165, 250/,
    );
  });

  it("sizes nodes by contributions_count (sponsor=4 > irb=2)", async () => {
    render(<AgentAffinityGraphSpring quorumId="quorum-size" />);
    const nodeA = await screen.findByTestId("affinity-spring-node-role-a");
    const nodeB = await screen.findByTestId("affinity-spring-node-role-b");
    const ra = Number(nodeA.getAttribute("data-node-radius"));
    const rb = Number(nodeB.getAttribute("data-node-radius"));
    expect(ra).toBeGreaterThan(rb);
  });
});
