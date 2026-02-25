import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import QuorumPage from "./page";
import { useQuorumStore } from "@/store/quorumStore";
import { server } from "@/mocks/server";

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "duke-expo-2026", id: "q-001" }),
  useSearchParams: () => ({
    get: (key: string) => (key === "station" ? "1" : null),
  }),
}));

describe("QuorumPage", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  beforeEach(() => {
    useQuorumStore.setState({
      currentQuorum: null,
      currentRole: null,
      roles: {},
      activeRoles: [],
      contributions: [],
      pendingContributions: [],
      healthScore: 0,
      stationDefault: null,
    });
  });

  it("renders quorum title after load", () => {
    render(<QuorumPage />);
    expect(
      screen.getByText("IRB Protocol Review — NCT-2026-4481")
    ).toBeInTheDocument();
  });

  it("renders role selection buttons", () => {
    render(<QuorumPage />);
    expect(screen.getByTestId("role-select-r-001")).toHaveTextContent(
      "IRB Chair"
    );
    expect(screen.getByTestId("role-select-r-002")).toHaveTextContent(
      "Site PI"
    );
    expect(screen.getByTestId("role-select-r-003")).toHaveTextContent(
      "Patient Advocate"
    );
  });

  it("shows participant counts on role buttons", () => {
    render(<QuorumPage />);
    // Patient Advocate has 3 participants
    const button = screen.getByTestId("role-select-r-003");
    expect(button).toHaveTextContent("3");
  });

  it("auto-selects station default role", () => {
    render(<QuorumPage />);
    // Station 1 = IRB Chair (r-001), should be auto-selected
    // The form should appear with IRB Chair fields
    expect(
      screen.getByText("Summarize safety concerns with the current protocol")
    ).toBeInTheDocument();
  });

  it("shows station default badge on the default role", () => {
    render(<QuorumPage />);
    const irbButton = screen.getByTestId("role-select-r-001");
    expect(irbButton).toHaveTextContent("Station default");
  });

  it("shows contribution form when role is selected", () => {
    render(<QuorumPage />);
    // Click Patient Advocate
    fireEvent.click(screen.getByTestId("role-select-r-003"));
    expect(screen.getByTestId("contribution-form")).toBeInTheDocument();
    expect(
      screen.getByText("What are the key patient concerns?")
    ).toBeInTheDocument();
  });

  it("submit button is disabled when fields are empty", () => {
    render(<QuorumPage />);
    const submitBtn = screen.getByTestId("submit-contribution");
    expect(submitBtn).toBeDisabled();
  });

  it("submits contribution and shows success", async () => {
    render(<QuorumPage />);
    // IRB Chair is auto-selected, fill in field
    const textarea = screen.getByTestId("field-safety_assessment");
    fireEvent.change(textarea, {
      target: { value: "No major safety concerns identified" },
    });

    const submitBtn = screen.getByTestId("submit-contribution");
    expect(submitBtn).not.toBeDisabled();
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByTestId("submit-success")).toBeInTheDocument();
    });
  });

  it("shows voice button", () => {
    render(<QuorumPage />);
    expect(screen.getByTestId("voice-button")).toBeInTheDocument();
    expect(screen.getByTestId("voice-button")).toHaveTextContent("Voice");
  });

  it("shows existing contributions", () => {
    render(<QuorumPage />);
    // mockContributions has 2 contributions for q-001
    expect(screen.getByTestId("contribution-c-001")).toBeInTheDocument();
    expect(screen.getByTestId("contribution-c-002")).toBeInTheDocument();
  });

  it("switches roles when clicking a different role", () => {
    render(<QuorumPage />);
    // Click Site PI
    fireEvent.click(screen.getByTestId("role-select-r-002"));

    expect(
      screen.getByText("Describe site readiness for enrollment")
    ).toBeInTheDocument();

    // Verify store updated
    expect(useQuorumStore.getState().currentRole?.name).toBe("Site PI");
  });
});
