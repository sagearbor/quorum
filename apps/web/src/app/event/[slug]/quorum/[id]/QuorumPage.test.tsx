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

// ---------------------------------------------------------------------------
// Per-test-overrideable mock state for hooks
// ---------------------------------------------------------------------------

// We expose the mock return values as module-level objects so individual tests
// can mutate them before rendering without needing vi.mocked().mockReturnValue.

let lastConversationArgs: unknown[] = [];

const mockConversationIngestReply = vi.fn();

const mockConversationState: {
  messages: import("@quorum/types").StationMessage[];
  loading: boolean;
  sending: boolean;
  facilitatorReply: import("@/lib/dataProvider").FacilitatorReply | null;
  sendMessage: ReturnType<typeof vi.fn>;
  ingestFacilitatorReply: ReturnType<typeof vi.fn>;
  clearFacilitatorReply: ReturnType<typeof vi.fn>;
} = {
  messages: [],
  loading: false,
  sending: false,
  facilitatorReply: null,
  sendMessage: vi.fn().mockResolvedValue(undefined),
  ingestFacilitatorReply: mockConversationIngestReply,
  clearFacilitatorReply: vi.fn(),
};

const mockA2APendingCount = { value: 0 };
const mockA2ANotifications: import("@/hooks/useA2ARequests").A2ANotification[] = [];

// Mock hooks that call dataProvider internally
vi.mock("@/hooks/useStationConversation", () => ({
  useStationConversation: (...args: unknown[]) => {
    lastConversationArgs = args;
    return mockConversationState;
  },
}));

vi.mock("@/hooks/useAgentDocuments", () => ({
  useAgentDocuments: () => ({
    documents: [],
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useA2ARequests", () => ({
  useA2ARequests: () => ({
    notifications: mockA2ANotifications,
    pendingCount: mockA2APendingCount.value,
    dismiss: vi.fn(),
    clearDismissed: vi.fn(),
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
    // Reset module-level hook state
    lastConversationArgs = [];
    mockConversationState.loading = false;
    mockConversationState.sending = false;
    mockConversationState.facilitatorReply = null;
    mockA2APendingCount.value = 0;
    mockA2ANotifications.length = 0;
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

  it("shows dashboard link in header", async () => {
    render(<QuorumPage />);
    await waitFor(() => {
      const dashLink = screen.getByTestId("dashboard-link");
      expect(dashLink).toBeInTheDocument();
      expect(dashLink).toHaveTextContent("Dashboard");
      expect(dashLink).toHaveAttribute("href", "/display/duke-expo-2026");
    });
  });

  it("wires facilitator reply to ingestFacilitatorReply on successful contribution", async () => {
    render(<QuorumPage />);

    await waitFor(() =>
      expect(screen.getByTestId("role-select-r-001")).toBeInTheDocument()
    );

    // Select IRB Chair
    fireEvent.click(screen.getByTestId("role-select-r-001"));

    // Fill in a field
    const textarea = screen.getByTestId("field-safety_assessment");
    fireEvent.change(textarea, {
      target: { value: "No major safety concerns identified" },
    });

    fireEvent.click(screen.getByTestId("submit-contribution"));

    // MSW handler returns a facilitator_reply — ingestFacilitatorReply should be called
    await waitFor(() => {
      expect(mockConversationIngestReply).toHaveBeenCalledWith(
        expect.objectContaining({
          reply: expect.any(String),
          message_id: expect.any(String),
          tags: expect.any(Array),
        })
      );
    });
  });

  it("switches active tab to conversation after facilitator reply arrives on contribution", async () => {
    render(<QuorumPage />);

    await waitFor(() =>
      expect(screen.getByTestId("role-select-r-001")).toBeInTheDocument()
    );

    // Start on contributions tab
    fireEvent.click(screen.getByTestId("tab-contributions"));
    expect(screen.getByTestId("tab-contributions")).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // Select role and submit
    fireEvent.click(screen.getByTestId("role-select-r-001"));
    const textarea = screen.getByTestId("field-safety_assessment");
    fireEvent.change(textarea, { target: { value: "Safety looks good" } });
    fireEvent.click(screen.getByTestId("submit-contribution"));

    // After contribution with facilitator_reply, tab should switch to conversation
    await waitFor(() => {
      expect(screen.getByTestId("tab-conversation")).toHaveAttribute(
        "aria-selected",
        "true"
      );
    });
  });

  it("station_id is derived from ?station= URL param", async () => {
    // The stationId passed to hooks should be 'station-1' when ?station=1
    render(<QuorumPage />);

    await waitFor(() => {
      // lastConversationArgs is captured each render by our mock
      expect(lastConversationArgs[0]).toBe("q-001");
      expect(lastConversationArgs[1]).toBe("station-1");
    });
  });

  it("shows unread indicator on conversation tab when A2A notifications exist", async () => {
    // Set module-level A2A state to have a pending notification
    mockA2APendingCount.value = 1;
    mockA2ANotifications.push({
      id: "req-001",
      request: {} as import("@quorum/types").AgentRequest,
      summary: "Safety Monitor flagged a conflict",
      dismissed: false,
      receivedAt: new Date().toISOString(),
    });

    render(<QuorumPage />);

    await waitFor(() =>
      expect(screen.getByTestId("quorum-tabs")).toBeInTheDocument()
    );

    // Switch to a different tab so the indicator is visible
    fireEvent.click(screen.getByTestId("tab-documents"));

    // The conversation tab should now show the amber A2A badge count
    // (replaced the old indigo dot with a numbered amber badge for A2A notifications)
    expect(screen.getByTestId("a2a-badge")).toBeInTheDocument();

    // Clean up module-level state for subsequent tests
    mockA2APendingCount.value = 0;
    mockA2ANotifications.length = 0;
  });
});
