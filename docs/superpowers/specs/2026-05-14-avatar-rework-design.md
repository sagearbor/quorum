# Avatar Rework — Walk-and-Bust Choreography + Visemes

**Date:** 2026-05-14
**Branch:** `feat/avatar-rework`
**Driver:** Sophie Arborbot
**Target event:** Duke Tech Expo 2026

## Problem

The current facilitator avatar paces full-body left and right via a CSS-style horizontal slide on the avatar root (`apps/web/src/components/avatar/IdleScene.tsx`, `PACE_AMPLITUDE = 0.3`). The legs do not animate — only the X position translates — so the body reads as "ice skating," which is the off-putting effect Sophie has flagged.

A live verification is reproducible at:
`https://quorum-web-sage-arbors-projects.vercel.app/event/duke-expo-2026/quorum/c6c4f8ba-1f98-48b1-bc4c-ec346b9fae24?station=1`

## Goal

Replace the slide with a vision-aware four-state choreography that:

1. Idles with a real walking gait (Mixamo "Walk" clip blended over breathing) when nobody is looking.
2. Walks forward in 3D when a person is detected near the screen.
3. Frames at bust (head + shoulders) and lip-syncs with phoneme-aware visemes while talking.
4. Retreats back to idle when nobody is engaging.

Plus a feature flag that short-circuits the entire choreography down to "always bust framing, no motion" as an expo-night safety net.

## Non-goals

- **No chair / sit-down animation.** Explicitly dropped from scope per Sophie.
- **No cinematic scene lighting work** (no HDRI, no 3-point lighting, no ACES tonemap). Sophie evaluated this and decided it's not the lever she cares about.
- **No new selfie-to-GLB service integration.** The 2 new avatars will be generated via Avaturn (same workflow Sophie used for the existing Sage GLB) and dropped in `apps/web/public/avatars/avaturn/` as a parallel asset task. Engineering does not depend on or block on this.
- **No swap to video-streaming providers** (Simli, HeyGen, Beyond Presence). The R3F + GLB render path stays.
- **No phoneme-accurate viseme model.** We do amplitude-band → vowel mapping, not a wasm phoneme predictor. Good enough at projector distance; defer the heavier model.

## User-visible behavior

### Four states (full choreography mode)

| State          | Camera framing         | Body                              | Triggered by                                                |
|----------------|------------------------|-----------------------------------|-------------------------------------------------------------|
| `idle_pacing`  | full body              | walks L↔R using Mixamo Walk clip  | initial state, returned to after `retreating`               |
| `approach`     | lerping → bust         | walks forward in 3D (Z motion)    | VisionTracker reports person bbox > 15% frame area for >2s  |
| `talking`      | bust                   | stationary + viseme mouth shapes  | `orchestratorNarration` arrives OR approach lerp completes  |
| `retreating`   | lerping → full body    | walks backward in 3D, then resumes pacing | 5s of no narration AND TTS stream ended; or person leaves (bbox < 5%) |

### Bust framing

A new camera preset added alongside the existing `full_body` and `torso`:

- `full_body`: position `(0, 1.2, 3)`, lookAt `(0, 1, 0)`, FOV 35 — unchanged.
- `torso`: position `(0, 1.5, 1.55)`, lookAt `(0, 1.45, 0)`, FOV 28 — unchanged.
- **`bust` (new):** position `(0, 1.62, 1.15)`, lookAt `(0, 1.6, 0)`, FOV 24. Frames head + shoulders only — never legs, rarely upper chest. Tuned so that on a 60-inch projector at expo viewing distance the audience's eye lands on the avatar's eyes. Numbers above are the starting point; final values picked during dev QA against an actual Avaturn GLB so that hair-top and clavicle both land in frame.

### Feature flag

Environment variable: `NEXT_PUBLIC_AVATAR_CHOREOGRAPHY`

| Value         | Behavior                                                                                       |
|---------------|------------------------------------------------------------------------------------------------|
| `full`        | Default. Full four-state choreography described above.                                         |
| `bust_only`   | Short-circuit. Always bust framing, no walking, no Z motion, no vision-driven transitions.    |

Default for this branch is `full` so the choreography is exercised in dev. We flip to `bust_only` at the venue if anything misbehaves.

## Architecture

### New module — `choreographer.ts`

Pure TypeScript state machine living at `apps/web/src/components/avatar/choreographer.ts`. No DOM, no React, no Three.js dependency. Inputs and outputs are plain objects so it's trivially unit-testable.

```ts
type ChoreographyState = "idle_pacing" | "approach" | "talking" | "retreating";

interface ChoreographyInput {
  presence: { detected: boolean; sizeRatio: number; durationMs: number };
  speaking: boolean;
  narrationText: string | undefined;
  msSinceLastNarration: number;
  /** ms elapsed since the last state transition. Caller resets to 0 on each transition. */
  msInCurrentState: number;
  bustOnly: boolean;
}

interface ChoreographyOutput {
  state: ChoreographyState;
  cameraFraming: "full_body" | "bust";
  /** Z-axis target position on the world axis. Forward of origin = closer to camera. */
  bodyZ: number;
  /** Animation clip the AnimationMixer should be blended toward. */
  animationClip: "breathing" | "walking";
  /** Body world-X target. In `idle_pacing` this is computed as `sin(msInCurrentState * 2π / 10000) * 0.6` so the avatar paces with a 10s period and 0.6-unit amplitude — but the visible motion comes from the walk clip, not from the X translation by itself. In all other states, 0. */
  bodyX: number;
}

function nextChoreography(prev: ChoreographyState, input: ChoreographyInput, dtMs: number): ChoreographyOutput;
```

When `bustOnly === true`, `nextChoreography` returns the bust-only steady state regardless of input — this is the safety net.

### Wiring

```
VisionTracker
   ├─ existing onGaze(yaw, pitch)  — kept, unchanged callers
   └─ NEW onPresence({ detected, sizeRatio, durationMs })
              │
              ▼
  useAvatarController
   ├─ tracks msSinceLastNarration
   ├─ reads NEXT_PUBLIC_AVATAR_CHOREOGRAPHY → bustOnly flag
   ├─ calls choreographer.nextChoreography() each frame tick
   └─ applies output via IdleSceneHandle methods
              │
              ▼
       IdleSceneHandle (extended)
   ├─ existing setGaze(yaw, pitch)
   ├─ existing setEmotion(emotion)
   ├─ NEW setFraming("full_body" | "bust")
   ├─ NEW setBodyPose({ x, z, animationClip })
   └─ NEW setMouthShape(viseme | null)
              │
              ▼
        IdleScene
   ├─ camera lerp toward setFraming target (extends existing CAMERA_PRESETS lerp)
   ├─ avatarRoot position lerp toward setBodyPose target
   ├─ AnimationMixer crossFade between breathing and walking clips
   └─ morph-target influences for viseme mouth shapes
```

The choreographer ticks once per RAF frame (driven from `useAvatarController`'s existing rAF or a dedicated tick). The cost is negligible — pure math, no allocations in the hot path.

## File-by-file changes

| File | Change |
|------|--------|
| **NEW** `apps/web/src/components/avatar/choreographer.ts` | Pure state machine. ~150 lines. Unit-tested. |
| **NEW** `apps/web/src/components/avatar/__tests__/choreographer.test.ts` | Vitest unit tests. State transitions, bbox threshold, dwell timers, `bust_only` short-circuit. |
| **NEW** `apps/web/src/components/avatar/visemes.ts` | AnalyserNode + frequency-band → vowel-class → ARKit morph mapping. Pure helper. |
| **NEW** `apps/web/public/animations/walk.glb` | Mixamo "Walk" clip retargeted to standard humanoid skeleton (Avaturn / itSeez3D / RPM all share this). One-time download, checked into the repo. |
| `apps/web/src/components/avatar/IdleScene.tsx` | Add `bust` to `CAMERA_PRESETS`. Expose new imperative methods on `IdleSceneHandle`: `setFraming`, `setBodyPose`, `setMouthShape`. Load the walk clip alongside the breathing idle. Crossfade between them. **Remove** the existing X-axis sine-wave slide (`PACE_AMPLITUDE`, `PACE_PERIOD_MS`, `PACE_YAW`, the `paceElapsedS` accumulator, and the `pacingSuppressed` branch). The body's X comes from `setBodyPose` now, not from a free-running sine. |
| `apps/web/src/components/avatar/VisionTracker.ts` | Extend `onGaze` callback signature with an optional `presence` payload `{ detected, sizeRatio, durationMs }`. Implementation: stop discarding the bbox `width * height / (frameW * frameH)` we already compute in the largest-detection picker (`VisionTracker.ts:160-189`). Frame-counter accumulates `durationMs` while `detected` stays true. Smooth `sizeRatio` via 5-frame moving average. Existing callers ignore the new payload — non-breaking. |
| `apps/web/src/components/avatar/useAvatarController.ts` | Read `NEXT_PUBLIC_AVATAR_CHOREOGRAPHY` env var → `bustOnly`. Track `msSinceLastNarration` (reset on each `narrationText` change). Each frame: call `choreographer.nextChoreography()`, route output to the IdleScene handle. Wire visemes from the active TTS audio source. Replace existing `cameraMode = speaking ? "torso" : "full_body"` direct toggle with the choreographer's `cameraFraming` output. |
| `apps/web/src/components/avatar/AvatarPanel.tsx` | Drop the inline `cameraMode={avatarState.speaking ? "torso" : "full_body"}` prop on IdleScene — the controller drives framing now via the imperative handle. |
| `apps/web/src/components/avatar/archetypes/archetypes.ts` | No code change required for Avaturn; existing entry is already at the front of the resolver chain. New GLBs from Avaturn drop into `apps/web/public/avatars/avaturn/<archetype>.glb` and are picked up automatically. |
| `docs/CONTRACT.md` | Append YAML entry for `NEXT_PUBLIC_AVATAR_CHOREOGRAPHY` env var (values `full`, `bust_only`). |

### Lines removed

- `IdleScene.tsx`: ~50 lines of the sine-wave pacing system + `pacingSuppressed` branch + the SETTLE_TO_CENTER_MS pre-camera-lerp settle phase (no longer needed — the choreographer dictates body X directly).

### Lines added

- ~150 in `choreographer.ts`
- ~80 in `visemes.ts`
- ~60 in `IdleScene.tsx` (new presets, new handle methods, AnimationMixer crossfade)
- ~30 in `VisionTracker.ts` (presence payload + smoothing)
- ~40 in `useAvatarController.ts` (controller wiring)
- ~150 in tests

Net diff roughly +400 / -50.

## Asset pipeline

### Avaturn avatars (Sophie does in parallel)

Sophie generates 2 new avatars at https://avaturn.me from her existing 3-photos-per-person selfie sets. GLBs land at:

- `apps/web/public/avatars/avaturn/<archetype>.glb`

Where `<archetype>` is one of the 12 archetype IDs in `archetypes.ts` (`medical_clinical`, `researcher`, etc.). The resolver picks them up automatically. No code change needed when the GLBs land.

### Mixamo Walk clip (one-time, this branch)

Download from https://www.mixamo.com (free with Adobe account) — search "Walk", select a neutral medium-paced loop, retarget to "RPM / standard humanoid" skeleton, download as GLB without skin. Drop at `apps/web/public/animations/walk.glb`. The skeleton compatibility is the load-bearing assumption; if the Mixamo clip doesn't blend cleanly we fall back to camera-pan-only idle (see Risks).

## Visemes

Lightweight amplitude-band approach:

1. Tap an `AnalyserNode` on the active TTS audio source (ElevenLabs in the current default).
2. Each frame: read the FFT, classify the dominant frequency band into a coarse vowel class (`AH`, `EE`, `OO`, `MM`, neutral).
3. Map vowel class → ARKit morph influences:
   - `AH` → `jawOpen` 0.6, `mouthFunnel` 0.0
   - `EE` → `jawOpen` 0.2, `mouthSmile` 0.4
   - `OO` → `jawOpen` 0.3, `mouthFunnel` 0.7, `mouthPucker` 0.4
   - `MM` → `jawOpen` 0.0, `mouthClose` 0.5
4. Smooth via simple lerp (existing eye-morph code uses 0.35 — start there).

Phoneme-accurate visemes (wasm Whisper-tiny or similar) are out of scope for this branch but the `visemes.ts` interface is shaped so a swap is a single-file change later.

## Testing strategy

### Unit tests (vitest)

- `choreographer.test.ts`: every state transition, bbox-size hysteresis, dwell-time threshold (>2s), `bust_only` short-circuit, retreat trigger conditions (timeout AND TTS-ended; person-leaves immediate).
- `visemes.test.ts`: vowel classification given synthetic FFT inputs; morph-influence mapping.
- `VisionTracker.test.ts` (extend existing): assert the new `presence` payload includes `sizeRatio` and `durationMs`; assert moving-average smoothing converges within 5 frames.

### Integration tests (vitest + jsdom)

- `IdleScene.test.tsx`: assert `setFraming("bust")` causes camera position to lerp; assert `setBodyPose({z: 0.5})` translates avatar root.
- `AvatarPanel.test.tsx` (extend existing): mount with `NEXT_PUBLIC_AVATAR_CHOREOGRAPHY=bust_only` env; assert no walking clip plays, no body translates.

### Manual verification (before merging)

1. Local dev with `NEXT_PUBLIC_AVATAR_CHOREOGRAPHY=full`: avatar paces, walks forward when face is in webcam, bust-frames when narration fires.
2. Local dev with `NEXT_PUBLIC_AVATAR_CHOREOGRAPHY=bust_only`: avatar permanently at bust, no walking ever.
3. Demo-mode reproduction of the exact production URL pattern.

## Risks + fallbacks

| Risk | Likelihood | Fallback |
|------|------------|----------|
| Mixamo Walk clip doesn't blend cleanly with the RPM/Avaturn breathing — feet slide or arms snap | Medium | Suppress the walk clip blend, do camera-pan-only idle. Body stays still, camera does horizontal pan during idle. Still no slide problem (because the body isn't translating), still avoids the "standing mannequin" feel. |
| VisionTracker presence detection too jumpy (false approach triggers from people walking past) | High | 5-frame moving average on `sizeRatio` plus hysteresis: trigger at >15%, release at <5%. Tunable in dev. |
| Avaturn GLBs from the 2 new people don't have ARKit blend shapes (visemes can't drive mouth) | Low | Fall back to amplitude-driven `jawOpen` only. Lip-sync degrades from "vowel shapes" to "mouth open proportional to volume" — current behavior. Not a regression. |
| All else fails at the venue | Always present | Set `NEXT_PUBLIC_AVATAR_CHOREOGRAPHY=bust_only` in Vercel env, redeploy. ~5 minutes from "demo broken" to "demo recovered". |

## Out of scope (explicitly)

- Chair model, sit-down animation
- HDRI / 3-point lighting / ACES tonemap
- itSeez3D, In3D, didimo integrations
- Phoneme-accurate viseme model
- Walk-while-talking (avatar always stationary while talking; only walks during transitions)
- Custom avatar generation pipeline integrated into Quorum (continues to be an external tool the user runs)

## Build sequence

1. **VisionTracker presence payload** — extend callback, add smoothing, write test. No visual change yet. (~1h)
2. **Choreographer state machine + tests** — pure TS, no UI. (~2h)
3. **IdleScene `bust` preset + new handle methods + delete sine-wave slide** — visual change here: idle is now still, talking is bust. Verify in browser. (~2h)
4. **Mixamo Walk clip integration** — load + crossfade. Verify the gait. (~2h)
5. **useAvatarController wiring + feature flag** — connect everything. End-to-end behavior visible. (~1h)
6. **Visemes** — AnalyserNode + vowel mapping + morph driver. Verify lip motion matches speech. (~3h)
7. **Tests, manual QA, docs** — including `docs/CONTRACT.md` update. (~2h)

Total estimate: ~13 hours of focused work. Realistic 2-day calendar with QA cycles and Avaturn-asset coordination overlap.
