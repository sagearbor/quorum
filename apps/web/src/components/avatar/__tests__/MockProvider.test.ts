import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockProvider } from "../MockProvider";

// Mock requestAnimationFrame and cancelAnimationFrame for jsdom
let rafCallbacks: Array<FrameRequestCallback> = [];
let rafId = 0;

beforeEach(() => {
  rafCallbacks = [];
  rafId = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return ++rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (_id: number) => {
    // no-op for tests
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MockProvider", () => {
  let provider: MockProvider;
  let container: HTMLDivElement;

  beforeEach(() => {
    provider = new MockProvider();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    provider.destroy();
    document.body.removeChild(container);
  });

  it("creates SVG on init", async () => {
    await provider.init({ containerEl: container });
    const svg = container.querySelector('[data-testid="mock-avatar-svg"]');
    expect(svg).toBeTruthy();
  });

  it("renders face, eyes, and mouth elements", async () => {
    await provider.init({ containerEl: container });
    expect(container.querySelector('[data-testid="mock-avatar-face"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="mock-avatar-left-eye"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="mock-avatar-right-eye"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="mock-avatar-mouth"]')).toBeTruthy();
  });

  it("moves eyes when setHeadPose is called", async () => {
    await provider.init({ containerEl: container });

    const leftEye = container.querySelector('[data-testid="mock-avatar-left-eye"]')!;
    const rightEye = container.querySelector('[data-testid="mock-avatar-right-eye"]')!;

    // Default position
    const defaultLeftX = leftEye.getAttribute("cx");
    const defaultRightX = rightEye.getAttribute("cx");

    // Look right (yaw = 1.0)
    provider.setHeadPose(1.0, 0);
    const rightLeftX = leftEye.getAttribute("cx");
    const rightRightX = rightEye.getAttribute("cx");

    // Eyes should have shifted right (higher cx value)
    expect(Number(rightLeftX)).toBeGreaterThan(Number(defaultLeftX));
    expect(Number(rightRightX)).toBeGreaterThan(Number(defaultRightX));

    // Look left (yaw = -1.0)
    provider.setHeadPose(-1.0, 0);
    const leftLeftX = leftEye.getAttribute("cx");

    // Eyes should be to the left of default
    expect(Number(leftLeftX)).toBeLessThan(Number(defaultLeftX));
  });

  it("clamps yaw to -1..1", async () => {
    await provider.init({ containerEl: container });

    // Extreme values should be clamped
    provider.setHeadPose(5.0, 0);
    const leftEye = container.querySelector('[data-testid="mock-avatar-left-eye"]')!;
    const extremeRight = Number(leftEye.getAttribute("cx"));

    provider.setHeadPose(1.0, 0);
    const maxRight = Number(leftEye.getAttribute("cx"));

    expect(extremeRight).toBe(maxRight); // Clamped to same value
  });

  it("changes face color based on emotion", async () => {
    await provider.init({ containerEl: container });
    vi.useFakeTimers();

    const face = container.querySelector('[data-testid="mock-avatar-face"]')!;

    // Default: neutral (blue)
    expect(face.getAttribute("fill")).toBe("#3b82f6");

    // Speak with 'tense' emotion
    const speakPromise = provider.speak("test", "tense");
    expect(face.getAttribute("fill")).toBe("#ef4444");

    vi.advanceTimersByTime(5000);
    await speakPromise;

    vi.useRealTimers();
  });

  it("isSpeaking returns true while speaking", async () => {
    await provider.init({ containerEl: container });
    vi.useFakeTimers();

    expect(provider.isSpeaking()).toBe(false);

    const speakPromise = provider.speak("hello world");
    expect(provider.isSpeaking()).toBe(true);

    // Advance past speech duration
    vi.advanceTimersByTime(6000);
    await speakPromise;

    expect(provider.isSpeaking()).toBe(false);
    vi.useRealTimers();
  });

  it("speak resolves after simulated duration", async () => {
    await provider.init({ containerEl: container });
    vi.useFakeTimers();

    let resolved = false;
    const p = provider.speak("hi").then(() => { resolved = true; });

    vi.advanceTimersByTime(400);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(200);
    await Promise.resolve();
    await p;
    expect(resolved).toBe(true);

    vi.useRealTimers();
  });

  it("destroy removes SVG from container", async () => {
    await provider.init({ containerEl: container });
    expect(container.querySelector("svg")).toBeTruthy();

    provider.destroy();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("works without containerEl (no SVG rendered)", async () => {
    await provider.init({});
    // Should not throw
    provider.setHeadPose(0.5, 0);
    expect(provider.isSpeaking()).toBe(false);
    provider.destroy();
  });
});
