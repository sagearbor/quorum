import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  DecisionWaterfall,
  type RoleLike,
  type ContributionLike,
  type AgentRequestLike,
} from "../DecisionWaterfall";

// ---------------------------------------------------------------------------
// Fixtures — a 3-tier hierarchy mirroring the IRB → PI → Coordinator chain
// that a Duke clinical audience would recognise.
// ---------------------------------------------------------------------------

const roles: RoleLike[] = [
  // Intentionally provided in a *non* rank-sorted order so we can verify the
  // component re-sorts by authority_rank descending.
  {
    id: "role-coord",
    name: "Site Coordinator",
    authority_rank: 1,
    color: "#34d399",
  },
  {
    id: "role-irb",
    name: "IRB Officer",
    authority_rank: 5,
    color: "#f87171",
  },
  {
    id: "role-pi",
    name: "Principal Investigator",
    authority_rank: 3,
    color: "#60a5fa",
  },
];

const baseTime = new Date("2026-05-19T15:00:00Z").getTime();

const contributions: ContributionLike[] = [
  {
    id: "c1",
    role_id: "role-irb",
    content: "IRB endorses the protocol amendment with minor revisions.",
    created_at: new Date(baseTime).toISOString(),
  },
  {
    id: "c2",
    role_id: "role-pi",
    content: "PI agrees with the IRB and will implement the revisions.",
    created_at: new Date(baseTime + 2 * 60_000).toISOString(),
  },
  {
    id: "c3",
    role_id: "role-coord",
    content: "Site coordinator concerns about timeline for consent re-signing.",
    created_at: new Date(baseTime + 4 * 60_000).toISOString(),
  },
];

const agentRequests: AgentRequestLike[] = [
  {
    id: "req-1",
    from_role_id: "role-irb",
    to_role_id: "role-pi",
    created_at: new Date(baseTime + 1 * 60_000).toISOString(),
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DecisionWaterfall", () => {
  it("renders without error when data is provided", () => {
    render(
      <DecisionWaterfall
        quorumId="q-1"
        nowMs={baseTime + 10 * 60_000}
        staticData={{ roles, contributions, agentRequests, resolvedSectionCount: 0 }}
      />,
    );
    expect(screen.getByTestId("decision-waterfall")).toBeTruthy();
  });

  it("renders the empty state when no roles are present", () => {
    render(
      <DecisionWaterfall
        quorumId="q-empty"
        staticData={{ roles: [], contributions: [], agentRequests: [] }}
      />,
    );
    expect(screen.getByTestId("decision-waterfall-empty")).toBeTruthy();
    expect(
      screen.getByText(
        /Waterfall fills as decisions cascade through authority tiers/i,
      ),
    ).toBeTruthy();
  });

  it("sorts lanes top-to-bottom by authority_rank descending", () => {
    const { container } = render(
      <DecisionWaterfall
        quorumId="q-1"
        nowMs={baseTime + 10 * 60_000}
        staticData={{ roles, contributions, agentRequests, resolvedSectionCount: 0 }}
      />,
    );
    // Read the rendered lane <g> elements (data-testid="waterfall-lane-<id>")
    // back in DOM order, which is render order, which is the sorted order.
    const laneNodes = container.querySelectorAll('[data-testid^="waterfall-lane-"]');
    const orderedIds = Array.from(laneNodes).map((n) =>
      n.getAttribute("data-testid")?.replace("waterfall-lane-", ""),
    );
    // Expected sort by authority_rank desc: IRB (5) → PI (3) → Coord (1).
    expect(orderedIds).toEqual(["role-irb", "role-pi", "role-coord"]);
  });

  it("draws one chip per matched contribution", () => {
    const { container } = render(
      <DecisionWaterfall
        quorumId="q-1"
        nowMs={baseTime + 10 * 60_000}
        staticData={{ roles, contributions, agentRequests, resolvedSectionCount: 0 }}
      />,
    );
    const chips = container.querySelectorAll('[data-testid^="waterfall-chip-"]');
    expect(chips.length).toBe(3);
  });

  it("renders cascade paths for downward authority engagements", () => {
    const { container } = render(
      <DecisionWaterfall
        quorumId="q-1"
        nowMs={baseTime + 10 * 60_000}
        staticData={{ roles, contributions, agentRequests, resolvedSectionCount: 0 }}
      />,
    );
    const cascades = container.querySelectorAll('[data-testid="waterfall-cascade"]');
    // Three contributions in a strict downward time progression produce 3
    // chip-to-chip cascades (IRB→PI, IRB→Coord, PI→Coord), plus the one
    // agent_request (IRB→PI). That's 4 distinct cascade paths total.
    expect(cascades.length).toBeGreaterThanOrEqual(3);
  });

  it("renders the decision-pending vault region", () => {
    render(
      <DecisionWaterfall
        quorumId="q-1"
        nowMs={baseTime + 10 * 60_000}
        staticData={{ roles, contributions, agentRequests, resolvedSectionCount: 2 }}
      />,
    );
    expect(screen.getByTestId("decision-waterfall-vault")).toBeTruthy();
    // 2 resolved sections should yield 2 vault chips.
    const vaultChips = document.querySelectorAll(
      '[data-testid="waterfall-vault-chip"]',
    );
    expect(vaultChips.length).toBe(2);
    expect(screen.getByText("2 resolved")).toBeTruthy();
  });

  it("shows the sparse-state hint when there are roles but no contributions", () => {
    render(
      <DecisionWaterfall
        quorumId="q-sparse"
        nowMs={baseTime}
        staticData={{ roles, contributions: [], agentRequests: [] }}
      />,
    );
    expect(screen.getByTestId("decision-waterfall-sparse")).toBeTruthy();
  });
});
