/**
 * Tests for /agent/[roleId] — the mobile 1:1 chat with a single role-agent.
 *
 * Asserts:
 *   - Renders at 375px viewport without crashing.
 *   - No <audio>/TTS plays on initial render (speaker default OFF).
 *   - Mic toggle defaults OFF; toggling ON reveals the mic trigger button.
 *   - Speaker toggle defaults OFF; assistant replies appear as text only.
 *   - Submitting the text input POSTs /quorums/<id>/contribute with
 *     participant_id, role_id, station_id.
 *   - When a /contribute response carries paused: true, the paused pill
 *     renders and no TTS fires (even if the speaker is toggled ON later).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// --- mocks --------------------------------------------------------------

const replaceMock = vi.fn();
const pushMock = vi.fn();
const backMock = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ roleId: "role-ethics" }),
  useSearchParams: () => new URLSearchParams({ ds: "pid-123" }),
  useRouter: () => ({ replace: replaceMock, push: pushMock, back: backMock }),
}));

// Mock dataProvider — getRoles returns a single matching role; getHealthScore
// returns a number so the widget renders.
vi.mock("@/lib/dataProvider", () => ({
  getRoles: vi.fn(async () => [
    {
      id: "role-ethics",
      quorum_id: "quorum-abc",
      name: "Ethicist",
      capacity: "unlimited",
      authority_rank: 2,
      prompt_template: [],
      fallback_chain: [],
      color: "#aa00aa",
    },
  ]),
  getHealthScore: vi.fn(async () => 87),
  isDemoMode: () => false,
}));

// Mock useStationConversation so we can control messages + facilitatorReply
// independently of the network layer.
interface MockReply {
  reply: string | null;
  message_id: string | null;
  tags: string[];
  paused?: boolean;
  reason?: string | null;
}

const mockConversationState: {
  messages: import("@quorum/types").StationMessage[];
  loading: boolean;
  sending: boolean;
  facilitatorReply: MockReply | null;
  sendMessage: ReturnType<typeof vi.fn>;
  ingestFacilitatorReply: ReturnType<typeof vi.fn>;
  clearFacilitatorReply: ReturnType<typeof vi.fn>;
} = {
  messages: [],
  loading: false,
  sending: false,
  facilitatorReply: null,
  sendMessage: vi.fn().mockResolvedValue(undefined),
  ingestFacilitatorReply: vi.fn((reply: MockReply) => {
    mockConversationState.facilitatorReply = reply;
  }),
  clearFacilitatorReply: vi.fn(),
};

vi.mock("@/hooks/useStationConversation", () => ({
  useStationConversation: () => mockConversationState,
}));

// --- test fixtures ------------------------------------------------------

function setMobileViewport() {
  // jsdom respects window.innerWidth assignments; matchMedia is also patched
  // for any components that consult it.
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 812 });
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  }
}

function setSessionParticipant() {
  window.sessionStorage.setItem(
    "quorum.participant",
    JSON.stringify({
      participant_id: "pid-123",
      display_name: "Visitor 1",
      quorum_id: "quorum-abc",
      station_label: "station-2",
      role_id: "role-ethics",
      device_kind: "phone",
    }),
  );
}

// Track TTS calls so we can assert they don't fire when speaker is OFF.
const speakSpy = vi.fn();
let UtteranceCtorSpy: ReturnType<typeof vi.fn> | null = null;

function installTtsSpy() {
  speakSpy.mockReset();
  UtteranceCtorSpy = vi.fn(function (this: { text: string }, text: string) {
    this.text = text;
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { speak: speakSpy, cancel: vi.fn(), pause: vi.fn(), resume: vi.fn() },
  });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    writable: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: UtteranceCtorSpy as any,
  });
}

import AgentPage from "../page";

describe("/agent/[roleId]", () => {
  beforeEach(() => {
    setMobileViewport();
    setSessionParticipant();
    installTtsSpy();
    mockConversationState.messages = [];
    mockConversationState.facilitatorReply = null;
    mockConversationState.loading = false;
    mockConversationState.sending = false;
    mockConversationState.ingestFacilitatorReply.mockClear();
    replaceMock.mockReset();

    // Default fetch mock — contribute returns a plain text reply.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/sessions/heartbeat")) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/contribute")) {
        return new Response(
          JSON.stringify({
            contribution_id: "c-1",
            tier_processed: 1,
            facilitator_reply: "Hello back!",
            facilitator_message_id: "msg-1",
            facilitator_tags: ["greeting"],
            a2a_requests_triggered: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    // @ts-expect-error — overriding global fetch for the test
    global.fetch = fetchMock;
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("renders the role name on a mobile viewport", async () => {
    await act(async () => {
      render(<AgentPage />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("agent-role-name")).toHaveTextContent("Ethicist");
    });
    // Wraps under max-w-screen-sm
    expect(screen.getByTestId("agent-page")).toBeInTheDocument();
  });

  it("does not play TTS on initial render — speaker toggle defaults OFF", async () => {
    mockConversationState.facilitatorReply = {
      reply: "Welcome",
      message_id: "msg-init",
      tags: [],
    };
    await act(async () => {
      render(<AgentPage />);
    });
    await screen.findByTestId("agent-role-name");
    expect(speakSpy).not.toHaveBeenCalled();
    expect(UtteranceCtorSpy).not.toHaveBeenCalled();
  });

  it("speaker toggle aria-pressed is false on first load (OFF default)", async () => {
    await act(async () => {
      render(<AgentPage />);
    });
    const btn = await screen.findByTestId("agent-speaker-toggle");
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("mic toggle defaults OFF and the mic trigger is hidden; turning it ON reveals the trigger", async () => {
    await act(async () => {
      render(<AgentPage />);
    });
    const micToggle = await screen.findByTestId("agent-mic-toggle");
    expect(micToggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("agent-mic-trigger")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(micToggle);
    });

    expect(micToggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("agent-mic-trigger")).toBeInTheDocument();
  });

  it("submitting the input POSTs to /contribute with participant_id + role_id + station_id", async () => {
    await act(async () => {
      render(<AgentPage />);
    });
    const input = await screen.findByTestId("agent-input");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Hi there" } });
    });
    const sendBtn = screen.getByTestId("agent-send");
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    await waitFor(() => {
      // @ts-expect-error - global.fetch is our test mock
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/quorums/quorum-abc/contribute"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    // @ts-expect-error - global.fetch is our test mock
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const contributeCall = calls.find((c: unknown[]) =>
      String(c[0]).endsWith("/contribute"),
    );
    expect(contributeCall).toBeDefined();
    const body = JSON.parse(
      (contributeCall![1] as { body: string }).body,
    );
    expect(body.role_id).toBe("role-ethics");
    expect(body.participant_id).toBe("pid-123");
    expect(body.station_id).toBe("station-2");
    expect(body.content).toBe("Hi there");
  });

  it("renders the paused pill when /contribute returns facilitator_paused: true, and does NOT call TTS", async () => {
    // Override fetch for this test — paused contribute response.
    const pausedFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/sessions/heartbeat")) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/contribute")) {
        return new Response(
          JSON.stringify({
            contribution_id: "c-paused",
            tier_processed: 1,
            facilitator_reply: null,
            facilitator_message_id: null,
            facilitator_tags: [],
            a2a_requests_triggered: 0,
            facilitator_paused: true,
            facilitator_paused_reason: "llm_unavailable",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    // @ts-expect-error — overriding global fetch for the test
    global.fetch = pausedFetch;

    // Mirror the ingestFacilitatorReply side-effect so the pill renders.
    mockConversationState.ingestFacilitatorReply.mockImplementation(
      (reply: MockReply) => {
        mockConversationState.facilitatorReply = reply;
      },
    );

    const { rerender } = render(<AgentPage />);

    const input = await screen.findByTestId("agent-input");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Are you there?" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-send"));
    });

    await waitFor(() => {
      expect(mockConversationState.ingestFacilitatorReply).toHaveBeenCalledWith(
        expect.objectContaining({ paused: true }),
      );
    });

    // Force a re-render so the new facilitatorReply state propagates to the DOM.
    rerender(<AgentPage />);

    await waitFor(() => {
      expect(screen.getByTestId("agent-paused-pill")).toBeInTheDocument();
    });

    expect(speakSpy).not.toHaveBeenCalled();
  });

  it("renders an error when sessionStorage participant_id does not match the URL ds=", async () => {
    window.sessionStorage.setItem(
      "quorum.participant",
      JSON.stringify({
        participant_id: "different-pid",
        quorum_id: "quorum-abc",
        role_id: "role-ethics",
      }),
    );
    await act(async () => {
      render(<AgentPage />);
    });
    expect(screen.getByTestId("agent-error")).toBeInTheDocument();
  });
});
