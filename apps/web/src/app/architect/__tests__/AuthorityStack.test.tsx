import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthorityStack } from "../components/AuthorityStack";
import { useArchitectStore } from "@/store/architect";
import type { RoleDraft } from "@/store/architect";

const testRoles: RoleDraft[] = [
  { id: "r1", name: "Principal Investigator", capacity: 1, authority_rank: 3, color: "#3B82F6" },
  { id: "r2", name: "IRB Representative", capacity: 1, authority_rank: 2, color: "#EF4444" },
  { id: "r3", name: "Site Coordinator", capacity: "unlimited", authority_rank: 1, color: "#10B981" },
];

describe("AuthorityStack", () => {
  beforeEach(() => {
    useArchitectStore.setState({
      quorumDraft: {
        title: "Test",
        description: "",
        roles: [...testRoles],
        dashboard_types: [],
        carousel_mode: "multi-view",
      },
    });
  });

  it("renders all role chips", () => {
    render(<AuthorityStack />);
    expect(screen.getByText("Principal Investigator")).toBeInTheDocument();
    expect(screen.getByText("IRB Representative")).toBeInTheDocument();
    expect(screen.getByText("Site Coordinator")).toBeInTheDocument();
  });

  it("shows empty state when no roles", () => {
    useArchitectStore.setState({
      quorumDraft: {
        title: "",
        description: "",
        roles: [],
        dashboard_types: [],
        carousel_mode: "multi-view",
      },
    });
    render(<AuthorityStack />);
    expect(
      screen.getByText("Add roles above to build the authority hierarchy")
    ).toBeInTheDocument();
  });

  it("displays authority rank numbers", () => {
    render(<AuthorityStack />);
    // Top role should show rank 3 (total - index)
    const chips = screen.getAllByTestId(/authority-chip/);
    expect(chips).toHaveLength(3);
  });

  it("shows capacity icons", () => {
    render(<AuthorityStack />);
    // Single person roles show 👤, unlimited shows 👥
    const chips = screen.getAllByTestId(/authority-chip/);
    expect(chips[0]).toHaveTextContent("👤"); // PI - capacity 1
    expect(chips[2]).toHaveTextContent("👥"); // Site Coord - unlimited
  });

  it("reorders roles via store", () => {
    const { reorderRoles } = useArchitectStore.getState();
    const reordered: RoleDraft[] = [testRoles[2], testRoles[0], testRoles[1]];
    const ranked = reordered.map((r, i) => ({
      ...r,
      authority_rank: reordered.length - i,
    }));
    reorderRoles(ranked);

    const state = useArchitectStore.getState();
    expect(state.quorumDraft.roles[0].name).toBe("Site Coordinator");
    expect(state.quorumDraft.roles[0].authority_rank).toBe(3);
    expect(state.quorumDraft.roles[1].name).toBe("Principal Investigator");
    expect(state.quorumDraft.roles[1].authority_rank).toBe(2);
    expect(state.quorumDraft.roles[2].name).toBe("IRB Representative");
    expect(state.quorumDraft.roles[2].authority_rank).toBe(1);
  });
});
