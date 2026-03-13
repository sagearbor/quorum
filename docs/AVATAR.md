# Quorum Avatar Facilitator — Feature Spec

## Overview

A real-time AI avatar that acts as the Quorum facilitator. Displayed on the projector dashboard. Speaks synthesis updates, listens to participants, and physically turns toward whoever is speaking using stereo mic direction detection.

**Goal:** A "wow moment" for the Duke Tech Expo 2026 demo that's also production-ready infrastructure.

---

## Core Behaviors

1. **Talks:** LLM synthesis output → TTS → avatar lip-syncs in real time
2. **Listens:** Continuous stereo mic input → voice detection → speaker localization
3. **Looks:** Detects which side (L/C/R) the active speaker is on → avatar turns head in that direction
4. **Expresses:** Avatar facial expressions adapt to conversation tone (tense, productive, resolved)

---

## Architecture

```
Stereo Mic Input (Web Audio API)
    ↓
L/R Energy Analyzer (browser JS)
    ↓ direction: "left" | "center" | "right"
Avatar Controller
    ↓ head_yaw param
Avatar Renderer (pluggable provider)
    ↑
LLM Synthesis Output (existing Quorum pipeline)
    ↓
TTS Stream (ElevenLabs free tier or pluggable)
    ↓
Avatar lip-sync
```

---

## Provider Strategy

Architect as a **swappable provider pattern** (`AvatarProvider` interface). Start with the best free option, swap in paid if needed.

### Provider Priority

1. **ElevenLabs Conversational AI** — free tier, has built-in avatar widget, React SDK, ~1s latency. Start here.
2. **Simli.ai** — ~$0.10/min, best latency (0.4s), head pose SDK param. Use for Expo if EL avatar quality insufficient.
3. **HeyGen Streaming** — ~$0.15/min, highest quality. Fallback if needed.

### Interface

```typescript
interface AvatarProvider {
  init(config: AvatarConfig): Promise<void>;
  speak(text: string, emotion?: Emotion): Promise<void>;
  setHeadPose(yaw: number, pitch: number): void; // -1.0 (left) to 1.0 (right)
  destroy(): void;
}

type Emotion = 'neutral' | 'engaged' | 'tense' | 'resolved';
```

---

## Stereo Direction Detection

Use the **Web Audio API** to analyze L/R channel energy in real time.

```
getUserMedia({ audio: { channelCount: 2 } })
    ↓
AudioContext → ChannelSplitter → AnalyserNode (x2)
    ↓
leftRMS vs rightRMS → direction
```

### Direction Logic

```
leftRMS > rightRMS * 1.3  → "left"   (yaw: -0.6)
rightRMS > leftRMS * 1.3  → "right"  (yaw: +0.6)
else                       → "center" (yaw: 0.0)
```

Smooth with exponential moving average (α=0.15) to avoid jitter.

### Hardware

- **Built-in laptop mics (ThinkPad T14):** Lenovo driver presents as mono beamformed. Stereo detection will NOT work.
- **USB webcam (Logitech C270/C920 etc.):** Exposes true stereo USB audio. Plug-and-play.
- **Recommendation:** Request one USB webcam per station from DCRI. Cost ~$25 if not already available.

---

## Emotion → Expression Mapping

Pull emotion signal from existing Quorum synthesis pipeline (LLM already scores quorum health).

```
health_delta > 0  → 'engaged'
health_delta < -5 → 'tense'
resolved == true  → 'resolved'
default           → 'neutral'
```

Pass emotion to provider.speak() — each provider maps to their own expression params.

---

## UI Integration

Avatar lives in the /display dashboard as a new carousel panel: "Facilitator".

- Full-screen avatar panel, 16:9
- Subtle audio waveform indicator below (shows who's speaking)
- Small L/C/R direction indicator dot (dev mode only)
- Avatar panel appears in carousel rotation alongside existing Quorum Health, Role Activity charts

---

## Implementation Plan

### Phase 1 — Core avatar speaking (no stereo) [~4h]
- [ ] AvatarProvider interface + ElevenLabsProvider implementation
- [ ] Wire Quorum synthesis output → TTS → avatar speak
- [ ] /display new "Facilitator" panel with ElevenLabs widget
- [ ] Emotion from quorum health delta

### Phase 2 — Stereo direction detection [~3h]
- [ ] StereoAnalyzer class (Web Audio API, L/R energy, EMA smoothing)
- [ ] Direction → head yaw mapping
- [ ] Hook into AvatarProvider.setHeadPose()
- [ ] Fallback: if mono/no stereo, disable head turn (no errors)

### Phase 3 — Provider abstraction + Simli [~2h]
- [ ] SimliProvider implementation (use if EL quality insufficient)
- [ ] AVATAR_PROVIDER=elevenlabs|simli|heygen env var
- [ ] Dev mode: AVATAR_MOCK=true (no API calls, dummy lip-sync animation)

---

## Environment Variables

```
AVATAR_PROVIDER=elevenlabs       # elevenlabs | simli | heygen | mock
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=...          # from EL Conversational AI dashboard
SIMLI_API_KEY=...                # optional, only if using Simli
AVATAR_MOCK=false                # true = no API calls, for local dev
```

---

## Testing

- Unit: StereoAnalyzer direction logic (mock AudioContext)
- Integration: AvatarProvider interface contract tests (mock provider)
- E2E: Manual only (requires live mic + display)
- AVATAR_MOCK=true must work with zero API keys for CI

---

## Files to Create/Modify

```
apps/web/
  components/avatar/
    AvatarPanel.tsx          # Main panel for /display carousel
    AvatarProvider.ts        # Interface + factory
    ElevenLabsProvider.ts    # EL Conversational AI implementation
    SimliProvider.ts         # Simli streaming implementation (Phase 3)
    StereoAnalyzer.ts        # Web Audio API stereo detection
    useAvatarController.ts   # React hook tying it all together
  app/display/page.tsx       # Add Facilitator panel to carousel
```

---

## Open Questions (for Sage)

1. Does DCRI have USB webcams? (determines if stereo head-turn works day-of)
2. ElevenLabs free tier: 10,000 chars/month — enough for ~30 min demo. Probably yes.
3. Should avatar have a name/persona? ("Dr. Quinn"? Just "Facilitator"?)
4. Should avatar speak proactively on every synthesis update, or only when triggered?

---

## Updated Architecture: Tiered Avatars (added post-spec)

Sage confirmed 4-5 simultaneous stations, running all day at the Expo off a local M5 Pro Mac (128GB).

### Tier 1 — Projector/Display + Architect view: Full photorealistic avatar
- 2 avatars: projector `/display` panel + Architect planning view
- MuseTalk or cloud provider (EL/Simli)
- The "wow" centerpiece

### Tier 2 — Station terminals: Animated 2D avatar
- 4-5 lightweight animated avatars, one per station browser tab
- SVG/canvas-based, voice-driven mouth + expression animation
- Runs on the Mac with zero GPU strain
- No cloud cost, no API keys, works all day

### Hardware path
- **Now (ThinkPad demo):** Cloud provider (EL free tier) for projector only; stations use MockProvider/2D
- **After M5 Pro arrives:** Benchmark MuseTalk 4-5× simultaneous on Apple Silicon. If it handles it, swap stations to photorealistic local inference. No code changes needed — just swap provider env var.

### Local stack (M5 Pro target)
- TTS: Kokoro or Chatterbox (open source, Apple Silicon optimized)
- Lip sync: MuseTalk (runs on Metal/MPS)
- Head pose: custom StereoAnalyzer → CSS transform (already in Phase 2)

---

## Phase 4 — Full-Body Idle + Vision Tracking + Transitions

### Overview
- **Idle state:** Ready Player Me (RPM) full-body avatar walks/idles in a 3D scene (Three.js/React Three Fiber)
- **Engaged state:** ElevenLabs bust overlay (existing Phase 1) for conversation quality
- **Transition:** 6 named transition animations bridging RPM full-body → EL bust
- **Vision tracking:** MediaPipe person detection → head/eye gaze follows detected person

### Tech Stack Addition
- `@react-three/fiber` + `@react-three/drei` — Three.js in React
- `@readyplayerme/react-avatar-creator` or direct GLB load — RPM character
- Mixamo animations (GLB): idle, walk, jog-toward-camera, sit-down
- `@mediapipe/tasks-vision` — in-browser person detection for gaze tracking

### Vision Tracking
```
getUserMedia (video) → MediaPipe PersonDetector (WASM/WebGL)
    ↓ bounding box centroid X (0=left, 1=right)
normalize to yaw [-1, 1]
    ↓
IdleAvatarController.setGaze(yaw)
    ↓ (RPM): Three.js camera + head bone rotation
    ↓ (EL bust, engaged): existing AvatarProvider.setHeadPose()
```

Modes:
- **No person detected:** slow random idle glances, natural micro-movements
- **Person detected, far away:** gaze tracks person position (haunted painting effect)
- **Person at station (audio active):** audio direction takes priority over vision

### Transitions: RPM full-body → EL bust

All 6 must be implemented. Each is a named class implementing `Transition.play(): Promise<void>`.

1. **`ZoomIn`** — Three.js camera push from full-body to face, crossfade EL bust at end
2. **`JogAndPeek`** — avatar jogs toward screen edge, exits frame, EL bust slides in from same edge
3. **`RunAndBounce`** — avatar sprints at camera, screen flash+shake, bust "bounces" back out (CSS spring animation)
4. **`SitDown`** — Mixamo sit animation plays, camera settles on face level, dissolve to EL bust
5. **`DepthBlur`** — RPM scene blurs (CSS filter + Three.js depth of field), EL bust fades in sharp
6. **`EyeMatchCut`** — RPM looks at camera (head bone), hard cut to extreme close-up CSS zoom on bust eyes, pull back

### Test Harness
- `AVATAR_TRANSITION_TEST=true` env var enables test mode
- Renders all 6 transitions in sequence, 5s each, looping
- Small overlay UI: current transition name + prev/next buttons
- Cycle time configurable: `AVATAR_TRANSITION_INTERVAL=5000`

### Files to Create/Modify
```
apps/web/src/components/avatar/
  IdleScene.tsx              # RPM + Three.js full-body scene
  VisionTracker.ts           # MediaPipe person detection → gaze yaw
  transitions/
    Transition.ts            # Interface
    ZoomIn.ts
    JogAndPeek.ts
    RunAndBounce.ts
    SitDown.ts
    DepthBlur.ts
    EyeMatchCut.ts
    TransitionEngine.ts      # Orchestrates, randomizes, test harness
  AvatarPanel.tsx            # UPDATE: add idle/engaged state machine
  useAvatarController.ts     # UPDATE: add vision tracking mode
```

### Idle/Engaged State Machine
```
IDLE: RPM full-body + vision gaze tracking
  → person detected at station + audio activity → TRANSITIONING
TRANSITIONING: play random transition (or next in test sequence)
  → transition complete → ENGAGED
ENGAGED: EL bust, lip sync, audio direction tracking
  → audio silence > 30s + no person detected → TRANSITIONING_OUT
TRANSITIONING_OUT: reverse transition (zoom out / walk away)
  → complete → IDLE
```

### RPM Character
- Load a default RPM avatar GLB (neutral, professional appearance)
- Mixamo animations to bundle: `idle.glb`, `walk.glb`, `jog.glb`, `sit.glb`
- Download from Mixamo and commit to `apps/web/public/animations/`
- Head/spine bones for gaze animation: use `SkeletonUtils` to clone + drive bones

### Notes
- AVATAR_MOCK=true: replace RPM scene with a CSS animated stick figure or simple SVG character. All transitions still run (simplified versions). Zero external deps.
- Gaze tracking: graceful fallback if camera permission denied — just use slow random idle
- Lip sync in ENGAGED mode: existing EL provider handles it (Phase 1)
- The bust EL/Simli overlay sits in a DOM layer above the Three.js canvas — no z-fighting
