import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/mocks/server";
import ArchitectPage from "../page";
import { useArchitectStore } from "@/store/architect";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/architect",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("AI Architect Panel", () => {
  beforeEach(() => {
    useArchitectStore.setState({
      step: 2,
      eventDraft: { name: "Test", slug: "test", access_code: "TEST", max_active_quorums: 5 },
      eventId: "evt-001",
      quorumDraft: {
        title: "",
        description: "",
        roles: [],
        dashboard_types: [],
        carousel_mode: "multi-view",
      },
      createdQuorums: [],
      aiMode: false,
      problemDescription: "",
      generatedRoles: [],
    });
  });

  it("renders Manual Setup and AI Architect tabs on step 2", () => {
    render(<ArchitectPage />);
    expect(screen.getByText("Manual Setup")).toBeInTheDocument();
    expect(screen.getByText("AI Architect")).toBeInTheDocument();
  });

  it("switches to AI Architect panel when tab is clicked", async () => {
    const user = userEvent.setup();
    render(<ArchitectPage />);

    await user.click(screen.getByText("AI Architect"));

    expect(screen.getByLabelText(/problem description/i)).toBeInTheDocument();
    expect(screen.getByText(/auto-start/i)).toBeInTheDocument();
    expect(screen.getByText(/review roles before starting/i)).toBeInTheDocument();
  });

  it("generates roles when Generate button is clicked", async () => {
    const user = userEvent.setup();
    useArchitectStore.setState({ aiMode: true });
    render(<ArchitectPage />);

    const textarea = screen.getByPlaceholderText(/describe the problem/i);
    await user.type(textarea, "How should we allocate research funding?");
    await user.click(screen.getByRole("button", { name: /generate roles/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Researcher")).toBeInTheDocument();
    });

    expect(screen.getByDisplayValue("Ethicist")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Administrator")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Patient Advocate")).toBeInTheDocument();
  });

  it("shows Approve & Start button in approved mode", async () => {
    const user = userEvent.setup();
    useArchitectStore.setState({ aiMode: true });
    render(<ArchitectPage />);

    const textarea = screen.getByPlaceholderText(/describe the problem/i);
    await user.type(textarea, "Test problem");
    await user.click(screen.getByRole("button", { name: /generate roles/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /approve & start/i })
      ).toBeInTheDocument();
    });
  });

  it("allows removing a generated role", async () => {
    const user = userEvent.setup();
    useArchitectStore.setState({ aiMode: true });
    render(<ArchitectPage />);

    const textarea = screen.getByPlaceholderText(/describe the problem/i);
    await user.type(textarea, "Test problem");
    await user.click(screen.getByRole("button", { name: /generate roles/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Researcher")).toBeInTheDocument();
    });

    // Remove the first role
    const removeButtons = screen.getAllByLabelText(/remove/i);
    await user.click(removeButtons[0]);

    expect(screen.queryByDisplayValue("Researcher")).not.toBeInTheDocument();
  });

  it("store updates aiMode when tab is toggled", async () => {
    const user = userEvent.setup();
    render(<ArchitectPage />);

    await user.click(screen.getByText("AI Architect"));
    expect(useArchitectStore.getState().aiMode).toBe(true);

    await user.click(screen.getByText("Manual Setup"));
    expect(useArchitectStore.getState().aiMode).toBe(false);
  });
});
