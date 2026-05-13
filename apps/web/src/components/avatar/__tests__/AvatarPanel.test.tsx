import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { AvatarPanel } from "../AvatarPanel";

vi.mock("../VisionTracker", () => ({
  VisionTracker: {
    listCameras: vi.fn().mockResolvedValue([
      { deviceId: "cam-1", kind: "videoinput", label: "USB Webcam", groupId: "g1" },
      { deviceId: "cam-2", kind: "videoinput", label: "Built-in", groupId: "g2" },
    ]),
  },
}));

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

// Mock subscribeToFacilitator — capture the handler so tests can drive
// orchestrator narrations directly without spinning up a WebSocket server.
let lastFacilitatorHandler:
  | ((frame: { narration: string; next_role_id: string; next_role_name?: string | null; reason?: string | null }) => void)
  | null = null;
const mockUnsubscribe = vi.fn();
vi.mock("@/lib/dataProvider", () => ({
  subscribeToFacilitator: (
    _quorumId: string,
    handler: (frame: {
      narration: string;
      next_role_id: string;
      next_role_name?: string | null;
      reason?: string | null;
    }) => void
  ) => {
    lastFacilitatorHandler = handler;
    return mockUnsubscribe;
  },
  // 9.4 — ObservationStrip subscribes to facilitator observations. Stub
  // returns an unsubscribe so the strip mounts without a WebSocket and
  // stays hidden until the test sends it a static observation.
  subscribeToFacilitatorObservations: (
    _quorumId: string,
    _handler: (frame: unknown) => void,
  ) => mockUnsubscribe,
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

// Mock IdleScene to avoid Three.js in tests.
// Capture the most recent props so cameraMode tests below can assert
// what AvatarPanel passes down based on `avatarState.speaking`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const idleSceneCalls: any[] = [];
vi.mock("../IdleScene", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  IdleScene: vi.fn((props: any) => {
    idleSceneCalls.push(props);
    return null;
  }),
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
  mockUnsubscribe.mockClear();
  idleSceneCalls.length = 0;
  lastFacilitatorHandler = null;
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

// ---------------------------------------------------------------------------
// 11.3 — Orchestrator narration
//
// AvatarPanel subscribes to facilitator_narration WS frames and forwards the
// narration text into useAvatarController as synthesisText. This is the
// "avatar finally gets a voice" piece the spec asks for.
// ---------------------------------------------------------------------------

describe("AvatarPanel orchestrator narration", () => {
  it("subscribes to facilitator narration on mount and unsubscribes on unmount", () => {
    const { unmount } = render(<AvatarPanel quorumId="q-1" />);
    expect(lastFacilitatorHandler).not.toBeNull();
    expect(mockUnsubscribe).not.toHaveBeenCalled();

    unmount();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it("passes the latest orchestrator narration to the controller as synthesisText", () => {
    render(<AvatarPanel quorumId="q-2" />);
    expect(lastFacilitatorHandler).not.toBeNull();

    act(() => {
      lastFacilitatorHandler!({
        narration: "Asking the biostatistician to validate the sample size.",
        next_role_id: "role-bio",
        next_role_name: "Biostatistician",
        reason: "open question about power",
      });
    });

    // The mock controller forwards synthesisText through mockBrowserSpeak.
    expect(mockBrowserSpeak).toHaveBeenCalledWith(
      "Asking the biostatistician to validate the sample size."
    );
  });

  it("does NOT speak the orchestrator narration when paused", () => {
    render(
      <AvatarPanel
        quorumId="q-3"
        paused
        pausedReason="llm_unavailable"
      />
    );
    expect(lastFacilitatorHandler).not.toBeNull();

    act(() => {
      lastFacilitatorHandler!({
        narration: "Asking the ethicist to weigh in on consent.",
        next_role_id: "role-eth",
      });
    });

    // CRITICAL: paused must short-circuit TTS even if a fresh narration arrives.
    expect(mockSpeak).not.toHaveBeenCalled();
    expect(mockBrowserSpeak).not.toHaveBeenCalled();
  });

  it("staticSynthesisText overrides live orchestrator narration (test-only)", () => {
    render(
      <AvatarPanel
        quorumId="q-4"
        staticSynthesisText="STATIC override for tests"
      />
    );

    // Even when a live narration arrives, the static prop wins so unit tests
    // are deterministic.
    act(() => {
      lastFacilitatorHandler!({
        narration: "Live narration that should NOT win.",
        next_role_id: "role-x",
      });
    });

    expect(mockBrowserSpeak).toHaveBeenCalledWith("STATIC override for tests");
    expect(mockBrowserSpeak).not.toHaveBeenCalledWith(
      "Live narration that should NOT win."
    );
  });
});

// ---------------------------------------------------------------------------
// Camera framing — torso while talking, full body while idle
//
// Sophie: "It's very off-putting now you see the avatar's full body when
// it's talking and it's just standing still. So it should just be the top
// torso during the talking section."
//
// AvatarPanel reads `avatarState.speaking` from useAvatarController and
// forwards it to IdleScene as `cameraMode={speaking ? "torso" : "full_body"}`.
// ---------------------------------------------------------------------------

describe("AvatarPanel cameraMode", () => {
  it("passes cameraMode='full_body' to IdleScene when not speaking", () => {
    mockControllerState.speaking = false;
    render(<AvatarPanel quorumId="test-quorum" />);
    // Last call captures the final render's props.
    const latest = idleSceneCalls[idleSceneCalls.length - 1];
    expect(latest).toBeDefined();
    expect(latest.cameraMode).toBe("full_body");
  });

  it("passes cameraMode='torso' to IdleScene when speaking", () => {
    mockControllerState.speaking = true;
    render(<AvatarPanel quorumId="test-quorum" />);
    const latest = idleSceneCalls[idleSceneCalls.length - 1];
    expect(latest).toBeDefined();
    expect(latest.cameraMode).toBe("torso");
  });

  it("flips cameraMode from full_body to torso when speaking transitions", () => {
    mockControllerState.speaking = false;
    const { rerender } = render(<AvatarPanel quorumId="test-quorum" />);
    expect(idleSceneCalls[idleSceneCalls.length - 1].cameraMode).toBe("full_body");

    // Simulate the controller flipping into "speaking".
    mockControllerState.speaking = true;
    rerender(<AvatarPanel quorumId="test-quorum" />);
    expect(idleSceneCalls[idleSceneCalls.length - 1].cameraMode).toBe("torso");
  });
});

describe("AvatarPanel camera picker", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("does not show camera picker when emotion tracking is off", () => {
    render(<AvatarPanel quorumId="test-quorum" />);
    expect(screen.queryByTestId("avatar-camera-picker")).toBeNull();
  });

  it("shows camera picker with enumerated cameras when emotion tracking is on", async () => {
    render(<AvatarPanel quorumId="test-quorum" enableEmotionTracking />);
    const picker = await waitFor(() => screen.getByTestId("avatar-camera-picker"));
    expect(picker).toBeTruthy();
    const select = picker.querySelector("select")!;
    await waitFor(() => {
      expect(select.querySelectorAll("option").length).toBeGreaterThanOrEqual(3);
    });
    expect(select.textContent).toContain("USB Webcam");
    expect(select.textContent).toContain("Built-in");
  });

  it("persists selected camera to localStorage", async () => {
    render(<AvatarPanel quorumId="test-quorum" enableEmotionTracking />);
    const picker = await waitFor(() => screen.getByTestId("avatar-camera-picker"));
    const select = picker.querySelector("select")! as HTMLSelectElement;
    await waitFor(() => {
      expect(select.querySelectorAll("option").length).toBeGreaterThanOrEqual(3);
    });
    fireEvent.change(select, { target: { value: "cam-1" } });
    expect(window.localStorage.getItem("quorum.avatar.cameraDeviceId")).toBe("cam-1");
  });
});
