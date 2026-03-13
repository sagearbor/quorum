import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAvatarController } from "../useAvatarController";
import type { AvatarProvider } from "../AvatarProvider";
import React from "react";

// Mock the factory and StereoAnalyzer
const mockProvider: AvatarProvider = {
  init: vi.fn().mockResolvedValue(undefined),
  speak: vi.fn().mockResolvedValue(undefined),
  setHeadPose: vi.fn(),
  isSpeaking: vi.fn().mockReturnValue(false),
  destroy: vi.fn(),
};

vi.mock("../AvatarProvider", async () => {
  const actual = await vi.importActual("../AvatarProvider");
  return {
    ...actual,
    createAvatarProvider: () => mockProvider,
  };
});

vi.mock("../StereoAnalyzer", () => ({
  StereoAnalyzer: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
  },
}));

vi.mock("../VisionTracker", () => ({
  VisionTracker: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
  },
}));

vi.mock("../EmotionDetector", () => ({
  EmotionDetector: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
  },
}));

describe("useAvatarController", () => {
  let containerEl: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    containerEl = document.createElement("div");
    document.body.appendChild(containerEl);
  });

  afterEach(() => {
    document.body.removeChild(containerEl);
  });

  function createRef(): React.RefObject<HTMLElement | null> {
    return { current: containerEl };
  }

  it("initializes provider on mount", async () => {
    const ref = createRef();
    const { result } = renderHook(() =>
      useAvatarController({
        providerType: "mock",
        containerRef: ref,
        healthScore: 50,
      }),
    );

    // Wait for init
    await vi.waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(mockProvider.init).toHaveBeenCalledWith({ containerEl });
  });

  it("destroys provider on unmount", async () => {
    const ref = createRef();
    const { unmount } = renderHook(() =>
      useAvatarController({
        providerType: "mock",
        containerRef: ref,
        healthScore: 50,
      }),
    );

    await vi.waitFor(() => {
      expect(mockProvider.init).toHaveBeenCalled();
    });

    unmount();
    expect(mockProvider.destroy).toHaveBeenCalled();
  });

  it("computes 'engaged' emotion when health increases", async () => {
    const ref = createRef();
    const { result, rerender } = renderHook(
      ({ score }) =>
        useAvatarController({
          providerType: "mock",
          containerRef: ref,
          healthScore: score,
          enableMic: false,
        }),
      { initialProps: { score: 50 } },
    );

    rerender({ score: 60 });

    expect(result.current.emotion).toBe("engaged");
  });

  it("computes 'tense' emotion when health drops significantly", async () => {
    const ref = createRef();
    const { result, rerender } = renderHook(
      ({ score }) =>
        useAvatarController({
          providerType: "mock",
          containerRef: ref,
          healthScore: score,
          enableMic: false,
        }),
      { initialProps: { score: 50 } },
    );

    rerender({ score: 40 }); // Delta of -10, < -5

    expect(result.current.emotion).toBe("tense");
  });

  it("computes 'neutral' emotion for small health changes", async () => {
    const ref = createRef();
    const { result, rerender } = renderHook(
      ({ score }) =>
        useAvatarController({
          providerType: "mock",
          containerRef: ref,
          healthScore: score,
          enableMic: false,
        }),
      { initialProps: { score: 50 } },
    );

    rerender({ score: 48 }); // Delta of -2, not < -5

    expect(result.current.emotion).toBe("neutral");
  });

  it("computes 'resolved' emotion when quorum is resolved", async () => {
    const ref = createRef();
    const { result } = renderHook(() =>
      useAvatarController({
        providerType: "mock",
        containerRef: ref,
        healthScore: 50,
        resolved: true,
        enableMic: false,
      }),
    );

    expect(result.current.emotion).toBe("resolved");
  });

  it("speaks when synthesisText changes", async () => {
    const ref = createRef();
    const { rerender } = renderHook(
      ({ text }) =>
        useAvatarController({
          providerType: "mock",
          containerRef: ref,
          healthScore: 50,
          enableMic: false,
          synthesisText: text,
        }),
      { initialProps: { text: undefined as string | undefined } },
    );

    // Wait for provider to be ready
    await vi.waitFor(() => {
      expect(mockProvider.init).toHaveBeenCalled();
    });

    rerender({ text: "New synthesis result" });

    await vi.waitFor(() => {
      expect(mockProvider.speak).toHaveBeenCalledWith("New synthesis result", expect.any(String));
    });
  });

  it("defaults direction to center", () => {
    const ref = createRef();
    const { result } = renderHook(() =>
      useAvatarController({
        providerType: "mock",
        containerRef: ref,
        healthScore: 50,
        enableMic: false,
      }),
    );

    expect(result.current.direction).toBe("center");
    expect(result.current.yaw).toBe(0);
  });
});
