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
  /** Body world-Y rotation (radians). In `idle_pacing` the avatar smoothly turns to face the direction of motion (-π/2 right, +π/2 left, 0 facing camera at extrema). All other states return 0 (face camera). */
  bodyYaw: number;
  animationClip: "breathing" | "walking";
}

const APPROACH_TRIGGER_SIZE = 0.15;
const APPROACH_RELEASE_SIZE = 0.05;
const APPROACH_TRIGGER_MS = 2000;
const RETREAT_AFTER_MS = 5000;
const APPROACH_RAMP_MS = 1500;
const APPROACH_BODY_Z = 0.6;
const RETREAT_RAMP_MS = 1200;
const PACE_PERIOD_MS = 10000;
const PACE_AMPLITUDE = 0.6;
/** Steepness of the tanh curve mapping pacing velocity → body yaw. Higher = avatar snaps to face direction sooner; lower = lingers facing camera at extrema. 3 gives a natural turn that aligns the gait with the world translation by mid-cycle. */
const PACE_YAW_STEEPNESS = 3;

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
      bodyYaw: 0,
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
        bodyYaw: 0,
        animationClip: "walking",
      };
    }
    // Avatar paces L↔R via sin(phase). bodyYaw smoothly tracks the velocity
    // direction (cos(phase)) so the body turns to face direction of motion:
    //   phase = 0 (about to walk right): yaw → -π/2 (face right)
    //   phase = π/2 (rightmost extremum, velocity = 0): yaw → 0 (face camera)
    //   phase = π (about to walk left): yaw → +π/2 (face left)
    //   phase = 3π/2 (leftmost extremum): yaw → 0 (face camera)
    // tanh smoothing avoids the snap at zero crossings; ±90° aligns the
    // walk clip's forward gait with the world translation direction.
    const phase = (input.msInCurrentState / PACE_PERIOD_MS) * 2 * Math.PI;
    return {
      state: "idle_pacing",
      cameraFraming: "full_body",
      bodyZ: 0,
      bodyX: Math.sin(phase) * PACE_AMPLITUDE,
      bodyYaw: -Math.PI / 2 * Math.tanh(Math.cos(phase) * PACE_YAW_STEEPNESS),
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
        bodyYaw: 0,
        animationClip: "breathing",
      };
    }
    if (t >= 1) {
      return {
        state: "talking",
        cameraFraming: "bust",
        bodyZ: APPROACH_BODY_Z,
        bodyX: 0,
        bodyYaw: 0,
        animationClip: "breathing",
      };
    }
    return {
      state: "approach",
      cameraFraming: t > 0.5 ? "bust" : "full_body",
      bodyZ,
      bodyX: 0,
      bodyYaw: 0,
      animationClip: "walking",
    };
  }

  if (prev === "talking") {
    const personLeft =
      !input.presence.detected || input.presence.sizeRatio < APPROACH_RELEASE_SIZE;
    // Only retreat on "TTS idle" if narration has actually happened at some
    // point. Without this guard, the initial msSinceLastNarration sentinel
    // (99999) immediately satisfies the > 5000 check and the avatar bounces
    // straight from talking back to retreating, producing an endless
    // approach↔retreat oscillation when a face is detected but no narration
    // ever fires (the silent-floor expo case).
    const hasEverNarrated = input.narrationText !== undefined;
    const ttsIdle =
      hasEverNarrated &&
      !input.speaking &&
      input.msSinceLastNarration > RETREAT_AFTER_MS;

    if (personLeft || ttsIdle) {
      return {
        state: "retreating",
        cameraFraming: "full_body",
        bodyZ: APPROACH_BODY_Z,
        bodyX: 0,
        bodyYaw: 0,
        animationClip: "walking",
      };
    }
    return {
      state: "talking",
      cameraFraming: "bust",
      bodyZ: APPROACH_BODY_Z,
      bodyX: 0,
      bodyYaw: 0,
      animationClip: "breathing",
    };
  }

  if (prev === "retreating") {
    const t = Math.min(1, input.msInCurrentState / RETREAT_RAMP_MS);
    const bodyZ = APPROACH_BODY_Z * (1 - t);

    if (t >= 1) {
      return {
        state: "idle_pacing",
        cameraFraming: "full_body",
        bodyZ: 0,
        bodyX: 0,
        bodyYaw: 0,
        animationClip: "walking",
      };
    }
    return {
      state: "retreating",
      cameraFraming: "full_body",
      bodyZ,
      bodyX: 0,
      bodyYaw: 0,
      animationClip: "walking",
    };
  }

  // All states covered above; this is unreachable but keeps TS happy.
  throw new Error(`unreachable choreography state: ${prev as string}`);
}
