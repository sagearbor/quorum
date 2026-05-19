import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { RoleCoverageMap } from "../RoleCoverageMap";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/dataProvider", () => ({
  getRoles: vi.fn(async () => []),
  getContributions: vi.fn(async () => []),
  subscribeToContributions: vi.fn(() => () => {}),
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RoleCoverageMap", () => {
  it("renders the grid with the union of role prompt_template fields", async () => {
    render(
      <RoleCoverageMap
        quorumId="q-test"
        staticRoles={[
          {
            id: "role-irb",
            name: "IRB Officer",
            authority_rank: 3,
            color: "#f59e0b",
            prompt_template: [
              { field_name: "risks" },
              { field_name: "safeguards" },
            ],
          },
          {
            id: "role-stat",
            name: "Biostatistician",
            authority_rank: 2,
            color: "#10b981",
            prompt_template: [
              { field_name: "risks" },
              { field_name: "recommendation" },
            ],
          },
        ]}
        staticContributions={[
          {
            id: "c1",
            role_id: "role-irb",
            structured_fields: {
              risks: "Short note about IRB-side enrollment risks.",
            },
          },
          {
            id: "c2",
            role_id: "role-stat",
            structured_fields: {
              recommendation:
                "Recommend a 12-week interim analysis with a one-sided alpha of 0.025 to retain statistical power even after a reduction in projected enrollment due to site-level dropouts identified during the IRB review window.",
            },
          },
        ]}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Root container present.
    expect(screen.getByTestId("role-coverage-map")).toBeTruthy();

    // Cells from the union of (risks, safeguards, recommendation) × roles.
    expect(screen.getByTestId("cell-role-irb-risks")).toBeTruthy();
    expect(screen.getByTestId("cell-role-irb-safeguards")).toBeTruthy();
    expect(screen.getByTestId("cell-role-irb-recommendation")).toBeTruthy();
    expect(screen.getByTestId("cell-role-stat-risks")).toBeTruthy();
    expect(screen.getByTestId("cell-role-stat-recommendation")).toBeTruthy();

    // Shading levels respect the SUBSTANTIAL_CHARS threshold (100).
    expect(
      screen.getByTestId("cell-role-irb-risks").getAttribute("data-level"),
    ).toBe("some");
    expect(
      screen
        .getByTestId("cell-role-stat-recommendation")
        .getAttribute("data-level"),
    ).toBe("substantial");
    expect(
      screen.getByTestId("cell-role-irb-safeguards").getAttribute("data-level"),
    ).toBe("empty");
  });

  it("shows the empty state when no roles have prompt_template fields", async () => {
    render(
      <RoleCoverageMap
        quorumId="q-empty"
        staticRoles={[]}
        staticContributions={[]}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId("role-coverage-empty")).toBeTruthy();
  });

  it("opens the popover with contribution content on cell click", async () => {
    render(
      <RoleCoverageMap
        quorumId="q-click"
        staticRoles={[
          {
            id: "r1",
            name: "Sponsor",
            authority_rank: 1,
            prompt_template: [{ field_name: "risks" }],
          },
        ]}
        staticContributions={[
          {
            id: "c1",
            role_id: "r1",
            structured_fields: { risks: "Funding shortfall flagged." },
          },
        ]}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const cell = screen.getByTestId("cell-r1-risks");
    fireEvent.click(cell);

    const popover = screen.getByTestId("role-coverage-popover");
    expect(popover).toBeTruthy();
    expect(popover.textContent).toContain("Funding shortfall flagged.");
  });
});
