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
