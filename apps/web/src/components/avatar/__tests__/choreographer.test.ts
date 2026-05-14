import { describe, it, expect } from "vitest";
import { nextChoreography, type ChoreographyInput } from "../choreographer";

const baseInput: ChoreographyInput = {
  presence: { detected: false, sizeRatio: 0, durationMs: 0 },
  speaking: false,
  narrationText: undefined,
  msSinceLastNarration: 99999,
  msInCurrentState: 0,
  bustOnly: false,
};

describe("choreographer bust_only short-circuit", () => {
  it("returns bust framing regardless of inputs when bustOnly is true", () => {
    const out = nextChoreography("idle_pacing", { ...baseInput, bustOnly: true }, 16);
    expect(out.state).toBe("talking");
    expect(out.cameraFraming).toBe("bust");
    expect(out.bodyZ).toBe(0);
    expect(out.bodyX).toBe(0);
    expect(out.animationClip).toBe("breathing");
  });

  it("returns bust even when person is detected and approaching in bustOnly mode", () => {
    const out = nextChoreography("idle_pacing", {
      ...baseInput,
      bustOnly: true,
      presence: { detected: true, sizeRatio: 0.5, durationMs: 5000 },
    }, 16);
    expect(out.cameraFraming).toBe("bust");
    expect(out.state).toBe("talking");
  });
});
