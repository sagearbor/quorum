import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

// Mock useAvatarController
vi.mock("../useAvatarController", () => ({
  useAvatarController: () => ({
    direction: "center",
    yaw: 0,
    pitch: 0,
    emotion: "neutral",
    detectedEmotion: "neutral",
    speaking: false,
    ready: true,
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
