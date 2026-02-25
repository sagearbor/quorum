import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import EventPage from "./page";
import { useQuorumStore } from "@/store/quorumStore";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "duke-expo-2026" }),
  useSearchParams: () => ({
    get: (key: string) => (key === "station" ? "1" : null),
  }),
  useRouter: () => ({ push: mockPush }),
}));

describe("EventPage", () => {
  beforeEach(() => {
    mockPush.mockClear();
    useQuorumStore.setState({
      currentEvent: null,
      quorums: [],
      roles: {},
      stationDefault: null,
    });
  });

  it("renders event name", () => {
    render(<EventPage />);
    expect(
      screen.getByText("Duke Clinical Trial Expo 2026")
    ).toBeInTheDocument();
  });

  it("shows station badge from URL param", () => {
    render(<EventPage />);
    expect(screen.getByText("Station 1")).toBeInTheDocument();
  });

  it("renders all 3 quorum cards", () => {
    render(<EventPage />);
    expect(screen.getByTestId("quorum-card-q-001")).toBeInTheDocument();
    expect(screen.getByTestId("quorum-card-q-002")).toBeInTheDocument();
    expect(screen.getByTestId("quorum-card-q-003")).toBeInTheDocument();
  });

  it("shows role pills on quorum cards", () => {
    render(<EventPage />);
    expect(screen.getByTestId("role-pill-r-001")).toHaveTextContent(
      "IRB Chair"
    );
    expect(screen.getByTestId("role-pill-r-002")).toHaveTextContent(
      "Site PI"
    );
  });

  it("shows participant counts on role pills", () => {
    render(<EventPage />);
    const patientPill = screen.getByTestId("role-pill-r-003");
    expect(patientPill).toHaveTextContent("3");
  });

  it("highlights station default role with ring", () => {
    render(<EventPage />);
    // Station 1 maps to r-001 (IRB Chair)
    const pill = screen.getByTestId("role-pill-r-001");
    expect(pill.className).toContain("ring-2");
  });

  it("navigates to quorum page on card click", () => {
    render(<EventPage />);
    fireEvent.click(screen.getByTestId("quorum-card-q-001"));
    expect(mockPush).toHaveBeenCalledWith(
      "/event/duke-expo-2026/quorum/q-001?station=1"
    );
  });

  it("displays heat scores", () => {
    render(<EventPage />);
    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText("45")).toBeInTheDocument();
    expect(screen.getByText("18")).toBeInTheDocument();
  });

  it("displays quorum count", () => {
    render(<EventPage />);
    expect(screen.getByText("(3)")).toBeInTheDocument();
  });
});
