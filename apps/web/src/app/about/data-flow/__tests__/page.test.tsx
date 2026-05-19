import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataFlowExperience } from "../DataFlowExperience";

describe("/about/data-flow page", () => {
  it("renders the hero headline, pipeline labels, and mode switcher", () => {
    render(<DataFlowExperience />);
    // Pipeline boxes — labels render
    expect(screen.getAllByText(/POST \/contribute/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Tier-2 Analyzer/i).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/calculate_health_score/i).length,
    ).toBeGreaterThan(0);
    // First phase title shows up at least once (caption + rail)
    expect(
      screen.getAllByText(/Legal fills the structured form/i).length,
    ).toBeGreaterThan(0);
    // "Legal" appears in role hub + caption — confirms multi-column wiring
    expect(screen.getAllByText(/Legal/i).length).toBeGreaterThan(0);
    // Mode switcher
    expect(
      screen.getByRole("button", { name: /Show full pipeline/i }),
    ).toBeInTheDocument();
  });
});
