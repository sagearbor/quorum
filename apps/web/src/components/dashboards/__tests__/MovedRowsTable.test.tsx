import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  MovedRowsTable,
  type BeforeAfterPayload,
} from "../MovedRowsTable";

// ---------------------------------------------------------------------------
// Fixtures — a clinical-trial style snapshot mirroring the spec example.
// ---------------------------------------------------------------------------

const contributions = [
  { id: "c1", role_id: "role-irb" },
  { id: "c2", role_id: "role-pi" },
];

const roles = [
  { id: "role-irb", name: "IRB Officer", color: "#f87171" },
  { id: "role-pi", name: "Principal Investigator", color: "#60a5fa" },
];

const payload: BeforeAfterPayload = {
  has_initial: true,
  has_final: true,
  initial: {
    summary_sentences: ["", "", ""],
    headline: "Annual training for all faculty",
    key_aspects: [],
    unresolved: [],
  },
  final: {
    summary_sentences: ["", "", ""],
    headline: "Risk-tiered training",
    key_aspects: [
      {
        field: "scope",
        before: "All faculty + clinicians",
        after: "High-risk tool users only",
        changed: true,
        drivers: ["c1"],
      },
      {
        field: "cadence",
        before: "Annual",
        after: "Annual + recertification window every 6 months",
        changed: true,
        drivers: ["c2"],
      },
      {
        field: "owner",
        before: "Office of Clinical Education",
        after: "Office of Clinical Education",
        changed: false,
        drivers: [],
      },
      {
        field: "budget_cap",
        before: "$50k",
        after: "$50k",
        changed: false,
        drivers: [],
      },
    ],
    unresolved: [],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MovedRowsTable", () => {
  it("renders without error when a final snapshot is provided", () => {
    render(
      <MovedRowsTable
        quorumId="q-1"
        staticData={{ payload, contributions, roles }}
      />,
    );
    expect(screen.getByTestId("moved-rows-table")).toBeTruthy();
    // Moved rows visible by aspect name.
    expect(screen.getByTestId("moved-row-scope")).toBeTruthy();
    expect(screen.getByTestId("moved-row-cadence")).toBeTruthy();
    // Driver pills rendered.
    expect(screen.getByTestId("moved-row-scope-drivers")).toBeTruthy();
  });

  it("collapses unchanged rows by default", () => {
    render(
      <MovedRowsTable
        quorumId="q-1"
        staticData={{ payload, contributions, roles }}
      />,
    );
    // The collapse toggle is present...
    expect(screen.getByTestId("moved-rows-held-toggle")).toBeTruthy();
    // ...but the individual held rows are not rendered until expansion.
    expect(screen.queryByTestId("held-row-owner")).toBeNull();
    expect(screen.queryByTestId("held-row-budget_cap")).toBeNull();
  });

  it("shows the empty state when no final snapshot is available", () => {
    render(
      <MovedRowsTable
        quorumId="q-1"
        staticData={{
          payload: { initial: null, final: null, has_initial: false, has_final: false },
        }}
      />,
    );
    expect(screen.getByTestId("moved-rows-empty")).toBeTruthy();
    expect(
      screen.getByText(/No resolution yet — the quorum is still deliberating/i),
    ).toBeTruthy();
  });
});
