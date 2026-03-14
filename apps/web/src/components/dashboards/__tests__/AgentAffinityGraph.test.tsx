import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AffinityNode, AffinityEdge } from "@quorum/types/src/dashboard";
import { AgentAffinityGraph } from "../AgentAffinityGraph";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const nodes: AffinityNode[] = [
  {
    id: "role-001",
    label: "IRB Officer",
    activityCount: 5,
    active: false,
    color: "#DC2626",
    tags: ["irb", "consent", "regulatory"],
  },
  {
    id: "role-002",
    label: "Site Coordinator",
    activityCount: 12,
    active: true,
    color: "#059669",
    tags: ["enrollment", "timeline", "site_management"],
  },
  {
    id: "role-003",
    label: "Sponsor",
    activityCount: 3,
    active: false,
    color: "#2563EB",
    tags: ["budget", "timeline", "sponsor"],
  },
];

const edges: AffinityEdge[] = [
  {
    source: "role-001",
    target: "role-002",
    weight: 0.35,
    interactionType: "requesting",
  },
  {
    source: "role-002",
    target: "role-003",
    weight: 0.6,
    interactionType: "collaborative",
  },
  {
    source: "role-001",
    target: "role-003",
    // weight=0.05: below the 0.1 minimum threshold — should not render
    weight: 0.05,
    interactionType: "none",
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentAffinityGraph", () => {
  it("shows empty state when no nodes", () => {
    render(<AgentAffinityGraph nodes={[]} edges={[]} />);
    expect(screen.getByTestId("agent-affinity-graph-empty")).toBeTruthy();
  });

  it("renders the graph container when nodes are present", () => {
    render(<AgentAffinityGraph nodes={nodes} edges={edges} />);
    expect(screen.getByTestId("agent-affinity-graph")).toBeTruthy();
  });

  it("renders an SVG canvas", () => {
    const { container } = render(
      <AgentAffinityGraph nodes={nodes} edges={edges} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("renders a node label for each agent", () => {
    render(<AgentAffinityGraph nodes={nodes} edges={edges} />);
    // "IRB Officer" (11 chars, <= 14) renders as-is
    expect(screen.getByText("IRB Officer")).toBeTruthy();
    // "Site Coordinator" (16 chars, > 14) is truncated: slice(0,13) + "…"
    // = "Site Coordina" + "…" = "Site Coordina…"
    expect(screen.getByText("Site Coordina\u2026")).toBeTruthy();
    // "Sponsor" (7 chars) renders as-is
    expect(screen.getByText("Sponsor")).toBeTruthy();
  });

  it("shows activity count inside node when > 0", () => {
    render(<AgentAffinityGraph nodes={nodes} edges={edges} />);
    // activityCount of 5 and 12 should appear as text inside SVG
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("renders SVG lines for edges with weight >= 0.1", () => {
    const { container } = render(
      <AgentAffinityGraph nodes={nodes} edges={edges} />,
    );
    const lines = container.querySelectorAll("line");
    // Edge with weight=0.05 (role-001 → role-003) is below 0.1 threshold — not rendered
    // Two edges should render (0.35 and 0.6)
    expect(lines.length).toBe(2);
  });

  it("does not render edges with weight < 0.1", () => {
    const lowWeightEdges: AffinityEdge[] = [
      { source: "role-001", target: "role-002", weight: 0.05, interactionType: "none" },
    ];
    const { container } = render(
      <AgentAffinityGraph nodes={nodes} edges={lowWeightEdges} />,
    );
    const lines = container.querySelectorAll("line");
    expect(lines.length).toBe(0);
  });

  it("truncates long node labels to 14 chars with ellipsis", () => {
    const longNameNodes: AffinityNode[] = [
      {
        id: "role-long",
        label: "Patient Advocate Representative",
        activityCount: 1,
        active: false,
        color: "#D97706",
        tags: [],
      },
    ];
    render(<AgentAffinityGraph nodes={longNameNodes} edges={[]} />);
    // Truncated to 13 chars + ellipsis (slice(0,13) + "\u2026")
    expect(screen.getByText("Patient Advoc\u2026")).toBeTruthy();
  });

  it("renders the legend with interaction type labels", () => {
    render(<AgentAffinityGraph nodes={nodes} edges={edges} />);
    expect(screen.getByText("collaborative")).toBeTruthy();
    expect(screen.getByText("conflicting")).toBeTruthy();
    expect(screen.getByText("requesting")).toBeTruthy();
  });

  it("renders the static layout placeholder notice", () => {
    render(<AgentAffinityGraph nodes={nodes} edges={edges} />);
    expect(
      screen.getByText(/static layout/i),
    ).toBeTruthy();
  });

  it("respects custom width and height viewBox", () => {
    const { container } = render(
      <AgentAffinityGraph
        nodes={nodes}
        edges={edges}
        width={800}
        height={600}
      />,
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 800 600");
  });
});
