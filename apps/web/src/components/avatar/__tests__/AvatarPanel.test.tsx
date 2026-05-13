import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AvatarPanel } from "../AvatarPanel";

// Mock useQuorumLive
vi.mock("@/hooks/useQuorumLive", () => ({
  useQuorumLive: () => ({
    healthScore: 65,
    metrics: {
      completion_pct: 50,
      consensus_score: 60,
      role_coverage_pct: 70,
      critical_path_score: 55,
      blocker_score: 80,
    },
    history: [],
    recentContributions: [],
    artifact: null,
    connected: true,
    error: null,
  }),
}));

// Track what the avatar controller is invoked with so tests can assert that
// the paused prop is forwarded and that TTS does not fire on paused turns.
const mockSpeak = vi.fn();
const mockBrowserSpeak = vi.fn();
let mockControllerState: {
  direction: string;
  yaw: number;
  pitch: number;
  emotion: string;
  detectedEmotion: string;
  speaking: boolean;
  ready: boolean;
  paused: boolean;
  pausedReason: string | null;
} = {
  direction: "center",
  yaw: 0,
  pitch: 0,
  emotion: "neutral",
  detectedEmotion: "neutral",
  speaking: false,
  ready: true,
  paused: false,
  pausedReason: null,
};

// Mock useAvatarController — it receives the paused prop from AvatarPanel
// and returns the mocked state. We capture any speak calls indirectly via
// the mocks on @/lib/speechSynthesis and AvatarProvider below.
vi.mock("../useAvatarController", () => ({
  useAvatarController: (options: { paused?: boolean; pausedReason?: string | null; synthesisText?: string }) => {
    // Simulate the controller's contract: if paused, do not speak.
    if (!options.paused && options.synthesisText) {
      mockBrowserSpeak(options.synthesisText);
    }
    return {
      ...mockControllerState,
      paused: options.paused ?? mockControllerState.paused,
      pausedReason: options.pausedReason ?? mockControllerState.pausedReason,
    };
  },
}));

// Mock both TTS paths so we can assert neither is called when paused.
vi.mock("@/lib/speechSynthesis", () => ({
  speakText: (text: string) => {
    mockBrowserSpeak(text);
    return Promise.resolve();
  },
}));

vi.mock("../AvatarProvider", () => ({
  createAvatarProvider: () => ({
    init: () => Promise.resolve(),
    speak: (text: string) => {
      mockSpeak(text);
      return Promise.resolve();
    },
    setHeadPose: () => {},
    destroy: () => {},
  }),
}));

// Mock IdleScene to avoid Three.js in tests
vi.mock("../IdleScene", () => ({
  IdleScene: vi.fn(() => null),
}));

// Mock archetype modules
vi.mock("../archetypes/resolveArchetype", () => ({
  resolveArchetype: () => "neutral",
}));

vi.mock("../archetypes/archetypes", () => ({
  ARCHETYPES: { neutral: { id: "neutral", glbSources: [{ provider: "placeholder", path: "/avatars/neutral.glb" }] } },
  resolveGlbUrl: () => "/avatars/neutral.glb",
}));

beforeEach(() => {
  mockSpeak.mockClear();
  mockBrowserSpeak.mockClear();
  mockControllerState = {
    direction: "center",
    yaw: 0,
    pitch: 0,
    emotion: "neutral",
    detectedEmotion: "neutral",
    speaking: false,
    ready: true,
    paused: false,
    pausedReason: null,
  };
});

describe("AvatarPanel", () => {
  it("renders the panel container", () => {
    render(<AvatarPanel quorumId="test-quorum" />);
    expect(screen.getByTestId("avatar-panel")).toBeTruthy();
  });

  it("renders the avatar container", () => {
    render(<AvatarPanel quorumId="test-quorum" />);
    expect(screen.getByTestId("avatar-container")).toBeTruthy();
  });

  it("shows emotion badge", () => {
    render(<AvatarPanel quorumId="test-quorum" />);
    expect(screen.getByTestId("avatar-emotion")).toHaveTextContent("neutral");
  });

  it("shows 'Facilitator' label when not speaking", () => {
    render(<AvatarPanel quorumId="test-quorum" />);
    expect(screen.getByText("Facilitator")).toBeTruthy();
  });

  it("does not show direction indicator by default", () => {
    render(<AvatarPanel quorumId="test-quorum" />);
    expect(screen.queryByTestId("avatar-direction")).toBeNull();
  });

  it("shows direction indicator when showDirectionIndicator is true", () => {
    render(<AvatarPanel quorumId="test-quorum" showDirectionIndicator />);
    expect(screen.getByTestId("avatar-direction")).toBeTruthy();
  });

  it("does not show waveform when not speaking", () => {
    render(<AvatarPanel quorumId="test-quorum" />);
    expect(screen.queryByTestId("avatar-waveform")).toBeNull();
  });
});

describe("AvatarPanel with direction indicator", () => {
  it("renders L, C, R direction labels", () => {
    render(<AvatarPanel quorumId="test-quorum" showDirectionIndicator />);
    const indicator = screen.getByTestId("avatar-direction");
    expect(indicator).toHaveTextContent("L");
    expect(indicator).toHaveTextContent("C");
    expect(indicator).toHaveTextContent("R");
  });
});

// ---------------------------------------------------------------------------
// 10.6 — Facilitator paused state
//
// The bug: when the LLM call fails the backend returned a chat-string error
// fallback ("I encountered an issue…") which the avatar then SPOKE on the
// 60-inch projector at the Duke Tech Expo. The audience read it as "the AI is
// broken." The fix: backend returns a structured paused sentinel and the
// frontend renders a calm "reconnecting" pill without speaking.
// ---------------------------------------------------------------------------

describe("AvatarPanel when paused", () => {
  it("renders the 'Facilitator paused — reconnecting' pill", () => {
    render(
      <AvatarPanel
        quorumId="test-quorum"
        paused
        pausedReason="llm_unavailable"
      />
    );
    const pill = screen.getByTestId("avatar-paused-pill");
    expect(pill).toBeTruthy();
    expect(pill).toHaveTextContent("Facilitator paused — reconnecting");
  });

  it("does not render the pill on normal (non-paused) turns", () => {
    render(<AvatarPanel quorumId="test-quorum" />);
    expect(screen.queryByTestId("avatar-paused-pill")).toBeNull();
  });

  it("does NOT trigger TTS when paused (no provider.speak, no browserSpeakText)", () => {
    render(
      <AvatarPanel
        quorumId="test-quorum"
        paused
        pausedReason="llm_unavailable"
        staticSynthesisText="I encountered an issue processing your message."
      />
    );
    // CRITICAL: the avatar must stay silent on paused turns. The string
    // passed as staticSynthesisText is the kind of garbage that used to
    // leak to TTS — if either mock was called, the projector would speak.
    expect(mockSpeak).not.toHaveBeenCalled();
    expect(mockBrowserSpeak).not.toHaveBeenCalled();
  });

  it("uses 'status' role on the pill for accessibility", () => {
    render(<AvatarPanel quorumId="test-quorum" paused />);
    const pill = screen.getByTestId("avatar-paused-pill");
    expect(pill.getAttribute("role")).toBe("status");
  });

  it("pill auto-dismisses on rerender with paused=false", () => {
    const { rerender } = render(
      <AvatarPanel quorumId="test-quorum" paused pausedReason="llm_unavailable" />
    );
    expect(screen.getByTestId("avatar-paused-pill")).toBeTruthy();

    rerender(<AvatarPanel quorumId="test-quorum" paused={false} />);
    expect(screen.queryByTestId("avatar-paused-pill")).toBeNull();
  });
});
