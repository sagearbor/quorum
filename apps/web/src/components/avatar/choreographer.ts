// apps/web/src/components/avatar/choreographer.ts

export type ChoreographyState = "idle_pacing" | "approach" | "talking" | "retreating";

export interface ChoreographyInput {
  presence: { detected: boolean; sizeRatio: number; durationMs: number };
  speaking: boolean;
  narrationText: string | undefined;
  msSinceLastNarration: number;
  /** ms elapsed since the last state transition. Caller resets to 0 on each transition. */
  msInCurrentState: number;
  bustOnly: boolean;
}

export interface ChoreographyOutput {
  state: ChoreographyState;
  cameraFraming: "full_body" | "bust";
  bodyZ: number;
  /** Body world-X target. In `idle_pacing` this is computed as `sin(msInCurrentState * 2π / 10000) * 0.6` so the avatar paces with a 10s period and 0.6-unit amplitude — but the visible motion comes from the walk clip, not from the X translation by itself. In all other states, 0. */
  bodyX: number;
  animationClip: "breathing" | "walking";
}

const APPROACH_TRIGGER_SIZE = 0.15;
const APPROACH_RELEASE_SIZE = 0.05;
const APPROACH_TRIGGER_MS = 2000;
const RETREAT_AFTER_MS = 5000;
const APPROACH_RAMP_MS = 1500;
const APPROACH_BODY_Z = 0.6;

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

  // Other states added in subsequent tasks.
  return {
    state: prev,
    cameraFraming: "full_body",
    bodyZ: 0,
    bodyX: 0,
    animationClip: "breathing",
  };
}
