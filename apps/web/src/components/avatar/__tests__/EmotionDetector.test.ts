import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmotionDetector, classifyEmotion, type DetectedEmotion } from "../EmotionDetector";

// Mock @mediapipe/tasks-vision
vi.mock("@mediapipe/tasks-vision", () => ({
  FaceLandmarker: {
    createFromOptions: vi.fn(),
  },
  FilesetResolver: {
    forVisionTasks: vi.fn().mockResolvedValue({}),
  },
}));

describe("EmotionDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("mock mode", () => {
    it("should cycle through emotions in mock mode", () => {
      const emotions: DetectedEmotion[] = [];
      const detector = new EmotionDetector({
        onEmotion: (e) => emotions.push(e),
        mock: true,
        intervalMs: 200,
      });

      detector.start();

      // Each emotion lasts ~3s, so advance 15s to see all 5
      vi.advanceTimersByTime(15000);

      expect(emotions.length).toBeGreaterThan(0);

      // Should have seen multiple distinct emotions
      const unique = new Set(emotions);
      expect(unique.size).toBeGreaterThanOrEqual(3);

      detector.stop();
    });

    it("should report isMock() = true", () => {
      const detector = new EmotionDetector({ onEmotion: vi.fn(), mock: true });
      expect(detector.isMock()).toBe(true);
    });

    it("should stop emitting after stop()", () => {
      const emotions: DetectedEmotion[] = [];
      const detector = new EmotionDetector({
        onEmotion: (e) => emotions.push(e),
        mock: true,
        intervalMs: 200,
      });

      detector.start();
      vi.advanceTimersByTime(3500);
      const countBefore = emotions.length;

      detector.stop();
      vi.advanceTimersByTime(5000);

      expect(emotions.length).toBe(countBefore);
      expect(detector.isRunning()).toBe(false);
    });

    it("should not emit duplicate consecutive emotions", () => {
      const emotions: DetectedEmotion[] = [];
      const detector = new EmotionDetector({
        onEmotion: (e) => emotions.push(e),
        mock: true,
        intervalMs: 100,
      });

      detector.start();
      vi.advanceTimersByTime(16000);
      detector.stop();

      // No two consecutive entries should be the same
      for (let i = 1; i < emotions.length; i++) {
        expect(emotions[i]).not.toBe(emotions[i - 1]);
      }
    });
  });

  describe("classifyEmotion", () => {
    function makeBlendshapes(
      overrides: Record<string, number>
    ): Array<{ categoryName: string; score: number }> {
      const defaults: Record<string, number> = {
        mouthSmileLeft: 0,
        mouthSmileRight: 0,
        browDownLeft: 0,
        browDownRight: 0,
        browInnerUp: 0,
        browOuterUpLeft: 0,
        browOuterUpRight: 0,
        eyeWideLeft: 0,
        eyeWideRight: 0,
        jawOpen: 0,
        mouthPressLeft: 0,
        mouthPressRight: 0,
      };
      const merged = { ...defaults, ...overrides };
      return Object.entries(merged).map(([categoryName, score]) => ({
        categoryName,
        score,
      }));
    }

    it("should detect happy from smile", () => {
      const result = classifyEmotion(
        makeBlendshapes({ mouthSmileLeft: 0.6, mouthSmileRight: 0.6 })
      );
      expect(result).toBe("happy");
    });

    it("should detect surprised from brow raise + eye wide", () => {
      const result = classifyEmotion(
        makeBlendshapes({
          browOuterUpLeft: 0.5,
          browOuterUpRight: 0.5,
          browInnerUp: 0.5,
          eyeWideLeft: 0.5,
          eyeWideRight: 0.5,
        })
      );
      expect(result).toBe("surprised");
    });

    it("should detect concerned from brow furrow + lip press", () => {
      const result = classifyEmotion(
        makeBlendshapes({
          browDownLeft: 0.5,
          browDownRight: 0.5,
          mouthPressLeft: 0.4,
          mouthPressRight: 0.4,
        })
      );
      expect(result).toBe("concerned");
    });

    it("should detect focused from brow down + closed mouth", () => {
      const result = classifyEmotion(
        makeBlendshapes({
          browDownLeft: 0.4,
          browDownRight: 0.4,
          jawOpen: 0.0,
        })
      );
      expect(result).toBe("focused");
    });

    it("should return neutral for relaxed face", () => {
      const result = classifyEmotion(makeBlendshapes({}));
      expect(result).toBe("neutral");
    });

    it("should prioritize happy over other emotions", () => {
      // Smile overrides brow signals
      const result = classifyEmotion(
        makeBlendshapes({
          mouthSmileLeft: 0.7,
          mouthSmileRight: 0.7,
          browDownLeft: 0.5,
          browDownRight: 0.5,
        })
      );
      expect(result).toBe("happy");
    });
  });

  describe("MediaPipe mode (fallback)", () => {
    it("should fallback to mock when MediaPipe fails", async () => {
      vi.doMock("@mediapipe/tasks-vision", () => {
        throw new Error("WASM not available");
      });

      const detector = new EmotionDetector({
        onEmotion: vi.fn(),
        mock: false,
        intervalMs: 200,
      });

      await detector.start();

      expect(detector.isMock()).toBe(true);
      expect(detector.isRunning()).toBe(true);

      detector.stop();
    });
  });
});
