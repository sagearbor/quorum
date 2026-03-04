import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VisionTracker } from "../VisionTracker";

// Mock @mediapipe/tasks-vision
vi.mock("@mediapipe/tasks-vision", () => ({
  ObjectDetector: {
    createFromOptions: vi.fn(),
  },
  FilesetResolver: {
    forVisionTasks: vi.fn().mockResolvedValue({}),
  },
}));

describe("VisionTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("mock mode", () => {
    it("should emit sine-wave gaze values in mock mode", () => {
      const gazeValues: number[] = [];
      const tracker = new VisionTracker({
        onGaze: (yaw) => gazeValues.push(yaw),
        mock: true,
        intervalMs: 100,
      });

      tracker.start();

      // Advance time to get several gaze callbacks
      vi.advanceTimersByTime(500);

      expect(gazeValues.length).toBeGreaterThanOrEqual(4);
      // All values should be in [-1, 1] range (sine wave)
      for (const v of gazeValues) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }

      tracker.stop();
    });

    it("should report isMock() = true in mock mode", () => {
      const tracker = new VisionTracker({ onGaze: vi.fn(), mock: true });
      expect(tracker.isMock()).toBe(true);
    });

    it("should stop emitting after stop()", () => {
      const gazeValues: number[] = [];
      const tracker = new VisionTracker({
        onGaze: (yaw) => gazeValues.push(yaw),
        mock: true,
        intervalMs: 100,
      });

      tracker.start();
      vi.advanceTimersByTime(300);
      const countBeforeStop = gazeValues.length;

      tracker.stop();
      vi.advanceTimersByTime(500);

      expect(gazeValues.length).toBe(countBeforeStop);
      expect(tracker.isRunning()).toBe(false);
    });

    it("should not double-start", async () => {
      const tracker = new VisionTracker({
        onGaze: vi.fn(),
        mock: true,
        intervalMs: 100,
      });

      await tracker.start();
      await tracker.start(); // second call should be no-op

      expect(tracker.isRunning()).toBe(true);
      tracker.stop();
    });
  });

  describe("MediaPipe mode (fallback)", () => {
    it("should fallback to mock when MediaPipe import fails", async () => {
      // Make the dynamic import fail
      vi.doMock("@mediapipe/tasks-vision", () => {
        throw new Error("WASM not available");
      });

      const tracker = new VisionTracker({
        onGaze: vi.fn(),
        mock: false,
        intervalMs: 100,
      });

      await tracker.start();

      // Should have fallen back to mock mode
      expect(tracker.isMock()).toBe(true);
      expect(tracker.isRunning()).toBe(true);

      tracker.stop();
    });
  });

  describe("gaze values", () => {
    it("should produce varying values over time (not constant)", () => {
      const gazeValues: number[] = [];
      const tracker = new VisionTracker({
        onGaze: (yaw) => gazeValues.push(yaw),
        mock: true,
        intervalMs: 100,
      });

      tracker.start();

      // Advance enough to see variation in sine wave
      vi.advanceTimersByTime(3000);

      expect(gazeValues.length).toBeGreaterThan(10);

      // Check that values aren't all the same
      const unique = new Set(gazeValues.map((v) => v.toFixed(3)));
      expect(unique.size).toBeGreaterThan(1);

      tracker.stop();
    });
  });
});
