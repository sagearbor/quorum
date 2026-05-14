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

describe("choreographer idle → approach", () => {
  it("stays in idle_pacing when no person detected", () => {
    const out = nextChoreography("idle_pacing", baseInput, 16);
    expect(out.state).toBe("idle_pacing");
    expect(out.cameraFraming).toBe("full_body");
  });

  it("stays in idle_pacing when person detected briefly", () => {
    const out = nextChoreography("idle_pacing", {
      ...baseInput,
      presence: { detected: true, sizeRatio: 0.20, durationMs: 1000 },
    }, 16);
    expect(out.state).toBe("idle_pacing");
  });

  it("stays in idle_pacing when person detected long enough but too small", () => {
    const out = nextChoreography("idle_pacing", {
      ...baseInput,
      presence: { detected: true, sizeRatio: 0.10, durationMs: 5000 },
    }, 16);
    expect(out.state).toBe("idle_pacing");
  });

  it("transitions to approach when person sustained > 15% area for > 2s", () => {
    const out = nextChoreography("idle_pacing", {
      ...baseInput,
      presence: { detected: true, sizeRatio: 0.20, durationMs: 2500 },
    }, 16);
    expect(out.state).toBe("approach");
    expect(out.animationClip).toBe("walking");
  });
});

describe("choreographer approach → talking", () => {
  const inApproach = {
    ...baseInput,
    presence: { detected: true, sizeRatio: 0.30, durationMs: 3000 },
  };

  it("ramps bodyZ from 0 toward 0.6 over msInCurrentState", () => {
    const early = nextChoreography("approach", { ...inApproach, msInCurrentState: 0 }, 16);
    expect(early.state).toBe("approach");
    expect(early.bodyZ).toBeCloseTo(0, 2);

    const mid = nextChoreography("approach", { ...inApproach, msInCurrentState: 750 }, 16);
    expect(mid.bodyZ).toBeCloseTo(0.3, 1);

    const end = nextChoreography("approach", { ...inApproach, msInCurrentState: 1500 }, 16);
    expect(end.bodyZ).toBeCloseTo(0.6, 2);
  });

  it("camera framing lerps full_body → bust during approach", () => {
    const mid = nextChoreography("approach", { ...inApproach, msInCurrentState: 1500 }, 16);
    expect(mid.cameraFraming).toBe("bust");
  });

  it("transitions to talking when narration arrives", () => {
    const out = nextChoreography("approach", {
      ...inApproach,
      narrationText: "Welcome to the demo",
      msSinceLastNarration: 0,
    }, 16);
    expect(out.state).toBe("talking");
  });

  it("transitions to talking when approach ramp completes even without narration", () => {
    const out = nextChoreography("approach", {
      ...inApproach,
      msInCurrentState: 1600,
    }, 16);
    expect(out.state).toBe("talking");
  });
});

describe("choreographer talking → retreating", () => {
  const inTalking = {
    ...baseInput,
    presence: { detected: true, sizeRatio: 0.30, durationMs: 8000 },
    speaking: true,
    narrationText: "Welcome",
    msSinceLastNarration: 100,
  };

  it("stays in talking while speaking", () => {
    const out = nextChoreography("talking", inTalking, 16);
    expect(out.state).toBe("talking");
    expect(out.cameraFraming).toBe("bust");
  });

  it("stays in talking when 4s of silence + still speaking", () => {
    const out = nextChoreography("talking", {
      ...inTalking,
      msSinceLastNarration: 4000,
    }, 16);
    expect(out.state).toBe("talking");
  });

  it("transitions to retreating after 5s silence + TTS ended", () => {
    const out = nextChoreography("talking", {
      ...inTalking,
      msSinceLastNarration: 5500,
      speaking: false,
    }, 16);
    expect(out.state).toBe("retreating");
  });

  it("transitions to retreating immediately when person leaves frame", () => {
    const out = nextChoreography("talking", {
      ...inTalking,
      presence: { detected: false, sizeRatio: 0.02, durationMs: 0 },
    }, 16);
    expect(out.state).toBe("retreating");
  });
});
