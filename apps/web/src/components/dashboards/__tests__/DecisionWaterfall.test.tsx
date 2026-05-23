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

  it("labels the vault 'Decision Resolved' when the quorum is resolved", () => {
    render(
      <DecisionWaterfall
        quorumId="q-resolved"
        nowMs={baseTime + 10 * 60_000}
        staticData={{
          roles,
          contributions,
          agentRequests,
          resolvedSectionCount: 1,
          quorumResolved: true,
        }}
      />,
    );
    expect(screen.getByTestId("decision-waterfall-vault-label").textContent).toBe(
      "Decision Resolved",
    );
    expect(screen.getByText("1 resolved")).toBeTruthy();
  });

  it("labels the vault 'Decision Pending' when the quorum is not resolved", () => {
    render(
      <DecisionWaterfall
        quorumId="q-pending"
        nowMs={baseTime + 10 * 60_000}
        staticData={{
          roles,
          contributions,
          agentRequests,
          resolvedSectionCount: 0,
        }}
      />,
    );
    expect(screen.getByTestId("decision-waterfall-vault-label").textContent).toBe(
      "Decision Pending",
    );
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

  // ---------------------------------------------------------------------------
  // Post-2026-05 redesign: x-axis, tier stripes, magnitude chips, empty-lane
  // stripe, tooltip rationale.
  // ---------------------------------------------------------------------------

  it("renders an x-axis with at least 2 HH:MM tick marks", () => {
    const { container } = render(
      <DecisionWaterfall
        quorumId="q-1"
        nowMs={baseTime + 10 * 60_000}
        staticData={{ roles, contributions, agentRequests, resolvedSectionCount: 0 }}
      />,
    );
    const ticks = container.querySelectorAll(
      '[data-testid="waterfall-x-axis-tick"]',
    );
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('[data-testid="waterfall-x-axis"]')).toBeTruthy();
  });

  it("renders a tier stripe for each lane", () => {
    const { container } = render(
      <DecisionWaterfall
        quorumId="q-1"
        nowMs={baseTime + 10 * 60_000}
        staticData={{ roles, contributions, agentRequests, resolvedSectionCount: 0 }}
      />,
    );
    for (const role of roles) {
      expect(
        container.querySelector(`[data-testid="waterfall-tier-stripe-${role.id}"]`),
      ).toBeTruthy();
    }
  });

  it("renders an empty-lane stripe overlay for lanes without chips", () => {
    // Only feed contributions for role-irb so the other two lanes are empty.
    const onlyIrbContribs: ContributionLike[] = [
      {
        id: "x1",
        role_id: "role-irb",
        content: "IRB note.",
        created_at: new Date(baseTime).toISOString(),
      },
    ];
    const { container } = render(
      <DecisionWaterfall
        quorumId="q-2"
        nowMs={baseTime + 10 * 60_000}
        staticData={{
          roles,
          contributions: onlyIrbContribs,
          agentRequests: [],
        }}
      />,
    );
    // role-irb has a chip → should NOT have an empty-lane overlay.
    expect(
      container.querySelector('[data-testid="waterfall-empty-lane-role-irb"]'),
    ).toBeNull();
    // role-pi and role-coord are empty → should have overlays.
    expect(
      container.querySelector('[data-testid="waterfall-empty-lane-role-pi"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="waterfall-empty-lane-role-coord"]'),
    ).toBeTruthy();
  });

  it("encodes |Δ| magnitude as chip radius — loud chip > quiet chip", () => {
    const loudContribs: ContributionLike[] = [
      {
        id: "quiet",
        role_id: "role-irb",
        content: "Tiny update.",
        created_at: new Date(baseTime).toISOString(),
        analysis_deltas: {
          consensus: 1,
          completion: 0,
          blockers: 0,
          critical_path: 0,
          role_coverage: 0,
        },
      },
      {
        id: "loud",
        role_id: "role-pi",
        content: "Major decision.",
        created_at: new Date(baseTime + 2 * 60_000).toISOString(),
        analysis_deltas: {
          consensus: 18,
          completion: 15,
          blockers: 5,
          critical_path: 6,
          role_coverage: 4,
        },
      },
    ];
    const { container } = render(
      <DecisionWaterfall
        quorumId="q-mag"
        nowMs={baseTime + 10 * 60_000}
        staticData={{ roles, contributions: loudContribs, agentRequests: [] }}
      />,
    );
    const quiet = container
      .querySelector('[data-testid="waterfall-chip-quiet"] circle')
      ?.getAttribute("r");
    const loud = container
      .querySelector('[data-testid="waterfall-chip-loud"] circle')
      ?.getAttribute("r");
    expect(quiet).toBeTruthy();
    expect(loud).toBeTruthy();
    expect(parseFloat(loud!)).toBeGreaterThan(parseFloat(quiet!));
  });

  it("surfaces the LLM rationale snippet in the chip tooltip", () => {
    const rationale = "Outlines a concrete, auditable requirements catalog and data readiness plan.";
    const contribsWithRationale: ContributionLike[] = [
      {
        id: "c-rat",
        role_id: "role-irb",
        content: "Some chip content.",
        created_at: new Date(baseTime).toISOString(),
        analysis_rationale: rationale,
        analysis_deltas: { consensus: 5, completion: 3, blockers: 0, critical_path: 0, role_coverage: 0 },
      },
    ];
    const { container } = render(
      <DecisionWaterfall
        quorumId="q-rat"
        nowMs={baseTime + 10 * 60_000}
        staticData={{ roles, contributions: contribsWithRationale, agentRequests: [] }}
      />,
    );
    const title = container
      .querySelector('[data-testid="waterfall-chip-c-rat"] title')
      ?.textContent;
    expect(title).toBeTruthy();
    expect(title).toContain("IRB Officer");
    expect(title).toContain("|Δ|");
    expect(title).toContain(rationale);
  });

  it("jitters within-lane chips that share the same second off the midline", () => {
    const sameSecondContribs: ContributionLike[] = [
      {
        id: "tw-a",
        role_id: "role-irb",
        content: "A",
        created_at: new Date(baseTime).toISOString(),
      },
      {
        id: "tw-b",
        role_id: "role-irb",
        content: "B",
        created_at: new Date(baseTime).toISOString(),
      },
      // A third role-irb chip in a *different* second — should stay on the midline.
      {
        id: "solo",
        role_id: "role-irb",
        content: "C",
        created_at: new Date(baseTime + 30_000).toISOString(),
      },
    ];
    const { container } = render(
      <DecisionWaterfall
        quorumId="q-jitter"
        nowMs={baseTime + 10 * 60_000}
        laneHeight={56}
        staticData={{ roles, contributions: sameSecondContribs, agentRequests: [] }}
      />,
    );
    const cyA = parseFloat(
      container
        .querySelector('[data-testid="waterfall-chip-tw-a"] circle')!
        .getAttribute("cy")!,
    );
    const cyB = parseFloat(
      container
        .querySelector('[data-testid="waterfall-chip-tw-b"] circle')!
        .getAttribute("cy")!,
    );
    const cySolo = parseFloat(
      container
        .querySelector('[data-testid="waterfall-chip-solo"] circle')!
        .getAttribute("cy")!,
    );
    expect(cyA).not.toBe(cyB);
    // The solo (different-second) chip sits on the lane midline; that midline
    // should be the midpoint between the two jittered chips.
    expect(Math.abs((cyA + cyB) / 2 - cySolo)).toBeLessThan(0.01);
  });
});
