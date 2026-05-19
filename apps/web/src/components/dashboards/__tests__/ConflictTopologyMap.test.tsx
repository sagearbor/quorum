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
        screen.getByText(/No conflicts detected yet/i),
      ).toBeTruthy();
    });
  });
});
