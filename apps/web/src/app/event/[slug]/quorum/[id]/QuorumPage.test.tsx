import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import QuorumPage from "./page";
import { server } from "@/mocks/server";
import { beforeAll, afterEach, afterAll } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "duke-expo-2026", id: "q-001" }),
  useSearchParams: () => ({
    get: (key: string) => (key === "station" ? "1" : null),
  }),
}));

// Mock AvatarPanel — it depends on Three.js / WebGL which aren't available in jsdom
vi.mock("@/components/avatar/AvatarPanel", () => ({
  AvatarPanel: () => <div data-testid="avatar-panel" />,
}));

// Mock ConversationThread — heavy UI component not relevant to these tests
vi.mock("@/components/conversation/ConversationThread", () => ({
  ConversationThread: () => <div data-testid="conversation-thread" />,
}));

// Mock DocumentPanel
vi.mock("@/components/documents/DocumentPanel", () => ({
  DocumentPanel: () => <div data-testid="document-panel" />,
}));

// Mock hooks that call dataProvider internally
vi.mock("@/hooks/useStationConversation", () => ({
  useStationConversation: () => ({
    messages: [],
    loading: false,
    sending: false,
    facilitatorReply: null,
    sendMessage: vi.fn(),
    ingestFacilitatorReply: vi.fn(),
    clearFacilitatorReply: vi.fn(),
  }),
}));

vi.mock("@/hooks/useAgentDocuments", () => ({
  useAgentDocuments: () => ({
    documents: [],
    loading: false,
    refresh: vi.fn(),
  }),
}));

// Mock the offline queue
vi.mock("@/lib/offlineQueue", () => ({
  enqueue: vi.fn(),
}));

// Mock the dataProvider so async calls resolve immediately with fixture data.
// vi.mock factory is hoisted — all data is defined inline.
vi.mock("@/lib/dataProvider", () => {
  const mockQuorum = {
    id: "q-001",
    event_id: "evt-001",
    title: "IRB Protocol Review — NCT-2026-4481",
    description: "Multi-site phase III trial safety protocol.",
    status: "active",
    heat_score: 72,
    carousel_mode: "multi-view",
    dashboard_types: ["quorum_health_chart"],
    created_at: "2026-02-25T09:05:00Z",
    roles: [],
    contributions: [],
    artifact: null,
  };

  const mockRoles = [
    {
      id: "r-001",
      quorum_id: "q-001",
      name: "IRB Chair",
      capacity: 1,
      authority_rank: 3,
      prompt_template: [
        { field_name: "safety_assessment", prompt: "Summarize safety concerns with the current protocol" },
        { field_name: "approval_conditions", prompt: "List conditions for IRB approval" },
      ],
      fallback_chain: ["r-002"],
      color: "#DC2626",
    },
    {
      id: "r-002",
      quorum_id: "q-001",
      name: "Site PI",
      capacity: 1,
      authority_rank: 2,
      prompt_template: [
        { field_name: "site_readiness", prompt: "Describe site readiness for enrollment" },
        { field_name: "staffing_plan", prompt: "Outline staffing and resource plan" },
      ],
      fallback_chain: [],
      color: "#2563EB",
    },
    {
      id: "r-003",
      quorum_id: "q-001",
      name: "Patient Advocate",
      capacity: "unlimited",
      authority_rank: 1,
      prompt_template: [
        { field_name: "patient_concerns", prompt: "What are the key patient concerns?" },
        { field_name: "informed_consent", prompt: "Feedback on the informed consent document" },
      ],
      fallback_chain: [],
      color: "#16A34A",
    },
  ];

  const mockContributions = [
    {
      id: "c-001",
      quorum_id: "q-001",
      role_id: "r-003",
      user_token: "anon-user-1",
      content: "Patients expressed confusion about the consent form language.",
      structured_fields: {},
      tier_processed: 1,
      created_at: "2026-02-25T09:30:00Z",
    },
    {
      id: "c-002",
      quorum_id: "q-001",
      role_id: "r-002",
      user_token: "anon-user-2",
      content: "Duke site is ready for enrollment pending IRB approval.",
      structured_fields: {},
      tier_processed: 1,
      created_at: "2026-02-25T09:45:00Z",
    },
  ];

  return {
    isDemoMode: () => false,
    getQuorum: vi.fn().mockResolvedValue(mockQuorum),
    getRoles: vi.fn().mockResolvedValue(mockRoles),
    getContributions: vi.fn().mockResolvedValue(mockContributions),
    getStationMessages: vi.fn().mockResolvedValue([]),
    subscribeToStationMessages: vi.fn().mockReturnValue(() => {}),
    getAgentDocuments: vi.fn().mockResolvedValue([]),
    subscribeToAgentDocuments: vi.fn().mockReturnValue(() => {}),
  };
});

describe("QuorumPage", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders quorum title after load", async () => {
    render(<QuorumPage />);
    await waitFor(() => {
      expect(
        screen.getByText("IRB Protocol Review — NCT-2026-4481")
      ).toBeInTheDocument();
    });
  });

  it("renders role selection buttons", async () => {
    render(<QuorumPage />);
    await waitFor(() => {
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
  });

  it("shows contribution form when role is selected", async () => {
    render(<QuorumPage />);
    await waitFor(() =>
      expect(screen.getByTestId("role-select-r-003")).toBeInTheDocument()
    );
    // Click Patient Advocate
    fireEvent.click(screen.getByTestId("role-select-r-003"));
    expect(screen.getByTestId("contribution-form")).toBeInTheDocument();
    expect(
      screen.getByText("What are the key patient concerns?")
    ).toBeInTheDocument();
  });

  it("submit button is disabled when fields are empty", async () => {
    render(<QuorumPage />);
    await waitFor(() =>
      expect(screen.getByTestId("role-select-r-001")).toBeInTheDocument()
    );
    // Select a role so the form appears
    fireEvent.click(screen.getByTestId("role-select-r-001"));
    const submitBtn = screen.getByTestId("submit-contribution");
    expect(submitBtn).toBeDisabled();
  });

  it("submits contribution and shows success", async () => {
    render(<QuorumPage />);
    await waitFor(() =>
      expect(screen.getByTestId("role-select-r-001")).toBeInTheDocument()
    );
    // Select IRB Chair
    fireEvent.click(screen.getByTestId("role-select-r-001"));

    // Fill in the first field
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

  it("shows voice button after role is selected", async () => {
    render(<QuorumPage />);
    await waitFor(() =>
      expect(screen.getByTestId("role-select-r-001")).toBeInTheDocument()
    );
    // Voice button is only shown when a role is selected (inside contribution form)
    fireEvent.click(screen.getByTestId("role-select-r-001"));
    expect(screen.getByTestId("voice-button")).toBeInTheDocument();
    expect(screen.getByTestId("voice-button")).toHaveTextContent("Voice");
  });

  it("shows existing contributions on Contributions tab", async () => {
    render(<QuorumPage />);
    // Wait for the page to load
    await waitFor(() =>
      expect(screen.getByTestId("tab-contributions")).toBeInTheDocument()
    );
    // Click the Contributions tab to reveal contributions
    fireEvent.click(screen.getByTestId("tab-contributions"));
    await waitFor(() => {
      expect(screen.getByTestId("contribution-c-001")).toBeInTheDocument();
      expect(screen.getByTestId("contribution-c-002")).toBeInTheDocument();
    });
  });

  it("switches roles when clicking a different role", async () => {
    render(<QuorumPage />);
    await waitFor(() =>
      expect(screen.getByTestId("role-select-r-002")).toBeInTheDocument()
    );
    // Click Site PI
    fireEvent.click(screen.getByTestId("role-select-r-002"));

    expect(
      screen.getByText("Describe site readiness for enrollment")
    ).toBeInTheDocument();
  });

  it("shows the tab bar with Conversation, Documents, Contributions tabs", async () => {
    render(<QuorumPage />);
    await waitFor(() =>
      expect(screen.getByTestId("quorum-tabs")).toBeInTheDocument()
    );
    expect(screen.getByTestId("tab-conversation")).toBeInTheDocument();
    expect(screen.getByTestId("tab-documents")).toBeInTheDocument();
    expect(screen.getByTestId("tab-contributions")).toBeInTheDocument();
  });

  it("shows station badge from URL param", async () => {
    render(<QuorumPage />);
    await waitFor(() => {
      expect(screen.getByText("Station 1")).toBeInTheDocument();
    });
  });
});
