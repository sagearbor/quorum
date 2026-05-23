import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock the dataProvider before importing the component so the module-level
// import inside ConflictTopologyMap resolves cleanly.
// ---------------------------------------------------------------------------

const mockRoles = [
  { id: "role-a", name: "IRB Officer", color: "#DC2626", authority_rank: 4 },
  { id: "role-b", name: "Site Coordinator", color: "#059669", authority_rank: 3 },
  { id: "role-c", name: "Sponsor", color: "#2563EB", authority_rank: 5 },
];

const mockContributions = [
  {
    id: "c1",
    role_id: "role-a",
    content: "Consent language needs simplification.",
    structured_fields: { patient_consent: "stricter language required" },
    analysis_tags: ["consent", "regulatory"],
    analysis_deltas: { consensus: -0.1 },
    created_at: "2026-05-19T10:00:00Z",
  },
  {
    id: "c2",
    role_id: "role-b",
    content: "Current consent works fine — please don't slow enrollment.",
    structured_fields: { patient_consent: "current consent is fine" },
    analysis_tags: ["consent", "enrollment"],
    analysis_deltas: { consensus: 0.15 },
    created_at: "2026-05-19T10:05:00Z",
  },
  {
    id: "c3",
    role_id: "role-c",
    content: "Budget is tight, prefer to keep existing consent.",
    structured_fields: { budget: "tight" },
    analysis_tags: ["budget"],
    analysis_deltas: {},
    created_at: "2026-05-19T10:06:00Z",
  },
];

vi.mock("@/lib/dataProvider", () => {
  return {
    getRoles: vi.fn(async () => mockRoles),
    getContributions: vi.fn(async () => mockContributions),
    subscribeToContributions: vi.fn(() => () => {}),
  };
});

// Import AFTER the mock so the component picks up the mocked dataProvider.
import {
  ConflictTopologyMap,
  detectConflictEdges,
  nodeRadiusForCount,
  strokeWidthForAuthority,
} from "../ConflictTopologyMap";

beforeEach(() => {
  // Reset hooks/state between tests
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe("detectConflictEdges", () => {
  it("returns empty when fewer than 2 roles", () => {
    expect(
      detectConflictEdges([mockRoles[0]], mockContributions),
    ).toEqual([]);
  });

  it("returns empty when contributions don't overlap", () => {
    const edges = detectConflictEdges(mockRoles, [
      {
        id: "x",
        role_id: "role-a",
        structured_fields: { only_a: "x" },
        analysis_deltas: {},
      },
      {
        id: "y",
        role_id: "role-b",
        structured_fields: { only_b: "y" },
        analysis_deltas: {},
      },
    ]);
    expect(edges).toEqual([]);
  });

  it("detects an edge when two roles share a structured field", () => {
    const edges = detectConflictEdges(mockRoles, mockContributions);
    const ab = edges.find(
      (e) =>
        (e.source === "role-a" && e.target === "role-b") ||
        (e.source === "role-b" && e.target === "role-a"),
    );
    expect(ab).toBeDefined();
    expect(ab!.count).toBeGreaterThanOrEqual(1);
    // active=true because the analysis_deltas on `consensus` are opposing.
    expect(ab!.active).toBe(true);
    // The shared structured_field shows up in evidence
    const fields = ab!.evidence.map((e) => e.field);
    expect(fields).toContain("patient_consent");
  });

  it("does not draw an edge for roles with no overlap (role-c vs role-b)", () => {
    const edges = detectConflictEdges(mockRoles, mockContributions);
    const cb = edges.find(
      (e) =>
        (e.source === "role-c" && e.target === "role-b") ||
        (e.source === "role-b" && e.target === "role-c"),
    );
    expect(cb).toBeUndefined();
  });

  it("filters opposing analysis_deltas below the magnitude threshold", () => {
    // Both sides have opposite-sign deltas but the absolute values are tiny.
    // With threshold=5 there should be no delta-driven evidence.
    const roles: { id: string; name: string }[] = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    const contributions = [
      { id: "1", role_id: "a", structured_fields: {}, analysis_deltas: { consensus: 0.5 } },
      { id: "2", role_id: "b", structured_fields: {}, analysis_deltas: { consensus: -0.5 } },
    ];
    const noisy = detectConflictEdges(roles, contributions);
    expect(noisy.length).toBe(1);
    expect(noisy[0].active).toBe(true);
    const filtered = detectConflictEdges(roles, contributions, {
      deltaMagnitudeThreshold: 5,
    });
    expect(filtered).toEqual([]);
  });

  it("captures raw cumulative sums on delta-driven evidence", () => {
    const roles = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    const contributions = [
      { id: "1", role_id: "a", structured_fields: {}, analysis_deltas: { consensus: 12 } },
      { id: "2", role_id: "b", structured_fields: {}, analysis_deltas: { consensus: -3 } },
    ];
    const edges = detectConflictEdges(roles, contributions);
    expect(edges.length).toBe(1);
    const ev = edges[0].evidence.find((e) => e.metric === "consensus");
    expect(ev).toBeDefined();
    expect(ev!.sumA).toBe(12);
    expect(ev!.sumB).toBe(-3);
  });
});

describe("nodeRadiusForCount", () => {
  it("returns a mid-size value when all roles tie", () => {
    expect(nodeRadiusForCount(5, 5, 5)).toBe(24);
  });

  it("scales linearly between 14 and 34", () => {
    expect(nodeRadiusForCount(0, 0, 10)).toBe(14);
    expect(nodeRadiusForCount(10, 0, 10)).toBe(34);
    expect(nodeRadiusForCount(5, 0, 10)).toBe(24);
  });

  it("clamps to range when count is out of bounds", () => {
    expect(nodeRadiusForCount(-1, 0, 10)).toBe(14);
    expect(nodeRadiusForCount(99, 0, 10)).toBe(34);
  });
});

describe("strokeWidthForAuthority", () => {
  it("maps authority rank to outline thickness", () => {
    expect(strokeWidthForAuthority(undefined)).toBe(1);
    expect(strokeWidthForAuthority(0)).toBe(1);
    expect(strokeWidthForAuthority(1)).toBe(1);
    expect(strokeWidthForAuthority(2)).toBe(2);
    expect(strokeWidthForAuthority(3)).toBe(2);
    expect(strokeWidthForAuthority(4)).toBe(3);
    expect(strokeWidthForAuthority(99)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Component tests
// ---------------------------------------------------------------------------

describe("ConflictTopologyMap", () => {
  it("renders without error", async () => {
    render(<ConflictTopologyMap quorumId="q-1" />);
    expect(screen.getByTestId("conflict-topology-map")).toBeTruthy();
  });

  it("renders the SVG once roles load", async () => {
    render(<ConflictTopologyMap quorumId="q-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("conflict-topology-svg")).toBeTruthy();
    });
  });

  it("renders a node for each role and an edge for the conflicting pair", async () => {
    const { container } = render(<ConflictTopologyMap quorumId="q-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("conflict-node-role-a")).toBeTruthy();
      expect(screen.getByTestId("conflict-node-role-b")).toBeTruthy();
      expect(screen.getByTestId("conflict-node-role-c")).toBeTruthy();
    });

    // Edge between role-a and role-b should render (they share patient_consent
    // + have opposing analysis_deltas on consensus).
    await waitFor(() => {
      const edge =
        container.querySelector(
          '[data-testid="conflict-edge-role-a-role-b"]',
        ) ||
        container.querySelector(
          '[data-testid="conflict-edge-role-b-role-a"]',
        );
      expect(edge).not.toBeNull();
    });

    // No edge between role-a and role-c (no field overlap, no opposing deltas)
    expect(
      container.querySelector('[data-testid="conflict-edge-role-a-role-c"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="conflict-edge-role-c-role-a"]'),
    ).toBeNull();
  });

  it("opens a detail popover when an edge is clicked", async () => {
    const { container } = render(<ConflictTopologyMap quorumId="q-1" />);

    const hit = await waitFor(() => {
      const el =
        container.querySelector(
          '[data-testid="conflict-edge-hit-role-a-role-b"]',
        ) ||
        container.querySelector(
          '[data-testid="conflict-edge-hit-role-b-role-a"]',
        );
      expect(el).not.toBeNull();
      return el as Element;
    });

    fireEvent.click(hit);
    expect(screen.getByTestId("conflict-detail-popover")).toBeTruthy();
  });

  it("shows empty-state copy when there are no roles", async () => {
    const dp = await import("@/lib/dataProvider");
    (dp.getRoles as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (dp.getContributions as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    render(<ConflictTopologyMap quorumId="q-empty" />);
    await waitFor(() => {
      expect(
        screen.getByText(/No roles yet/i),
      ).toBeTruthy();
    });
  });

  it("renders the summary chip with conflict + collaboration counts", async () => {
    render(<ConflictTopologyMap quorumId="q-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("topology-summary-chip")).toBeTruthy();
    });
    // role-a vs role-b is the only conflict in the fixture (shared
    // patient_consent + opposing consensus deltas).
    expect(
      screen.getByTestId("topology-summary-conflicts").textContent,
    ).toMatch(/1\s*conflict/);
    // No /affinity-graph fetch responds in the test env → 0 collaborations.
    expect(
      screen.getByTestId("topology-summary-collaborations").textContent,
    ).toMatch(/0\s*collaboration/);
  });

  it("renders baseline dashed edges for every role-pair", async () => {
    const { container } = render(<ConflictTopologyMap quorumId="q-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("conflict-topology-svg")).toBeTruthy();
    });
    // 3 roles → C(3,2) = 3 baseline edges.
    const baselines = container.querySelectorAll(
      '[data-testid^="baseline-edge-"]',
    );
    expect(baselines.length).toBe(3);
  });

  it("renders a numeric badge on each conflict edge", async () => {
    const { container } = render(<ConflictTopologyMap quorumId="q-1" />);
    await waitFor(() => {
      const badge =
        container.querySelector(
          '[data-testid="conflict-edge-badge-role-a-role-b"]',
        ) ||
        container.querySelector(
          '[data-testid="conflict-edge-badge-role-b-role-a"]',
        );
      expect(badge).not.toBeNull();
    });
  });

  it("encodes contribution count + authority rank on each node", async () => {
    const { container } = render(<ConflictTopologyMap quorumId="q-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("conflict-node-role-a")).toBeTruthy();
    });
    const nodeA = container.querySelector(
      '[data-testid="conflict-node-role-a"]',
    );
    // Falls back to client-side count when /role-status isn't reachable.
    expect(nodeA?.getAttribute("data-contribution-count")).toBe("1");
    expect(nodeA?.getAttribute("data-authority-rank")).toBe("4");
    // Larger contribution count → larger radius. role-a, role-b, role-c
    // each have 1 contribution in the fixture so radii should be equal.
    const radius = parseFloat(nodeA?.getAttribute("data-node-radius") ?? "0");
    expect(radius).toBeGreaterThanOrEqual(14);
    expect(radius).toBeLessThanOrEqual(34);
  });

  it("shows consensus copy when roles contributed but no conflict signals fired", async () => {
    // Two roles, two contributions each, ZERO shared structured_fields and
    // ZERO opposing analysis_deltas — the legitimate "agents agreed" outcome.
    // We assert the empty-state overlay tells the audience this is real
    // consensus, not missing data.
    const dp = await import("@/lib/dataProvider");
    (dp.getRoles as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      mockRoles[0],
      mockRoles[1],
    ]);
    (dp.getContributions as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "a1", role_id: "role-a", structured_fields: {}, analysis_deltas: { consensus: 0.1 } },
      { id: "a2", role_id: "role-a", structured_fields: {}, analysis_deltas: { consensus: 0.1 } },
      { id: "b1", role_id: "role-b", structured_fields: {}, analysis_deltas: { consensus: 0.1 } },
      { id: "b2", role_id: "role-b", structured_fields: {}, analysis_deltas: { consensus: 0.1 } },
    ]);

    render(<ConflictTopologyMap quorumId="q-consensus" />);
    await waitFor(() => {
      expect(
        screen.getByText(/Agents reached consensus/i),
      ).toBeTruthy();
    });
  });
});
