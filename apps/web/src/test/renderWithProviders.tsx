import React from "react";
import { render, type RenderOptions } from "@testing-library/react";

// Mock next/navigation module for testing
export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">
) {
  return render(ui, { ...options });
}
