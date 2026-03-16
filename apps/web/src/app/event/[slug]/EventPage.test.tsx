import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import EventPage from "./page";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "duke-expo-2026" }),
  useSearchParams: () => ({
    get: (key: string) => (key === "station" ? "1" : null),
  }),
  useRouter: () => ({ push: mockPush }),
}));

// Mock the dataProvider so getQuorums resolves immediately with fixture data.
// NOTE: vi.mock factory is hoisted to the top of the file, so we cannot
// reference module-level imports here. All data is defined inline.
vi.mock("@/lib/dataProvider", () => {
  const mockQuorumsWithRoles = [
    {
      id: "q-001",
      event_id: "evt-001",
      title: "IRB Protocol Review \u2014 NCT-2026-4481",
      description: "Multi-site phase III trial safety protocol.",
      status: "active",
      heat_score: 72,
      carousel_mode: "multi-view",
      dashboard_types: ["quorum_health_chart"],
      created_at: "2026-02-25T09:05:00Z",
      roles: [
        { id: "r-001", quorum_id: "q-001", name: "IRB Chair", capacity: 1, authority_rank: 3, prompt_template: [], fallback_chain: [], color: "#DC2626" },
        { id: "r-002", quorum_id: "q-001", name: "Site PI", capacity: 1, authority_rank: 2, prompt_template: [], fallback_chain: [], color: "#2563EB" },
        { id: "r-003", quorum_id: "q-001", name: "Patient Advocate", capacity: "unlimited", authority_rank: 1, prompt_template: [], fallback_chain: [], color: "#16A34A" },
      ],
    },
    {
      id: "q-002",
      event_id: "evt-001",
      title: "DSMB Interim Analysis",
      description: "Data Safety Monitoring Board reviews interim results.",
      status: "active",
      heat_score: 45,
      carousel_mode: "multi-view",
      dashboard_types: ["quorum_health_chart"],
      created_at: "2026-02-25T10:00:00Z",
      roles: [],
    },
    {
      id: "q-003",
      event_id: "evt-001",
      title: "Multi-Site Enrollment Strategy",
      description: "Coordinate enrollment targets across 12 sites.",
      status: "open",
      heat_score: 18,
      carousel_mode: "multi-view",
      dashboard_types: ["quorum_health_chart"],
      created_at: "2026-02-25T11:00:00Z",
      roles: [],
    },
  ];

  return {
    isDemoMode: () => false,
    getQuorums: vi.fn().mockResolvedValue(mockQuorumsWithRoles),
  };
});

describe("EventPage", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("renders event slug as page title", async () => {
    render(<EventPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "duke-expo-2026" })
      ).toBeInTheDocument();
    });
  });

  it("shows station badge from URL param", async () => {
    render(<EventPage />);
    await waitFor(() => {
      expect(screen.getByText("Station 1")).toBeInTheDocument();
    });
  });

  it("renders all 3 quorum cards", async () => {
    render(<EventPage />);
    await waitFor(() => {
      expect(screen.getByTestId("quorum-card-q-001")).toBeInTheDocument();
      expect(screen.getByTestId("quorum-card-q-002")).toBeInTheDocument();
      expect(screen.getByTestId("quorum-card-q-003")).toBeInTheDocument();
    });
  });

  it("shows role pills on quorum cards", async () => {
    render(<EventPage />);
    await waitFor(() => {
      expect(screen.getByTestId("role-pill-r-001")).toHaveTextContent(
        "IRB Chair"
      );
      expect(screen.getByTestId("role-pill-r-002")).toHaveTextContent(
        "Site PI"
      );
    });
  });

  it("shows quorum titles on cards", async () => {
    render(<EventPage />);
    await waitFor(() => {
      expect(
        screen.getByText("IRB Protocol Review \u2014 NCT-2026-4481")
      ).toBeInTheDocument();
    });
  });

  it("navigates to quorum page on card click", async () => {
    render(<EventPage />);
    await waitFor(() =>
      expect(screen.getByTestId("quorum-card-link-q-001")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId("quorum-card-link-q-001"));
    expect(mockPush).toHaveBeenCalledWith(
      "/event/duke-expo-2026/quorum/q-001?station=1"
    );
  });

  it("displays heat scores with flame icon", async () => {
    render(<EventPage />);
    await waitFor(() => {
      expect(screen.getByText("72")).toBeInTheDocument();
      expect(screen.getByText("45")).toBeInTheDocument();
      expect(screen.getByText("18")).toBeInTheDocument();
    });
    // Heat badges should have tooltip
    const badges = screen.getAllByTestId("heat-badge");
    expect(badges.length).toBeGreaterThanOrEqual(3);
    expect(badges[0]).toHaveAttribute("title", expect.stringContaining("Heat Score"));
  });

  it("displays quorum count in header", async () => {
    render(<EventPage />);
    // The page renders "{n} quorums" (or "{n} quorum") after load
    await waitFor(() => {
      expect(screen.getByText(/3 quorums/)).toBeInTheDocument();
    });
  });

  it("shows View Dashboard link in header", async () => {
    render(<EventPage />);
    await waitFor(() => {
      const dashLink = screen.getByTestId("dashboard-link");
      expect(dashLink).toBeInTheDocument();
      expect(dashLink).toHaveTextContent("View Dashboard");
      expect(dashLink).toHaveAttribute("href", "/display/duke-expo-2026");
    });
  });

  it("shows role dropdown on quorum cards with roles", async () => {
    render(<EventPage />);
    await waitFor(() =>
      expect(screen.getByTestId("role-dropdown-q-001")).toBeInTheDocument()
    );
    // q-002 has no roles, should not have dropdown
    expect(screen.queryByTestId("role-dropdown-q-002")).not.toBeInTheDocument();
  });

  it("opens role menu and navigates with station param on role selection", async () => {
    render(<EventPage />);
    await waitFor(() =>
      expect(screen.getByTestId("role-dropdown-q-001")).toBeInTheDocument()
    );

    // Open the dropdown
    fireEvent.click(screen.getByTestId("role-dropdown-q-001"));
    await waitFor(() =>
      expect(screen.getByTestId("role-menu-q-001")).toBeInTheDocument()
    );

    // Select a role
    fireEvent.click(screen.getByTestId("role-option-r-001"));
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringMatching(/^\/event\/duke-expo-2026\/quorum\/q-001\?station=\d+$/)
    );
  });
});
