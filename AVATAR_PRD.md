# Quorum Avatar System — PRD v2
**Project:** Duke Tech Expo 2026 | **Branch:** feature/avatar-facilitator  
**Updated:** 2026-03-02 based on Sage review

---

## Overview

An ambient + conversational avatar system for Quorum stations and the projector display. When no one is present, a full-body avatar idles and tracks passersby (haunted-painting effect). When someone sits down, it transitions into a close-up conversational mode with lip-synced speech.

---

## System Architecture

```
┌─────────────────────────────────────────────────────┐
│                  AvatarPanel (React)                 │
│                                                     │
│  State: IDLE ──→ TRANSITIONING ──→ ENGAGED          │
│          ↑                              │            │
│          └──────── TRANSITIONING_OUT ←─┘            │
│                                                     │
│  IDLE layer:     IdleScene (Three.js/RPM)           │
│  ENGAGED layer:  BustOverlay (ElevenLabs)           │
│                                                     │
│  Shared inputs:                                     │
│    VisionTracker → gaze yaw + emotion mirror        │
│    StereoAnalyzer → audio direction (engaged)       │
│    QuorumStore → health delta → emotion             │
└─────────────────────────────────────────────────────┘
```

---

## Role Archetype System (University-Wide)

Covers Duke Tech Expo audience — not just medical, but all university roles.

### Archetypes

| ID | GLB | Shirt | Covers |
|---|---|---|---|
| `medical_clinical` | medical.glb | Duke blue | Physician, Doctor, Surgeon, Nurse, Clinician, PA, NP |
| `researcher` | researcher.glb | Duke blue | Scientist, PI, Postdoc, Biologist, Chemist, Lab Director |
| `faculty` | faculty.glb | Duke blue | Professor, Instructor, Lecturer, "Dr.", Faculty |
| `student_grad` | grad_student.glb | Duke blue | PhD, Grad Student, Masters, Resident, Fellow |
| `student_undergrad` | undergrad.glb | Duke t-shirt | Undergrad, Freshman, Sophomore, Junior, Senior, Student |
| `administrator` | administrator.glb | Duke blue | Dean, Provost, Chair, Director, VP, Chancellor, President |
| `ethics` | ethics.glb | Duke blue | Ethicist, IRB, Compliance, Bioethicist, Policy, Regulatory |
| `engineer_tech` | tech.glb | Duke blue | Engineer, Developer, Data Scientist, Analyst, IT |
| `finance_ops` | finance.glb | Duke blue | Finance, CFO, Operations, HR, Budget, Accounting |
| `patient_participant` | patient.glb | Neutral | Patient, Participant, Subject, Volunteer, Community Member |
| `humanities_social` | humanities.glb | Duke blue | Historian, Philosopher, Sociologist, Anthropologist, Ethicist |
| `neutral` | neutral.glb | Duke blue | Default fallback, Moderator, Facilitator, Observer |

### Runtime Mapping

```typescript
function resolveArchetype(roleName: string): ArchetypeId {
  const r = roleName.toLowerCase();
  if (/physician|doctor|surgeon|nurse|clinician|clinical|\bpa\b|\bnp\b|medical/.test(r)) return 'medical_clinical';
  if (/scientist|researcher|\bpi\b|postdoc|biolog|chemist|lab director/.test(r)) return 'researcher';
  if (/professor|instructor|lecturer|faculty/.test(r)) return 'faculty';
  if (/phd|grad student|masters|resident|fellow|doctoral/.test(r)) return 'student_grad';
  if (/undergrad|freshman|sophomore|junior|senior|\bstudent\b/.test(r)) return 'student_undergrad';
  if (/dean|provost|chair|director|chancellor|president|\bvp\b|administrator/.test(r)) return 'administrator';
  if (/ethicist|irb|compliance|bioethics|policy|regulatory/.test(r)) return 'ethics';
  if (/engineer|developer|data |analyst|\bit\b|software|tech/.test(r)) return 'engineer_tech';
  if (/finance|cfo|operations|\bhr\b|budget|accounting/.test(r)) return 'finance_ops';
  if (/patient|participant|subject|volunteer|community/.test(r)) return 'patient_participant';
  if (/histor|philosoph|sociolog|anthropolog|humanit/.test(r)) return 'humanities_social';
  return 'neutral';
}
```

Duke branding: all non-patient archetypes wear Duke blue (#003087) shirt via Three.js material override at load time.

---

## Personality Profiles

| Archetype | walkSpeed | gestureFreq | fidget | headSway | elStability | elStyle | elRate |
|---|---|---|---|---|---|---|---|
| medical_clinical | 0.8 | 0.4 | 0.2 | 3° | 0.85 | 0.2 | 0.9 |
| researcher | 1.1 | 0.7 | 0.5 | 6° | 0.65 | 0.6 | 1.1 |
| faculty | 0.9 | 0.5 | 0.3 | 4° | 0.80 | 0.3 | 0.95 |
| student_grad | 1.0 | 0.6 | 0.5 | 5° | 0.70 | 0.5 | 1.05 |
| student_undergrad | 1.2 | 0.8 | 0.7 | 7° | 0.60 | 0.7 | 1.15 |
| administrator | 0.7 | 0.3 | 0.1 | 2° | 0.90 | 0.15 | 0.85 |
| ethics | 0.8 | 0.4 | 0.2 | 3° | 0.82 | 0.25 | 0.90 |
| engineer_tech | 1.0 | 0.6 | 0.4 | 4° | 0.72 | 0.5 | 1.05 |
| finance_ops | 0.75 | 0.35 | 0.2 | 3° | 0.85 | 0.2 | 0.88 |
| patient_participant | 0.9 | 0.5 | 0.6 | 5° | 0.70 | 0.4 | 1.0 |
| humanities_social | 0.9 | 0.6 | 0.4 | 5° | 0.68 | 0.55 | 1.0 |
| neutral | 0.9 | 0.5 | 0.3 | 4° | 0.75 | 0.35 | 1.0 |

---

## Vision Tracking + Emotion Mirroring

### Gaze (Phase 4A)

MediaPipe `PersonDetector` → bounding box centroid X → avatar head yaw.

| Mode | Trigger | Behavior |
|---|---|---|
| `idle_random` | No person > 10s | Slow random glances, occasional look-down |
| `tracking` | Person detected | Head tracks centroid X |
| `engaged` | Audio active | Audio direction takes over |

### Emotion Detection + Mirroring (Phase 4B — NEW)

**Tech:** MediaPipe `FaceLandmarker` (same WASM bundle, no extra dep) → 478 face landmarks → derive emotion.

```
Webcam → FaceLandmarker → landmark geometry
  ↓ classify: smile, frown, raised brows, wide eyes, tense jaw
  ↓ map to: happy | surprised | concerned | fearful | neutral | engaged
AvatarController.setEmotion(detected)
  ├── RPM full-body: blend shape / expression bone weights
  └── EL bust: emotion param on next speak() call
```

**Mirroring behavior:** Avatar subtly reflects the detected human emotion — if they smile, avatar brightens; if tense/concerned, avatar shifts to attentive/focused. Delay of ~1s to avoid jarring snaps. Max 60% intensity (never over-mirror).

**Landmark-to-emotion map:**
- Lip corner raise → `happy`
- Brow raise + eye wide → `surprised`
- Brow furrow + lip press → `concerned`
- Jaw tension + eye tension → `focused`
- Relaxed baseline → `neutral`

---

## Transitions (6)

All transitions bridge RPM full-body → EL bust. Each is a class implementing `Transition.play(): Promise<void>`.

1. **ZoomIn** — camera push to face, bust crossfades in at 70%. Elegant/cinematic.
2. **JogAndPeek** — avatar jogs off edge, bust slides in from same edge with spring.
3. **RunAndBounce** — avatar sprints at camera, screen flash, bust bounces in with squash.
4. **SitDown** — Mixamo sit animation, camera lowers, bust crossfades. Most humanizing.
5. **DepthBlur** — scene blurs, bust fades in sharp. Elegant/abstract.
6. **EyeMatchCut** — hard cut to extreme close-up eyes, pulls back to bust. Dramatic.

Archetype → preferred transitions (see v1 for table, unchanged).

---

## Parallel Build Tracks

Designed for simultaneous agent deployment. No track has hard dependencies on another until integration.

### Track A — Asset Pipeline (Agent A)
**Goal:** Automate RPM avatar creation + Mixamo animation download. No manual work for Sage.
- [ ] Script: `scripts/create-rpm-avatars.sh` — calls RPM Partner API to generate all 12 archetype avatars, downloads GLBs to `public/avatars/`
- [ ] Script: `scripts/download-animations.sh` — downloads idle/walk/jog/sit GLBs from a free source (Quaternius or similar CC0 library, Mixamo requires login so use fallback)
- [ ] Fallback: if RPM API unavailable, generate procedural placeholder meshes in Three.js (colored capsule with head sphere, archetype-colored shirt)
- [ ] README: `public/avatars/README.md` — how to replace placeholders with real RPM GLBs

### Track B — Archetype + Personality System (Agent B)
**Goal:** Role resolution, personality profiles, Duke branding.
- [ ] `archetypes/archetypes.ts` — all 12 archetype definitions + personality profiles
- [ ] `archetypes/resolveArchetype.ts` — keyword matcher, returns ArchetypeId
- [ ] `archetypes/resolveArchetype.test.ts` — test all keyword cases
- [ ] Duke blue material override utility (Three.js MeshStandardMaterial swap at load)

### Track C — IdleScene + Vision (Agent C)
**Goal:** Full-body Three.js scene with gaze + emotion detection.
- [ ] `IdleScene.tsx` — React Three Fiber canvas, loads RPM GLB, plays animations
- [ ] `VisionTracker.ts` — MediaPipe PersonDetector → gaze yaw
- [ ] `EmotionDetector.ts` — MediaPipe FaceLandmarker → emotion classification
- [ ] `IdleScene.test.tsx` — mock Three.js, test gaze/emotion state updates
- [ ] Idle alive behaviors (random glances, blinks, breathing)

### Track D — Transitions (Agent D)
**Goal:** All 6 transition classes + engine + test harness.
- [ ] `transitions/Transition.ts` — interface
- [ ] `transitions/ZoomIn.ts`
- [ ] `transitions/JogAndPeek.ts`
- [ ] `transitions/RunAndBounce.ts`
- [ ] `transitions/SitDown.ts`
- [ ] `transitions/DepthBlur.ts`
- [ ] `transitions/EyeMatchCut.ts`
- [ ] `transitions/TransitionEngine.ts` — archetype-weighted random + test harness
- [ ] `transitions/*.test.ts` — mock DOM/Three.js, test all transitions fire+complete

### Track E — Integration (Agent E, runs AFTER A-D)
**Goal:** Wire everything into AvatarPanel, keep all tests green.
- [ ] Update `AvatarPanel.tsx` — idle/engaged state machine
- [ ] Update `useAvatarController.ts` — vision + emotion modes
- [ ] Integration tests: full state machine (idle→transition→engaged→transition_out→idle)
- [ ] `AVATAR_TRANSITION_TEST=true` test harness in AvatarPanel
- [ ] Verify all 131 frontend + 78 backend tests green

---

## What Sage Needs to Do

- [ ] Create ElevenLabs account (free tier), create a Conversational AI agent, drop Agent ID + API key in `.env.local`
- [ ] (Optional) Replace placeholder GLBs with hand-crafted RPM avatars if you want custom looks

Everything else (RPM API, animations, all code) handled by agents.

---

## Environment Variables

```bash
AVATAR_PROVIDER=elevenlabs        # elevenlabs | simli | heygen | mock
AVATAR_MOCK=false
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=...
SIMLI_API_KEY=...                 # optional
AVATAR_TRANSITION_TEST=false
AVATAR_TRANSITION_INTERVAL=5000
AVATAR_DEFAULT_ARCHETYPE=neutral
AVATAR_EMOTION_MIRROR=true        # enable face emotion detection + mirroring
```

---
*v2 — Sophie 🎭, 2026-03-02. Changes: expanded archetypes to 12 (university-wide), added emotion mirroring, automated asset pipeline, parallel build tracks with checkboxes.*
