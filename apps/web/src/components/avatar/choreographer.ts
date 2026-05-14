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
