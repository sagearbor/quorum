# Avatar Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the off-putting full-body slide in the facilitator avatar with a vision-aware four-state choreography (`idle_pacing → approach → talking → retreating`), add a `bust` camera framing, drive lip-sync via lightweight visemes, and gate the whole thing behind a `NEXT_PUBLIC_AVATAR_CHOREOGRAPHY` env flag so the expo can fall back to a safe bust-only mode.

**Architecture:** A pure-TS `choreographer.ts` state machine consumes vision-presence + speaking state and outputs target framing, body position, and animation clip. `IdleScene.tsx` exposes new imperative methods (`setFraming`, `setBodyPose`, `setMouthShape`) and crossfades a Mixamo Walk clip against the existing breathing idle. `useAvatarController.ts` is the integration point. `VisionTracker.ts` extends its callback to emit a `presence` payload (the bbox size we already compute but discard).

**Tech Stack:** Next.js 14, TypeScript, React Three Fiber + Three.js (raw, not R3F components), Vitest + jsdom + React Testing Library, MediaPipe Tasks Vision (existing), Web Audio API (AnalyserNode for visemes).

**Spec:** `docs/superpowers/specs/2026-05-14-avatar-rework-design.md`

**Branch:** `feat/avatar-rework` (already created, contains the spec commits).

---

## Pre-flight checklist

- [ ] **Confirm working branch is `feat/avatar-rework`**

```bash
git branch --show-current
```
Expected: `feat/avatar-rework`. If not, `git checkout feat/avatar-rework`.

- [ ] **Confirm dev server can boot**

```bash
pnpm install && pnpm --filter web dev
```
Expected: server on http://localhost:3000. Then `Ctrl+C` to stop — we'll restart per task.

- [ ] **Confirm test runner works**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/
```
Expected: existing avatar tests pass. Note any pre-existing failures and inform Sophie before continuing — we don't want to attribute them to this work.

---

## Task 1: VisionTracker presence payload

**Files:**
- Modify: `apps/web/src/components/avatar/VisionTracker.ts`
- Test: `apps/web/src/components/avatar/__tests__/VisionTracker.test.ts` (create if missing)

The bbox `width * height / (frameW * frameH)` is already computed inside the largest-detection picker (around `VisionTracker.ts:160-189`) but discarded. Surface it as a smoothed `sizeRatio` plus a presence-duration counter, on the existing `onGaze` callback.

- [ ] **Step 1: Read existing VisionTracker to confirm bbox-size location**

```bash
grep -n "boundingBox\|width\|height" apps/web/src/components/avatar/VisionTracker.ts | head -20
```
Note the exact line where the largest detection's bbox is computed.

- [ ] **Step 2: Write failing test for the presence payload**

Create or extend `apps/web/src/components/avatar/__tests__/VisionTracker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeSizeRatio, smoothSizeRatio } from "../VisionTracker";

describe("VisionTracker presence helpers", () => {
  it("computeSizeRatio returns bbox area / frame area", () => {
    const ratio = computeSizeRatio({ width: 100, height: 200 }, { width: 1000, height: 1000 });
    expect(ratio).toBeCloseTo(0.02, 4);
  });

  it("smoothSizeRatio averages last 5 frames", () => {
    const buf: number[] = [];
    expect(smoothSizeRatio(buf, 0.10)).toBeCloseTo(0.10, 4);
    expect(smoothSizeRatio(buf, 0.20)).toBeCloseTo(0.15, 4);
    expect(smoothSizeRatio(buf, 0.30)).toBeCloseTo(0.20, 4);
    expect(smoothSizeRatio(buf, 0.40)).toBeCloseTo(0.25, 4);
    expect(smoothSizeRatio(buf, 0.50)).toBeCloseTo(0.30, 4);
    expect(smoothSizeRatio(buf, 0.60)).toBeCloseTo(0.40, 4);
    expect(buf).toHaveLength(5);
  });
});
```

- [ ] **Step 3: Run test to confirm it fails**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/VisionTracker.test.ts
```
Expected: FAIL — `computeSizeRatio is not a function`.

- [ ] **Step 4: Add the helpers + presence payload to VisionTracker.ts**

In `apps/web/src/components/avatar/VisionTracker.ts`, add these exports near the top:

```ts
export function computeSizeRatio(bbox: { width: number; height: number }, frame: { width: number; height: number }): number {
  return (bbox.width * bbox.height) / (frame.width * frame.height);
}

export function smoothSizeRatio(buffer: number[], next: number): number {
  buffer.push(next);
  if (buffer.length > 5) buffer.shift();
  return buffer.reduce((a, b) => a + b, 0) / buffer.length;
}
```

Then extend the existing `onGaze` callback signature. Find the call site (search for `onGaze(`) and add the second arg:

```ts
onGaze(yaw, pitch, {
  detected: true,
  sizeRatio: smoothSizeRatio(this.sizeBuf, computeSizeRatio(bbox, frame)),
  durationMs: this.presenceDurationMs,
});
```

Add `private sizeBuf: number[] = [];` and `private presenceDurationMs = 0;` to the class. Increment `presenceDurationMs` when detected, reset to 0 when not detected.

Update the callback type:

```ts
export type GazeCallback = (
  yaw: number,
  pitch: number,
  presence?: { detected: boolean; sizeRatio: number; durationMs: number }
) => void;
```

The optional `?` keeps existing callers working.

- [ ] **Step 5: Run tests to confirm pass**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/VisionTracker.test.ts
```
Expected: PASS.

- [ ] **Step 6: Run the full avatar test suite to confirm no regressions**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/
```
Expected: all pass (modulo any pre-existing failures noted in pre-flight).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/avatar/VisionTracker.ts apps/web/src/components/avatar/__tests__/VisionTracker.test.ts
git commit -m "feat(avatar): VisionTracker emits smoothed presence payload

Surfaces bbox size ratio (already computed but discarded) plus
presence duration on the existing onGaze callback. 5-frame moving
average to absorb detection jitter. Existing callers unaffected
(presence is optional)."
```

---

## Task 2: Choreographer types and the bust_only short-circuit

**Files:**
- Create: `apps/web/src/components/avatar/choreographer.ts`
- Test: `apps/web/src/components/avatar/__tests__/choreographer.test.ts`

Pure state machine. No DOM, no React. Start with the easiest case: `bust_only` → bust framing always.

- [ ] **Step 1: Write failing test for bust_only short-circuit**

Create `apps/web/src/components/avatar/__tests__/choreographer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/choreographer.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create choreographer.ts with types + bust_only branch**

```ts
// apps/web/src/components/avatar/choreographer.ts

export type ChoreographyState = "idle_pacing" | "approach" | "talking" | "retreating";

export interface ChoreographyInput {
  presence: { detected: boolean; sizeRatio: number; durationMs: number };
  speaking: boolean;
  narrationText: string | undefined;
  msSinceLastNarration: number;
  msInCurrentState: number;
  bustOnly: boolean;
}

export interface ChoreographyOutput {
  state: ChoreographyState;
  cameraFraming: "full_body" | "bust";
  bodyZ: number;
  bodyX: number;
  animationClip: "breathing" | "walking";
}

const APPROACH_TRIGGER_SIZE = 0.15;
const APPROACH_RELEASE_SIZE = 0.05;
const APPROACH_TRIGGER_MS = 2000;
const RETREAT_AFTER_MS = 5000;

export function nextChoreography(
  prev: ChoreographyState,
  input: ChoreographyInput,
  _dtMs: number
): ChoreographyOutput {
  if (input.bustOnly) {
    return {
      state: "talking",
      cameraFraming: "bust",
      bodyZ: 0,
      bodyX: 0,
      animationClip: "breathing",
    };
  }

  // Full choreography logic added in subsequent tasks.
  return {
    state: prev,
    cameraFraming: "full_body",
    bodyZ: 0,
    bodyX: 0,
    animationClip: "breathing",
  };
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/choreographer.test.ts
```
Expected: PASS (both tests in the bust_only describe).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/avatar/choreographer.ts apps/web/src/components/avatar/__tests__/choreographer.test.ts
git commit -m "feat(avatar): choreographer skeleton with bust_only short-circuit

Pure-TS state machine. bust_only=true short-circuits to bust
framing immediately — the expo safety net. Full state machine
in subsequent tasks."
```

---

## Task 3: Choreographer — idle_pacing → approach transition

**Files:**
- Modify: `apps/web/src/components/avatar/choreographer.ts`
- Test: `apps/web/src/components/avatar/__tests__/choreographer.test.ts`

Person detected at sizeRatio > 0.15 for >2s → enter `approach`.

- [ ] **Step 1: Write failing tests**

Add a new `describe` block to `choreographer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to confirm only the last fails**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/choreographer.test.ts
```
Expected: 3 of 4 in the new describe pass; the "transitions to approach" one FAILS.

- [ ] **Step 3: Implement the transition**

Update `nextChoreography` in `choreographer.ts`. Replace the `// Full choreography logic added in subsequent tasks.` placeholder block:

```ts
  // idle_pacing → approach
  if (prev === "idle_pacing") {
    if (
      input.presence.detected &&
      input.presence.sizeRatio > APPROACH_TRIGGER_SIZE &&
      input.presence.durationMs > APPROACH_TRIGGER_MS
    ) {
      return {
        state: "approach",
        cameraFraming: "full_body",
        bodyZ: 0,
        bodyX: 0,
        animationClip: "walking",
      };
    }
    return {
      state: "idle_pacing",
      cameraFraming: "full_body",
      bodyZ: 0,
      bodyX: 0,
      animationClip: "walking",
    };
  }

  // Other states added in subsequent tasks.
  return {
    state: prev,
    cameraFraming: "full_body",
    bodyZ: 0,
    bodyX: 0,
    animationClip: "breathing",
  };
```

- [ ] **Step 4: Run tests, expect all pass**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/choreographer.test.ts
```
Expected: PASS for all in this describe + bust_only describe.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/avatar/choreographer.ts apps/web/src/components/avatar/__tests__/choreographer.test.ts
git commit -m "feat(avatar): choreographer idle_pacing → approach transition

Person sustained >15% frame area for >2s triggers approach state."
```

---

## Task 4: Choreographer — approach → talking transition + bodyZ ramp

**Files:**
- Modify: `apps/web/src/components/avatar/choreographer.ts`
- Test: `apps/web/src/components/avatar/__tests__/choreographer.test.ts`

In `approach`, the avatar walks forward (`bodyZ` ramps from 0 → 0.6 over ~1.5s). When narration arrives OR the ramp completes, we transition to `talking`.

- [ ] **Step 1: Write failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to confirm failures in this describe**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/choreographer.test.ts
```

- [ ] **Step 3: Add the approach branch + APPROACH_RAMP_MS constant**

At the top of `choreographer.ts`, add:

```ts
const APPROACH_RAMP_MS = 1500;
const APPROACH_BODY_Z = 0.6;
```

Add the approach branch inside `nextChoreography`, before the `// Other states` fallback:

```ts
  if (prev === "approach") {
    const t = Math.min(1, input.msInCurrentState / APPROACH_RAMP_MS);
    const bodyZ = APPROACH_BODY_Z * t;

    if (input.narrationText !== undefined && input.msSinceLastNarration < 100) {
      return {
        state: "talking",
        cameraFraming: "bust",
        bodyZ: APPROACH_BODY_Z,
        bodyX: 0,
        animationClip: "breathing",
      };
    }
    if (t >= 1) {
      return {
        state: "talking",
        cameraFraming: "bust",
        bodyZ: APPROACH_BODY_Z,
        bodyX: 0,
        animationClip: "breathing",
      };
    }
    return {
      state: "approach",
      cameraFraming: t > 0.5 ? "bust" : "full_body",
      bodyZ,
      bodyX: 0,
      animationClip: "walking",
    };
  }
```

- [ ] **Step 4: Run tests, expect pass**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/choreographer.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/avatar/choreographer.ts apps/web/src/components/avatar/__tests__/choreographer.test.ts
git commit -m "feat(avatar): choreographer approach state with bodyZ ramp"
```

---

## Task 5: Choreographer — talking → retreating transition

**Files:**
- Modify: `apps/web/src/components/avatar/choreographer.ts`
- Test: `apps/web/src/components/avatar/__tests__/choreographer.test.ts`

Stay in `talking` while narration is recent. Transition to `retreating` when 5s elapses with no new narration AND TTS has ended (signalled by `speaking === false`). Person leaving immediately also triggers retreat.

- [ ] **Step 1: Write failing tests**

```ts
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
```

- [ ] **Step 2: Run, confirm new tests fail**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/choreographer.test.ts
```

- [ ] **Step 3: Add the talking branch**

Insert before the `// Other states` fallback in `choreographer.ts`:

```ts
  if (prev === "talking") {
    const personLeft =
      !input.presence.detected || input.presence.sizeRatio < APPROACH_RELEASE_SIZE;
    const ttsIdle =
      !input.speaking && input.msSinceLastNarration > RETREAT_AFTER_MS;

    if (personLeft || ttsIdle) {
      return {
        state: "retreating",
        cameraFraming: "full_body",
        bodyZ: APPROACH_BODY_Z,
        bodyX: 0,
        animationClip: "walking",
      };
    }
    return {
      state: "talking",
      cameraFraming: "bust",
      bodyZ: APPROACH_BODY_Z,
      bodyX: 0,
      animationClip: "breathing",
    };
  }
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/choreographer.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/avatar/choreographer.ts apps/web/src/components/avatar/__tests__/choreographer.test.ts
git commit -m "feat(avatar): choreographer talking → retreating transition"
```

---

## Task 6: Choreographer — retreating → idle_pacing + idle bodyX sine

**Files:**
- Modify: `apps/web/src/components/avatar/choreographer.ts`
- Test: `apps/web/src/components/avatar/__tests__/choreographer.test.ts`

Retreating walks `bodyZ` back to 0 over ~1.2s, then returns to `idle_pacing`. While in `idle_pacing`, `bodyX` traces a sine wave for the L↔R walk.

- [ ] **Step 1: Write failing tests**

```ts
describe("choreographer retreating + idle pacing", () => {
  it("ramps bodyZ from 0.6 → 0 during retreating", () => {
    const early = nextChoreography("retreating", {
      ...baseInput,
      msInCurrentState: 0,
    }, 16);
    expect(early.bodyZ).toBeCloseTo(0.6, 2);

    const end = nextChoreography("retreating", {
      ...baseInput,
      msInCurrentState: 1200,
    }, 16);
    expect(end.bodyZ).toBeCloseTo(0, 2);
  });

  it("returns to idle_pacing when retreat ramp completes", () => {
    const out = nextChoreography("retreating", {
      ...baseInput,
      msInCurrentState: 1300,
    }, 16);
    expect(out.state).toBe("idle_pacing");
  });

  it("idle_pacing bodyX traces a sine wave", () => {
    // 10s period, 0.6 amplitude. At t=2500ms (quarter period) bodyX should be 0.6.
    const peak = nextChoreography("idle_pacing", {
      ...baseInput,
      msInCurrentState: 2500,
    }, 16);
    expect(peak.bodyX).toBeCloseTo(0.6, 1);

    // At t=5000ms (half period) bodyX returns to 0.
    const zero = nextChoreography("idle_pacing", {
      ...baseInput,
      msInCurrentState: 5000,
    }, 16);
    expect(zero.bodyX).toBeCloseTo(0, 1);
  });
});
```

- [ ] **Step 2: Run, confirm failures**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/choreographer.test.ts
```

- [ ] **Step 3: Implement retreating branch + idle bodyX sine**

Add at the top of `choreographer.ts`:

```ts
const RETREAT_RAMP_MS = 1200;
const PACE_PERIOD_MS = 10000;
const PACE_AMPLITUDE = 0.6;
```

Replace the existing `idle_pacing` return block (the steady-state one, not the one that transitions to approach) so `bodyX` becomes:

```ts
    return {
      state: "idle_pacing",
      cameraFraming: "full_body",
      bodyZ: 0,
      bodyX: Math.sin((input.msInCurrentState / PACE_PERIOD_MS) * 2 * Math.PI) * PACE_AMPLITUDE,
      animationClip: "walking",
    };
```

Add the retreating branch before the fallback:

```ts
  if (prev === "retreating") {
    const t = Math.min(1, input.msInCurrentState / RETREAT_RAMP_MS);
    const bodyZ = APPROACH_BODY_Z * (1 - t);

    if (t >= 1) {
      return {
        state: "idle_pacing",
        cameraFraming: "full_body",
        bodyZ: 0,
        bodyX: 0,
        animationClip: "walking",
      };
    }
    return {
      state: "retreating",
      cameraFraming: "full_body",
      bodyZ,
      bodyX: 0,
      animationClip: "walking",
    };
  }
```

- [ ] **Step 4: Run, expect all choreographer tests pass**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/choreographer.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/avatar/choreographer.ts apps/web/src/components/avatar/__tests__/choreographer.test.ts
git commit -m "feat(avatar): choreographer retreating + idle bodyX sine

State machine is now feature-complete and round-trips
idle → approach → talking → retreating → idle."
```

---

## Task 7: IdleScene — add `bust` camera preset + delete sine-wave slide

**Files:**
- Modify: `apps/web/src/components/avatar/IdleScene.tsx`

Two changes: (1) add `bust` to `CAMERA_PRESETS`, (2) delete the X-axis sine-wave slide system (`PACE_AMPLITUDE`, `PACE_PERIOD_MS`, `PACE_YAW`, `paceElapsedS`, the `pacingSuppressed` branch). The choreographer drives bodyX now.

- [ ] **Step 1: Read the existing pacing block to know what to remove**

```bash
sed -n '70,80p;310,425p' apps/web/src/components/avatar/IdleScene.tsx
```
Note the constants block (~lines 73-78) and the pacing branch in `animate` (~lines 395-422).

- [ ] **Step 2: Add `bust` to `CameraMode` and `CAMERA_PRESETS`**

In `IdleScene.tsx`, change the type:

```ts
export type CameraMode = "full_body" | "torso" | "bust";
```

Add the new preset to `CAMERA_PRESETS`:

```ts
  bust: {
    position: [0, 1.62, 1.15],
    lookAt: [0, 1.6, 0],
    fov: 24,
  },
```

- [ ] **Step 3: Delete the sine-wave slide constants**

Remove these lines from `IdleScene.tsx`:

```ts
const PACE_PERIOD_MS = 10_000;
const PACE_AMPLITUDE = 0.3;
const PACE_YAW = 0.08;
```

Also remove `SETTLE_TO_CENTER_MS` if it's only used by the pacing system (search uses first):

```bash
grep -n "SETTLE_TO_CENTER_MS" apps/web/src/components/avatar/IdleScene.tsx
```
If it's only referenced by the deleted pacing code, remove that constant too.

- [ ] **Step 4: Delete the sine-wave block in the `animate` function**

Find the section starting with `// ─── Idle pacing` and ending before `// Re-apply lookAt every frame`. Remove the entire `if (avatarRoot) { ... }` block that handles `pacingSuppressed` and X-axis sine.

Also remove the `let paceElapsedS = 0;` and `let lastPaceX = 0;` and `let bodyYaw = 0;` declarations near the top of `animate`.

The avatar root's position will be set externally via the new `setBodyPose` method (added in Task 8), so the animate loop should leave `avatarRoot.position` and `.rotation` alone.

- [ ] **Step 5: Run dev server and visually verify the avatar no longer slides**

```bash
pnpm --filter web dev
```
Open http://localhost:3000/event/duke-expo-2026/quorum/c6c4f8ba-1f98-48b1-bc4c-ec346b9fae24?station=1.
Expected: avatar stands still (breathing only), no horizontal slide. The off-putting motion should be gone. Stop the dev server with `Ctrl+C`.

- [ ] **Step 6: Run avatar tests, confirm no regressions**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/avatar/IdleScene.tsx
git commit -m "feat(avatar): add bust camera preset + remove sine-wave slide

The off-putting full-body slide (sine-wave X translation with
no walking animation) is gone. Avatar now stands still while
the choreographer (next task) drives any motion."
```

This commit alone resolves the user-visible production bug. The remaining tasks add the choreography on top.

---

## Task 8: IdleScene — expose setFraming, setBodyPose, setMouthShape on handle

**Files:**
- Modify: `apps/web/src/components/avatar/IdleScene.tsx`

Replace the `cameraMode` prop pattern with imperative handle methods. The controller drives framing per-frame instead of via React prop changes.

- [ ] **Step 1: Extend the IdleSceneHandle interface**

```ts
export interface IdleSceneHandle {
  setGaze: (yaw: number, pitch?: number) => void;
  setEmotion: (emotion: DetectedEmotion) => void;
  setFraming: (mode: CameraMode) => void;
  setBodyPose: (pose: { x: number; z: number; clip: "breathing" | "walking" }) => void;
  setMouthShape: (shape: { jawOpen: number; mouthFunnel: number; mouthPucker: number; mouthSmile: number; mouthClose: number } | null) => void;
}
```

- [ ] **Step 2: Add imperative refs for the new state**

In the IdleScene component body, add:

```ts
const framingRef = useRef<CameraMode>("full_body");
const bodyPoseRef = useRef<{ x: number; z: number; clip: "breathing" | "walking" }>({ x: 0, z: 0, clip: "breathing" });
const mouthShapeRef = useRef<{ jawOpen: number; mouthFunnel: number; mouthPucker: number; mouthSmile: number; mouthClose: number } | null>(null);
```

Update `useImperativeHandle`:

```ts
useImperativeHandle(ref, () => ({
  setGaze: (y, p) => { /* existing */ },
  setEmotion: (e) => { /* existing */ },
  setFraming: (mode) => {
    if (framingRef.current === mode) return;
    const fromPreset = CAMERA_PRESETS[framingRef.current];
    const toPreset = CAMERA_PRESETS[mode];
    framingRef.current = mode;
    lerpRef.current = {
      from: fromPreset,
      to: toPreset,
      settleRemainingMs: 0,
      lerpRemainingMs: CAMERA_LERP_MS,
      totalLerpMs: CAMERA_LERP_MS,
    };
  },
  setBodyPose: (pose) => { bodyPoseRef.current = pose; },
  setMouthShape: (shape) => { mouthShapeRef.current = shape; },
}));
```

- [ ] **Step 3: Apply bodyPoseRef in the animate loop**

In the `animate` function, after the camera lerp section, add:

```ts
if (avatarRoot) {
  // External controller drives X / Z; we just lerp toward the target.
  const target = bodyPoseRef.current;
  avatarRoot.position.x += (target.x - avatarRoot.position.x) * 0.1;
  avatarRoot.position.z += (target.z - avatarRoot.position.z) * 0.1;
}
```

- [ ] **Step 4: Apply mouthShapeRef in the animate loop**

Add after the eye-morph section:

```ts
if (skinnedMesh?.morphTargetDictionary && skinnedMesh.morphTargetInfluences) {
  const dict = skinnedMesh.morphTargetDictionary;
  const infl = skinnedMesh.morphTargetInfluences;
  const shape = mouthShapeRef.current;
  for (const key of ["jawOpen", "mouthFunnel", "mouthPucker", "mouthSmile", "mouthClose"] as const) {
    if (dict[key] !== undefined) {
      infl[dict[key]] = shape ? shape[key] : 0;
    }
  }
}
```

- [ ] **Step 5: Drop the legacy `cameraMode` prop driven react effect**

Remove the existing `useEffect` that watches `props.cameraMode` and starts a lerp — the new `setFraming` handle replaces it. Also remove the `cameraMode` prop from `IdleSceneProps` interface and the destructured init in the mount path (initial preset comes from `framingRef.current` default).

- [ ] **Step 6: Run avatar tests, expect any test that mounted IdleScene with `cameraMode` prop to fail**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/
```
Expected: test failures. Note them — they get fixed in Task 11 when we update AvatarPanel.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/avatar/IdleScene.tsx
git commit -m "feat(avatar): IdleScene exposes imperative handle for framing + body + mouth

Replaces the cameraMode prop with setFraming. Adds setBodyPose
for choreographer-driven X/Z and setMouthShape for visemes.
AvatarPanel wiring updated in a later task."
```

---

## Task 9: Mixamo Walk clip integration

**Files:**
- Create: `apps/web/public/animations/walk.glb` (downloaded from Mixamo)
- Modify: `apps/web/src/components/avatar/IdleScene.tsx`

The Mixamo Walk clip plays in addition to the GLB's bundled breathing animation. The mixer crossfades between them based on `bodyPoseRef.current.clip`.

- [ ] **Step 1: Download the Walk clip from Mixamo**

Manual step (one-time):
1. Go to https://www.mixamo.com (free Adobe account)
2. Search "Walk", pick a neutral medium-paced loop
3. Download settings: Format = "glTF Binary (.glb)", Skin = "Without Skin", Frames per Second = 30, Keyframe Reduction = "none"
4. Save as `apps/web/public/animations/walk.glb`

If you do not have access to Mixamo: alternative source is https://www.cgtrader.com (search "humanoid walk glb free"). The clip just needs to target the standard Mixamo / RPM humanoid bone naming.

- [ ] **Step 2: Verify file is in place**

```bash
ls -la apps/web/public/animations/walk.glb
```
Expected: file exists, > 50 KB.

- [ ] **Step 3: Load the walk clip alongside the avatar GLB**

In `IdleScene.tsx`, after the existing `loader.load(props.glbUrl, ...)` block, add:

```ts
let walkAction: any = null;
let breathingAction: any = null;

if (mixer && gltf.animations.length > 0) {
  breathingAction = mixer.clipAction(gltf.animations[0]);
  breathingAction.play();
}

try {
  const walkGltf = await new Promise<any>((resolve, reject) => {
    loader.load("/animations/walk.glb", resolve, undefined, reject);
  });
  if (walkGltf.animations.length > 0 && mixer) {
    walkAction = mixer.clipAction(walkGltf.animations[0]);
    walkAction.setEffectiveWeight(0); // start hidden — breathing leads
    walkAction.play();
  }
} catch {
  // walk clip optional — falls back to breathing-only
}
```

- [ ] **Step 4: Crossfade in the animate loop**

In the animate function, after `if (mixer) mixer.update(delta);`, add:

```ts
if (walkAction && breathingAction) {
  const targetWalkWeight = bodyPoseRef.current.clip === "walking" ? 1 : 0;
  const currentWeight = walkAction.getEffectiveWeight();
  const newWeight = currentWeight + (targetWalkWeight - currentWeight) * 0.05;
  walkAction.setEffectiveWeight(newWeight);
  breathingAction.setEffectiveWeight(1 - newWeight);
}
```

- [ ] **Step 5: Run dev server, visually verify the walk clip plays when the choreographer requests it**

Since the choreographer isn't wired yet (next task), temporarily test by setting `bodyPoseRef.current.clip = "walking"` in a console expression. Or skip visual verification until Task 10 completes, just confirm the clip loads.

```bash
pnpm --filter web dev
```
Open the browser console — expect no errors about the walk.glb load. Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add apps/web/public/animations/walk.glb apps/web/src/components/avatar/IdleScene.tsx
git commit -m "feat(avatar): load Mixamo Walk clip + crossfade with breathing

bodyPoseRef.current.clip drives the mixer weight. Choreographer
output (next task) will toggle this on per-frame transitions."
```

---

## Task 10: useAvatarController — wire choreographer + feature flag

**Files:**
- Modify: `apps/web/src/components/avatar/useAvatarController.ts`

The controller becomes the integration point. It (a) tracks msInCurrentState and msSinceLastNarration, (b) reads the env flag, (c) calls `nextChoreography` per RAF, (d) routes outputs to the IdleSceneHandle.

- [ ] **Step 1: Read the existing useAvatarController to find the RAF / state hook pattern**

```bash
grep -n "useEffect\|requestAnimationFrame\|cameraMode\|speaking" apps/web/src/components/avatar/useAvatarController.ts | head -30
```

- [ ] **Step 2: Add the flag-reading + choreographer state refs**

Near the top of the controller:

```ts
import { nextChoreography, type ChoreographyState } from "./choreographer";

const BUST_ONLY = (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_AVATAR_CHOREOGRAPHY === "bust_only");
```

Inside the hook body, add refs:

```ts
const choreoStateRef = useRef<ChoreographyState>("idle_pacing");
const msInStateRef = useRef(0);
const msSinceNarrationRef = useRef(99999);
const lastTickRef = useRef(performance.now());
const presenceRef = useRef({ detected: false, sizeRatio: 0, durationMs: 0 });
```

- [ ] **Step 3: Update presence from VisionTracker**

Find where `onGaze` is wired and extend the callback to also write to `presenceRef.current` from the new third arg:

```ts
visionTracker.onGaze((yaw, pitch, presence) => {
  // ... existing yaw/pitch handling ...
  if (presence) presenceRef.current = presence;
});
```

- [ ] **Step 4: Add a per-RAF choreographer tick**

Add a useEffect with a RAF loop:

```ts
useEffect(() => {
  const handle = idleSceneRef.current; // Caller passes this in via the props/return shape — adapt to your existing controller API.
  if (!handle) return;

  let raf: number;
  const tick = () => {
    const now = performance.now();
    const dtMs = now - lastTickRef.current;
    lastTickRef.current = now;

    msInStateRef.current += dtMs;
    msSinceNarrationRef.current += dtMs;

    const out = nextChoreography(choreoStateRef.current, {
      presence: presenceRef.current,
      speaking: speakingRef.current, // assumes existing ref tracking TTS state
      narrationText: latestNarrationRef.current,
      msSinceLastNarration: msSinceNarrationRef.current,
      msInCurrentState: msInStateRef.current,
      bustOnly: BUST_ONLY,
    }, dtMs);

    if (out.state !== choreoStateRef.current) {
      choreoStateRef.current = out.state;
      msInStateRef.current = 0;
    }

    handle.setFraming(out.cameraFraming === "bust" ? "bust" : "full_body");
    handle.setBodyPose({ x: out.bodyX, z: out.bodyZ, clip: out.animationClip });

    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}, []);
```

Note: the exact shape of `idleSceneRef`, `speakingRef`, `latestNarrationRef` depends on your existing controller. Adapt names to match.

- [ ] **Step 5: Reset msSinceNarrationRef on narration change**

Wherever the controller currently reacts to a new `synthesisText` or `narrationText` arriving, set `msSinceNarrationRef.current = 0;`.

- [ ] **Step 6: Run dev server, verify end-to-end behavior**

```bash
pnpm --filter web dev
```
- Open the same expo URL.
- With webcam off: avatar paces L↔R using walk clip (no slide; this is real walking).
- Step in front of webcam: avatar approaches, camera tightens to bust framing.
- After narration arrives: avatar stays bust-framed, talks (with placeholder mouth shapes — visemes wired in Task 12).
- Step away: avatar retreats, camera widens.
- Set `NEXT_PUBLIC_AVATAR_CHOREOGRAPHY=bust_only` in `.env.local`, restart: avatar stays bust-framed always, no walking.

- [ ] **Step 7: Run all avatar tests**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/avatar/useAvatarController.ts
git commit -m "feat(avatar): wire choreographer to controller + NEXT_PUBLIC_AVATAR_CHOREOGRAPHY flag

End-to-end choreography now driven from VisionTracker presence +
narration state. bust_only short-circuits to safety mode."
```

---

## Task 11: AvatarPanel — drop legacy cameraMode prop

**Files:**
- Modify: `apps/web/src/components/avatar/AvatarPanel.tsx`

The IdleScene `cameraMode` prop was removed in Task 8. Drop the inline `cameraMode={avatarState.speaking ? "torso" : "full_body"}` in AvatarPanel — controller drives it now via the imperative handle.

- [ ] **Step 1: Find and remove the cameraMode prop**

```bash
grep -n "cameraMode" apps/web/src/components/avatar/AvatarPanel.tsx
```

Edit the `<IdleScene>` JSX to drop the `cameraMode` prop:

```tsx
<IdleScene
  ref={idleSceneRef}
  glbUrl={glbUrl}
  width="100%"
  height="100%"
/>
```

Also confirm the controller is given the IdleScene ref (so it can drive `setFraming` etc). If not already passed, wire it through.

- [ ] **Step 2: Run avatar tests, expect green**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/avatar/AvatarPanel.tsx
git commit -m "chore(avatar): drop legacy cameraMode prop from AvatarPanel"
```

---

## Task 12: Visemes — vowel classifier + morph mapping

**Files:**
- Create: `apps/web/src/components/avatar/visemes.ts`
- Test: `apps/web/src/components/avatar/__tests__/visemes.test.ts`

Pure helpers. Two functions: `classifyVowel(fftData)` returns `"AH" | "EE" | "OO" | "MM" | "neutral"`, and `vowelToMorphShape(vowel)` returns the ARKit morph influences object IdleScene's `setMouthShape` consumes.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { classifyVowel, vowelToMorphShape } from "../visemes";

describe("visemes", () => {
  it("classifyVowel returns neutral for silence", () => {
    const silent = new Uint8Array(64).fill(0);
    expect(classifyVowel(silent)).toBe("neutral");
  });

  it("classifyVowel returns AH when low-mid frequency band dominates", () => {
    const fft = new Uint8Array(64).fill(20);
    fft[5] = 200; fft[6] = 200; fft[7] = 200; // ~600-900Hz band
    expect(classifyVowel(fft)).toBe("AH");
  });

  it("classifyVowel returns EE when high band dominates", () => {
    const fft = new Uint8Array(64).fill(20);
    fft[20] = 200; fft[21] = 200; fft[22] = 200; // ~2.5kHz band
    expect(classifyVowel(fft)).toBe("EE");
  });

  it("vowelToMorphShape AH opens jaw without funnel", () => {
    const shape = vowelToMorphShape("AH");
    expect(shape.jawOpen).toBeGreaterThan(0.5);
    expect(shape.mouthFunnel).toBe(0);
  });

  it("vowelToMorphShape OO funnels and puckers", () => {
    const shape = vowelToMorphShape("OO");
    expect(shape.mouthFunnel).toBeGreaterThan(0.5);
    expect(shape.mouthPucker).toBeGreaterThan(0.3);
  });

  it("vowelToMorphShape neutral closes everything", () => {
    const shape = vowelToMorphShape("neutral");
    expect(shape.jawOpen).toBe(0);
    expect(shape.mouthFunnel).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/visemes.test.ts
```

- [ ] **Step 3: Implement visemes.ts**

```ts
// apps/web/src/components/avatar/visemes.ts

export type Vowel = "AH" | "EE" | "OO" | "MM" | "neutral";

export interface MouthShape {
  jawOpen: number;
  mouthFunnel: number;
  mouthPucker: number;
  mouthSmile: number;
  mouthClose: number;
}

const SILENCE_THRESHOLD = 30;

export function classifyVowel(fft: Uint8Array): Vowel {
  const totalEnergy = fft.reduce((a, b) => a + b, 0) / fft.length;
  if (totalEnergy < SILENCE_THRESHOLD) return "neutral";

  // Sum bands. Bin index → frequency assumes 44.1kHz sample rate, 256-sample FFT
  // (each bin ≈ 172Hz). Adjust if AnalyserNode is configured differently.
  const lowMid = fft.slice(3, 9).reduce((a, b) => a + b, 0);   // ~500-1500 Hz (AH)
  const high = fft.slice(15, 25).reduce((a, b) => a + b, 0);   // ~2500-4300 Hz (EE)
  const mid = fft.slice(9, 15).reduce((a, b) => a + b, 0);     // ~1500-2500 Hz (OO/UH)
  const low = fft.slice(0, 3).reduce((a, b) => a + b, 0);      // ~0-500 Hz (MM)

  const max = Math.max(lowMid, high, mid, low);
  if (max === lowMid) return "AH";
  if (max === high) return "EE";
  if (max === mid) return "OO";
  return "MM";
}

export function vowelToMorphShape(vowel: Vowel): MouthShape {
  switch (vowel) {
    case "AH": return { jawOpen: 0.6, mouthFunnel: 0, mouthPucker: 0, mouthSmile: 0, mouthClose: 0 };
    case "EE": return { jawOpen: 0.2, mouthFunnel: 0, mouthPucker: 0, mouthSmile: 0.4, mouthClose: 0 };
    case "OO": return { jawOpen: 0.3, mouthFunnel: 0.7, mouthPucker: 0.4, mouthSmile: 0, mouthClose: 0 };
    case "MM": return { jawOpen: 0, mouthFunnel: 0, mouthPucker: 0, mouthSmile: 0, mouthClose: 0.5 };
    case "neutral": return { jawOpen: 0, mouthFunnel: 0, mouthPucker: 0, mouthSmile: 0, mouthClose: 0 };
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
pnpm --filter web test -- --run apps/web/src/components/avatar/__tests__/visemes.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/avatar/visemes.ts apps/web/src/components/avatar/__tests__/visemes.test.ts
git commit -m "feat(avatar): vowel classifier + ARKit morph mapping for visemes"
```

---

## Task 13: Wire visemes to TTS audio in useAvatarController

**Files:**
- Modify: `apps/web/src/components/avatar/useAvatarController.ts`

Tap the active TTS audio source with an AnalyserNode. Each frame, read FFT, classify vowel, map to morph shape, push to IdleScene via `setMouthShape`.

- [ ] **Step 1: Add AnalyserNode setup when TTS provider initializes**

In the controller, where TTS provider is created/initialized (search for `ElevenLabsProvider` or the audio source), connect an AnalyserNode:

```ts
import { classifyVowel, vowelToMorphShape } from "./visemes";

const audioContextRef = useRef<AudioContext | null>(null);
const analyserRef = useRef<AnalyserNode | null>(null);
const fftBufRef = useRef<Uint8Array | null>(null);

function attachAnalyser(audioElement: HTMLAudioElement) {
  if (audioContextRef.current) return;
  const ctx = new AudioContext();
  const source = ctx.createMediaElementSource(audioElement);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  source.connect(ctx.destination);
  audioContextRef.current = ctx;
  analyserRef.current = analyser;
  fftBufRef.current = new Uint8Array(analyser.frequencyBinCount);
}
```

Call `attachAnalyser` when the TTS provider creates its audio element.

- [ ] **Step 2: In the choreographer RAF tick, drive setMouthShape**

Inside the `tick` function added in Task 10, after `handle.setBodyPose(...)`:

```ts
const handle2 = idleSceneRef.current;
if (handle2 && analyserRef.current && fftBufRef.current && speakingRef.current) {
  analyserRef.current.getByteFrequencyData(fftBufRef.current);
  const vowel = classifyVowel(fftBufRef.current);
  handle2.setMouthShape(vowelToMorphShape(vowel));
} else if (handle2) {
  handle2.setMouthShape(null);
}
```

- [ ] **Step 3: Test in dev that mouth moves while TTS plays**

```bash
pnpm --filter web dev
```
Trigger a narration via demo mode or live event. Watch the avatar's mouth — should move with vowel-shaped articulation, not just open/close.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/avatar/useAvatarController.ts
git commit -m "feat(avatar): visemes drive ARKit mouth morphs from TTS audio"
```

---

## Task 14: docs/CONTRACT.md — env var entry

**Files:**
- Modify: `docs/CONTRACT.md`

- [ ] **Step 1: Find the env vars section in CONTRACT.md**

```bash
grep -n "NEXT_PUBLIC\|env_vars\|environment" docs/CONTRACT.md | head -10
```

- [ ] **Step 2: Append the new env var entry in the same YAML/structured format the file uses**

Pattern after existing `NEXT_PUBLIC_*` entries. Example:

```yaml
NEXT_PUBLIC_AVATAR_CHOREOGRAPHY:
  type: enum
  values: [full, bust_only]
  default: full
  description: Avatar choreography mode. `full` runs the four-state walk-and-bust state machine driven by VisionTracker presence. `bust_only` short-circuits to bust framing always (no walking, no Z motion). Expo safety net.
```

(Adapt to the file's exact YAML / table style — read a nearby entry first to copy structure.)

- [ ] **Step 3: Commit**

```bash
git add docs/CONTRACT.md
git commit -m "docs(contract): add NEXT_PUBLIC_AVATAR_CHOREOGRAPHY env var"
```

---

## Task 15: Manual smoke test before merging

**Files:** none (verification only)

- [ ] **Step 1: Boot dev server with full choreography**

```bash
pnpm --filter web dev
```

- [ ] **Step 2: Verify the production-bug repro is fixed**

Open http://localhost:3000/event/duke-expo-2026/quorum/c6c4f8ba-1f98-48b1-bc4c-ec346b9fae24?station=1 in a browser with webcam permission granted.

Verify:
- Avatar does NOT do the off-putting full-body slide
- Avatar paces L↔R using actual walk clip (legs animate)
- When you face the webcam closely (>2s, head fills ~15% of webcam frame), avatar walks forward and camera tightens to bust framing
- When narration arrives (live or demo-mode), mouth animates with vowel shapes
- Step away from webcam → after ~5s, avatar walks backward, camera widens

- [ ] **Step 3: Verify the safety-net flag works**

Stop the dev server. Add to `apps/web/.env.local`:
```
NEXT_PUBLIC_AVATAR_CHOREOGRAPHY=bust_only
```

Restart `pnpm --filter web dev`. Reload the same URL.

Verify:
- Avatar permanently at bust framing
- No walking, no L↔R pacing, no Z-axis approach motion
- Mouth still animates during narration (visemes still active in bust_only)

- [ ] **Step 4: Run the full frontend test suite**

```bash
pnpm --filter web test -- --run
```
Expected: all pass.

- [ ] **Step 5: Run lint and type-check**

```bash
pnpm --filter web lint && pnpm --filter @quorum/types typecheck
```

- [ ] **Step 6: Document the smoke-test pass in the commit message of a final no-op commit OR open the PR**

If opening a PR:

```bash
git push -u origin feat/avatar-rework
gh pr create --title "feat(avatar): walk-and-bust choreography + visemes" --body "$(cat <<'EOF'
## Summary
- Replace the off-putting full-body slide with a vision-aware four-state choreographer (idle_pacing → approach → talking → retreating)
- Add bust camera framing preset
- Lightweight viseme lip-sync from TTS audio
- NEXT_PUBLIC_AVATAR_CHOREOGRAPHY=bust_only safety flag for the expo

Spec: `docs/superpowers/specs/2026-05-14-avatar-rework-design.md`
Plan: `docs/superpowers/plans/2026-05-14-avatar-rework.md`

## Test plan
- [x] All unit tests pass (`pnpm --filter web test`)
- [x] Lint + typecheck pass
- [x] Manual smoke: production URL no longer slides; choreography works; bust_only flag works

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

**Spec coverage check** (run after writing all tasks above):
- ✅ idle_pacing state: Task 6 (sine bodyX) + Task 9 (walk clip)
- ✅ approach state: Task 4
- ✅ talking state: Task 5
- ✅ retreating state: Task 6
- ✅ bust camera preset: Task 7
- ✅ bust_only flag: Task 2 (logic) + Task 10 (read env)
- ✅ VisionTracker presence: Task 1
- ✅ Visemes: Tasks 12 + 13
- ✅ docs/CONTRACT.md: Task 14
- ✅ Manual QA: Task 15
- ⚠️ Future polish ideas (random emotes, gesture mirroring) explicitly out of scope per spec — no task. Correct.

**Type consistency check:**
- `IdleSceneHandle` extends with three new methods (Task 8) — same signatures referenced in Task 10 wiring. ✅
- `MouthShape` defined in Task 12 — consumed in Task 13. ✅
- `ChoreographyOutput.cameraFraming` is `"full_body" | "bust"` (defined Task 2) — Task 10 maps it to IdleSceneHandle.setFraming which accepts `"full_body" | "torso" | "bust"` (the existing torso preset stays for any other caller, but choreographer never outputs it). ✅

**Placeholder scan:** No "TBD" or "implement later" remaining. Mixamo download is a manual file step, but the instructions are exact (Format / Skin / FPS settings spelled out).
