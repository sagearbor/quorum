import { describe, it, expect } from "vitest";
import {
  computeRMS,
  computeRawYaw,
  ema,
  yawToDirection,
} from "../StereoAnalyzer";

describe("StereoAnalyzer pure functions", () => {
  describe("computeRMS", () => {
    it("returns 0 for silence", () => {
      const data = new Float32Array(128).fill(0);
      expect(computeRMS(data)).toBe(0);
    });

    it("returns correct RMS for uniform signal", () => {
      const data = new Float32Array(128).fill(0.5);
      const expected = Math.sqrt(0.25); // sqrt(0.5^2) = 0.5
      expect(computeRMS(data)).toBeCloseTo(expected, 5);
    });

    it("returns correct RMS for mixed signal", () => {
      const data = new Float32Array(4);
      data[0] = 1;
      data[1] = -1;
      data[2] = 1;
      data[3] = -1;
      // RMS = sqrt((1+1+1+1)/4) = 1
      expect(computeRMS(data)).toBeCloseTo(1, 5);
    });
  });

  describe("computeRawYaw", () => {
    it("returns -0.6 when left is louder by threshold", () => {
      // left > right * 1.3
      expect(computeRawYaw(0.5, 0.3, 1.3)).toBe(-0.6); // 0.5 > 0.3 * 1.3 = 0.39
    });

    it("returns +0.6 when right is louder by threshold", () => {
      // right > left * 1.3
      expect(computeRawYaw(0.3, 0.5, 1.3)).toBe(0.6); // 0.5 > 0.3 * 1.3 = 0.39
    });

    it("returns 0 when roughly balanced", () => {
      expect(computeRawYaw(0.5, 0.5, 1.3)).toBe(0);
    });

    it("returns 0 when both channels are silent", () => {
      expect(computeRawYaw(0, 0, 1.3)).toBe(0);
    });

    it("returns 0 when difference is below threshold", () => {
      // 0.4 vs 0.35: 0.4 > 0.35*1.3=0.455? No. 0.35 > 0.4*1.3=0.52? No. → center
      expect(computeRawYaw(0.4, 0.35, 1.3)).toBe(0);
    });
  });

  describe("ema", () => {
    it("returns current value when alpha=1", () => {
      expect(ema(0.5, 0.8, 1.0)).toBeCloseTo(0.8, 5);
    });

    it("returns previous value when alpha=0", () => {
      expect(ema(0.5, 0.8, 0.0)).toBeCloseTo(0.5, 5);
    });

    it("blends values with alpha=0.15", () => {
      const result = ema(0, 0.6, 0.15);
      // 0.15 * 0.6 + 0.85 * 0 = 0.09
      expect(result).toBeCloseTo(0.09, 5);
    });

    it("converges over multiple steps", () => {
      let val = 0;
      for (let i = 0; i < 50; i++) {
        val = ema(val, 1.0, 0.15);
      }
      // After 50 steps toward 1.0, should be very close
      expect(val).toBeGreaterThan(0.99);
    });
  });

  describe("yawToDirection", () => {
    it("returns 'left' for negative yaw beyond threshold", () => {
      expect(yawToDirection(-0.3)).toBe("left");
      expect(yawToDirection(-0.6)).toBe("left");
      expect(yawToDirection(-1.0)).toBe("left");
    });

    it("returns 'right' for positive yaw beyond threshold", () => {
      expect(yawToDirection(0.3)).toBe("right");
      expect(yawToDirection(0.6)).toBe("right");
      expect(yawToDirection(1.0)).toBe("right");
    });

    it("returns 'center' for yaw near zero", () => {
      expect(yawToDirection(0)).toBe("center");
      expect(yawToDirection(0.1)).toBe("center");
      expect(yawToDirection(-0.1)).toBe("center");
      expect(yawToDirection(0.19)).toBe("center");
      expect(yawToDirection(-0.19)).toBe("center");
    });

    it("boundary: +-0.2 is center", () => {
      expect(yawToDirection(0.2)).toBe("center");
      expect(yawToDirection(-0.2)).toBe("center");
    });
  });
});
