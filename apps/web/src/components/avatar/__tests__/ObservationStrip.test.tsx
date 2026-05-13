/**
 * Tests for ObservationStrip (checklist 9.4).
 *
 * Coverage:
 *  - Hidden until the first observation arrives (so empty state takes no space).
 *  - Renders summary + severity label.
 *  - Severity drives the data-severity attribute (so CSS / E2E can target).
 *  - Static-observation prop bypasses the WS subscription.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ObservationStrip } from "../ObservationStrip";

// Mock the dataProvider so the strip never tries to open a WebSocket.
let lastObsHandler:
  | ((frame: {
      summary: string;
      severity: "info" | "notable" | "action_needed";
      referenced_role_ids: string[];
      suggested_tool_calls: string[];
      round?: number | null;
    }) => void)
  | null = null;
const mockUnsubscribe = vi.fn();
vi.mock("@/lib/dataProvider", () => ({
  subscribeToFacilitatorObservations: (
    _quorumId: string,
    handler: (frame: {
      summary: string;
      severity: "info" | "notable" | "action_needed";
      referenced_role_ids: string[];
      suggested_tool_calls: string[];
      round?: number | null;
    }) => void,
  ) => {
    lastObsHandler = handler;
    return mockUnsubscribe;
  },
}));

describe("ObservationStrip", () => {
  it("renders nothing until an observation arrives", () => {
    const { container } = render(<ObservationStrip quorumId="q1" />);
    // No element with data-testid means the component returned null.
    expect(container.querySelector('[data-testid="observation-strip"]'))
      .toBeNull();
  });

  it("renders summary + severity when a static observation is provided", () => {
    render(
      <ObservationStrip
        quorumId="q1"
        staticObservation={{
          summary: "Three roles flagged enrollment risk; IRB silent.",
          severity: "action_needed",
          referenced_role_ids: ["r-pi"],
          suggested_tool_calls: ["raise_question"],
          round: 6,
        }}
      />,
    );
    const strip = screen.getByTestId("observation-strip");
    expect(strip).toBeInTheDocument();
    expect(strip.getAttribute("data-severity")).toBe("action_needed");
    expect(
      screen.getByText(/Three roles flagged enrollment risk/),
    ).toBeInTheDocument();
    // Severity label is rendered ("Action" for action_needed)
    expect(screen.getByText("Action")).toBeInTheDocument();
  });

  it("renders the correct label for each severity level", () => {
    const { rerender } = render(
      <ObservationStrip
        quorumId="q1"
        staticObservation={{
          summary: "Notable convergence on a 2-arm RCT.",
          severity: "notable",
          referenced_role_ids: [],
          suggested_tool_calls: [],
        }}
      />,
    );
    expect(screen.getByText("Notable")).toBeInTheDocument();

    rerender(
      <ObservationStrip
        quorumId="q1"
        staticObservation={{
          summary: "Ambient note.",
          severity: "info",
          referenced_role_ids: [],
          suggested_tool_calls: [],
        }}
      />,
    );
    expect(screen.getByText("Note")).toBeInTheDocument();
  });

  it("does not subscribe to WS when staticObservation is provided", () => {
    lastObsHandler = null;
    render(
      <ObservationStrip
        quorumId="q1"
        staticObservation={{
          summary: "Static path.",
          severity: "info",
          referenced_role_ids: [],
          suggested_tool_calls: [],
        }}
      />,
    );
    // staticObservation short-circuits the useEffect subscription.
    expect(lastObsHandler).toBeNull();
  });
});
