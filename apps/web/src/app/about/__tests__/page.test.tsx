import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AboutExperience } from "../AboutExperience";

describe("/about page", () => {
  it("renders the hero headline and a phase title", () => {
    render(<AboutExperience />);
    // Hero copy
    expect(screen.getByText(/How a room of/i)).toBeInTheDocument();
    // Phase rail renders the first phase title (may appear in caption too)
    expect(
      screen.getAllByText(/An architect names the problem/i).length,
    ).toBeGreaterThan(0);
    // Mode switcher option ("Show full system" is unique)
    expect(
      screen.getByRole("button", { name: /Show full system/i }),
    ).toBeInTheDocument();
  });
});
