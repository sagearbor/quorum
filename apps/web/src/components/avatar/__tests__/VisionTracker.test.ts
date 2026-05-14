import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VisionTracker, computeSizeRatio, smoothSizeRatio } from "../VisionTracker";

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

  describe("listCameras", () => {
    it("returns only videoinput devices", async () => {
      const fakeDevices: MediaDeviceInfo[] = [
        { deviceId: "cam-1", kind: "videoinput", label: "USB Webcam", groupId: "g1" } as MediaDeviceInfo,
        { deviceId: "mic-1", kind: "audioinput", label: "Mic", groupId: "g2" } as MediaDeviceInfo,
        { deviceId: "cam-2", kind: "videoinput", label: "Built-in", groupId: "g3" } as MediaDeviceInfo,
      ];
      const original = (globalThis.navigator as Navigator | undefined)?.mediaDevices;
      Object.defineProperty(globalThis.navigator, "mediaDevices", {
        value: { enumerateDevices: vi.fn().mockResolvedValue(fakeDevices) },
        configurable: true,
      });

      const cameras = await VisionTracker.listCameras();
      expect(cameras.map((c) => c.deviceId)).toEqual(["cam-1", "cam-2"]);

      Object.defineProperty(globalThis.navigator, "mediaDevices", {
        value: original,
        configurable: true,
      });
    });

    it("returns [] when mediaDevices is unavailable", async () => {
      const original = (globalThis.navigator as Navigator | undefined)?.mediaDevices;
      Object.defineProperty(globalThis.navigator, "mediaDevices", {
        value: undefined,
        configurable: true,
      });

      const cameras = await VisionTracker.listCameras();
      expect(cameras).toEqual([]);

      Object.defineProperty(globalThis.navigator, "mediaDevices", {
        value: original,
        configurable: true,
      });
    });
  });

  describe("presence helpers", () => {
    it("computeSizeRatio returns bbox area / frame area", () => {
      const ratio = computeSizeRatio(
        { width: 100, height: 200 },
        { width: 1000, height: 1000 }
      );
      expect(ratio).toBeCloseTo(0.02, 4);
    });

    it("smoothSizeRatio averages last 5 frames", () => {
      const buf: number[] = [];
      expect(smoothSizeRatio(buf, 0.1)).toBeCloseTo(0.1, 4);
      expect(smoothSizeRatio(buf, 0.2)).toBeCloseTo(0.15, 4);
      expect(smoothSizeRatio(buf, 0.3)).toBeCloseTo(0.2, 4);
      expect(smoothSizeRatio(buf, 0.4)).toBeCloseTo(0.25, 4);
      expect(smoothSizeRatio(buf, 0.5)).toBeCloseTo(0.3, 4);
      expect(smoothSizeRatio(buf, 0.6)).toBeCloseTo(0.4, 4);
      expect(buf).toHaveLength(5);
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
