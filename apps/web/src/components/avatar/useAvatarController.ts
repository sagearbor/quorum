/**
 * useAvatarController — React hook wiring:
 *  - Quorum synthesis output → avatar.speak() (only when a provider is configured)
 *  - Stereo mic → StereoAnalyzer → avatar.setHeadPose()
 *  - Webcam → VisionTracker → gaze yaw + pitch
 *  - Webcam → EmotionDetector → detected emotion
 *  - Health score delta → emotion
 */

"use client";

import { useEffect, useRef, useState, useCallback, type RefObject } from "react";
import {
  createAvatarProvider,
  type AvatarProvider,
  type AvatarProviderType,
  type Emotion,
  type Direction,
} from "./AvatarProvider";
import { StereoAnalyzer } from "./StereoAnalyzer";
import { VisionTracker, type PresencePayload } from "./VisionTracker";
import { EmotionDetector, type DetectedEmotion } from "./EmotionDetector";
import { speakText as browserSpeakText } from "@/lib/speechSynthesis";
import { nextChoreography, type ChoreographyState } from "./choreographer";
import { vowelToMorphShape, type Vowel } from "./visemes";
import type { IdleSceneHandle } from "./IdleScene";

/**
 * Read once at module load: when NEXT_PUBLIC_AVATAR_CHOREOGRAPHY === "bust_only"
 * the choreographer short-circuits to a permanent bust framing with no walking,
 * Z motion, or vision-driven state changes. Safety net for the expo when full
 * choreography misbehaves on stage.
 */
const BUST_ONLY =
  typeof process !== "undefined" &&
  process.env?.NEXT_PUBLIC_AVATAR_CHOREOGRAPHY === "bust_only";

export interface AvatarControllerOptions {
  /**
   * Provider type override. When omitted, the factory reads NEXT_PUBLIC_AVATAR_PROVIDER.
   * If no provider is configured the controller still works — VisionTracker, StereoAnalyzer,
   * and EmotionDetector run normally; speak() is simply a no-op.
   */
  providerType?: AvatarProviderType;
  /**
   * DOM element for the avatar provider to render into (provider-specific, optional).
   * Only required by providers that embed their own UI (e.g. Simli iframe).
   */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Current quorum health score (0-100) */
  healthScore: number;
  /** Whether the quorum is resolved */
  resolved?: boolean;
  /** Enable stereo mic analysis (default true in browser) */
  enableMic?: boolean;
  /** Enable webcam vision tracking (default true in browser) */
  enableVision?: boolean;
  /** Enable webcam emotion detection (default false — callers control via enableEmotionTracking prop) */
  enableEmotion?: boolean;
  /** Latest synthesis text to speak */
  synthesisText?: string;
  /**
   * Facilitator paused signal — the backend LLM call failed for the latest
   * turn. When true the controller MUST NOT speak anything (no provider.speak,
   * no browserSpeakText). The conversation should look as if the agent simply
   * didn't reply this turn. Clears automatically on the next non-paused reply.
   */
  paused?: boolean;
  /** Human-readable reason for the pause, e.g. "llm_unavailable" */
  pausedReason?: string | null;
  /** Specific webcam deviceId. When changed, the VisionTracker restarts on the new camera. */
  cameraDeviceId?: string;
  /**
   * Optional ref to the IdleScene's imperative handle. When provided, the
   * choreographer's per-RAF output is routed to setFraming + setBodyPose.
   * AvatarPanel owns this ref; passing it in here lets the controller drive
   * the scene without needing to lift the choreographer state up to the panel.
   */
  idleSceneRef?: RefObject<IdleSceneHandle | null>;
}

export interface AvatarControllerState {
  /** Current speaker direction */
  direction: Direction;
  /** Current yaw value (-1 to 1) — merged from stereo + vision */
  yaw: number;
  /** Current pitch value (-1 to 1) — from vision tracker */
  pitch: number;
  /** Current emotion (from health score delta) */
  emotion: Emotion;
  /** Current detected emotion from webcam face analysis */
  detectedEmotion: DetectedEmotion;
  /** Whether avatar is speaking (only meaningful when a provider is active) */
  speaking: boolean;
  /** Whether the controller is initialized */
  ready: boolean;
  /**
   * True when the backend has signalled that the facilitator is paused
   * (e.g. LLM unavailable). The controller does not speak in this state.
   * Components render a calm status pill instead of an assistant message.
   */
  paused: boolean;
  /** Human-readable reason supplied by the backend (e.g. "llm_unavailable"). */
  pausedReason: string | null;
}

export function useAvatarController(options: AvatarControllerOptions): AvatarControllerState {
  const {
    providerType,
    containerRef,
    healthScore,
    resolved = false,
    enableMic = true,
    enableVision = typeof window !== "undefined",
    enableEmotion = false,
    synthesisText,
    paused = false,
    pausedReason = null,
    cameraDeviceId,
    idleSceneRef,
  } = options;

  const [state, setState] = useState<AvatarControllerState>({
    direction: "center",
    yaw: 0,
    pitch: 0,
    emotion: "neutral",
    detectedEmotion: "neutral",
    speaking: false,
    ready: false,
    paused: false,
    pausedReason: null,
  });

  const providerRef = useRef<AvatarProvider | null>(null);
  const analyzerRef = useRef<StereoAnalyzer | null>(null);
  const visionRef = useRef<VisionTracker | null>(null);
  const emotionDetectorRef = useRef<EmotionDetector | null>(null);
  const prevHealthRef = useRef<number>(healthScore);
  const prevSynthesisRef = useRef<string | undefined>(undefined);
  const speakingRef = useRef(false);
  // Track gaze sources separately so we can merge them
  const stereoYawRef = useRef(0);
  const visionYawRef = useRef(0);
  const visionPitchRef = useRef(0);

  // Choreographer state — driven per-RAF in the effect below.
  const choreoStateRef = useRef<ChoreographyState>("idle_pacing");
  const msInStateRef = useRef(0);
  // Start "long ago" so the controller doesn't think narration is fresh on
  // first mount — otherwise the approach → talking transition would fire
  // immediately on a non-existent narration.
  const msSinceNarrationRef = useRef(99999);
  const lastTickRef = useRef(0);
  // Visemes (Task 13) — counts RAF ticks while speakingRef is true so we can
  // cycle through vowels at a phoneme-ish cadence. Reset to 0 on silence so
  // the next utterance starts clean.
  const visemeTickRef = useRef(0);
  const presenceRef = useRef<PresencePayload>({
    detected: false,
    sizeRatio: 0,
    durationMs: 0,
  });
  const latestNarrationRef = useRef<string | undefined>(undefined);

  // Compute emotion from health score delta
  const computeEmotion = useCallback(
    (currentScore: number, prevScore: number): Emotion => {
      if (resolved) return "resolved";
      const delta = currentScore - prevScore;
      if (delta > 0) return "engaged";
      if (delta < -5) return "tense";
      return "neutral";
    },
    [resolved],
  );

  // Initialize provider (optional — skipped when createAvatarProvider returns null)
  useEffect(() => {
    const container = containerRef?.current ?? null;
    const provider = createAvatarProvider(providerType);

    if (!provider) {
      // No provider configured — controller still works for gaze/emotion tracking
      setState((s) => ({ ...s, ready: true }));
      return;
    }

    providerRef.current = provider;

    provider.init({ containerEl: container ?? undefined }).then(() => {
      setState((s) => ({ ...s, ready: true }));
    });

    return () => {
      provider.destroy();
      providerRef.current = null;
      setState((s) => ({ ...s, ready: false }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerType]);

  // Helper: merge stereo + vision yaw and update state
  const mergeAndSetGaze = useCallback((stereoYaw: number, visionYaw: number, visionPitch: number) => {
    // Vision takes priority when it has signal; blend with stereo
    // If vision is providing yaw, weight it 70/30 over stereo; otherwise stereo alone
    const hasVision = Math.abs(visionYaw) > 0.01;
    const mergedYaw = hasVision
      ? visionYaw * 0.7 + stereoYaw * 0.3
      : stereoYaw;
    const clampedYaw = Math.max(-1, Math.min(1, mergedYaw));
    const clampedPitch = Math.max(-1, Math.min(1, visionPitch));

    let direction: Direction = "center";
    if (clampedYaw < -0.2) direction = "left";
    else if (clampedYaw > 0.2) direction = "right";

    setState((s) => ({ ...s, direction, yaw: clampedYaw, pitch: clampedPitch }));
    providerRef.current?.setHeadPose(clampedYaw, clampedPitch);
  }, []);

  // Initialize stereo analyzer
  useEffect(() => {
    if (!enableMic) return;

    const analyzer = new StereoAnalyzer({
      onDirection: (_direction, yaw) => {
        stereoYawRef.current = yaw;
        mergeAndSetGaze(yaw, visionYawRef.current, visionPitchRef.current);
      },
    });
    analyzerRef.current = analyzer;
    analyzer.start();

    return () => {
      analyzer.stop();
      analyzerRef.current = null;
    };
  }, [enableMic, mergeAndSetGaze]);

  // Initialize VisionTracker (webcam person detection → gaze yaw)
  useEffect(() => {
    if (!enableVision) return;

    const tracker = new VisionTracker({
      onGaze: (yaw, pitch, presence) => {
        visionYawRef.current = yaw;
        visionPitchRef.current = pitch ?? 0;
        if (presence) presenceRef.current = presence;
        mergeAndSetGaze(stereoYawRef.current, yaw, visionPitchRef.current);
      },
      deviceId: cameraDeviceId,
    });
    visionRef.current = tracker;
    tracker.start();

    return () => {
      tracker.stop();
      visionRef.current = null;
    };
  }, [enableVision, mergeAndSetGaze, cameraDeviceId]);

  // Initialize EmotionDetector (webcam face landmarks → emotion)
  useEffect(() => {
    if (!enableEmotion) return;

    const detector = new EmotionDetector({
      onEmotion: (emotion) => {
        setState((s) => ({ ...s, detectedEmotion: emotion }));
      },
    });
    emotionDetectorRef.current = detector;
    detector.start();

    return () => {
      detector.stop();
      emotionDetectorRef.current = null;
    };
  }, [enableEmotion]);

  // Update emotion on health score change
  useEffect(() => {
    const emotion = computeEmotion(healthScore, prevHealthRef.current);
    prevHealthRef.current = healthScore;
    setState((s) => ({ ...s, emotion }));
  }, [healthScore, computeEmotion]);

  // Mirror the paused prop into state so consumers (AvatarPanel) can render
  // a status pill. When paused becomes false again (next non-paused reply),
  // the pill auto-dismisses.
  useEffect(() => {
    setState((s) => {
      if (s.paused === paused && s.pausedReason === pausedReason) return s;
      return { ...s, paused, pausedReason };
    });
  }, [paused, pausedReason]);

  // Track narration arrival for the choreographer. We reset
  // ``msSinceNarrationRef`` to 0 whenever a new non-empty synthesisText arrives
  // — this is independent of TTS state (paused / speaking dedup), since the
  // choreographer cares about narration *availability*, not whether the
  // provider actually spoke it. ``latestNarrationRef`` mirrors the value so
  // the RAF tick can pass it into the choreographer without re-rendering.
  useEffect(() => {
    if (!synthesisText) return;
    if (synthesisText === latestNarrationRef.current) return;
    latestNarrationRef.current = synthesisText;
    msSinceNarrationRef.current = 0;
  }, [synthesisText]);

  // Per-RAF tick driving the choreographer. Reads presence from the vision
  // tracker, speaking state, and narration tracking refs; pushes the result
  // to the IdleScene handle (framing + body pose). Runs unconditionally so the
  // pacing sine wave keeps animating even before the first user is detected.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const dtMs = lastTickRef.current === 0 ? 0 : now - lastTickRef.current;
      lastTickRef.current = now;

      msInStateRef.current += dtMs;
      msSinceNarrationRef.current += dtMs;

      const out = nextChoreography(
        choreoStateRef.current,
        {
          presence: presenceRef.current,
          speaking: speakingRef.current,
          narrationText: latestNarrationRef.current,
          msSinceLastNarration: msSinceNarrationRef.current,
          msInCurrentState: msInStateRef.current,
          bustOnly: BUST_ONLY,
        },
        dtMs,
      );

      if (out.state !== choreoStateRef.current) {
        choreoStateRef.current = out.state;
        msInStateRef.current = 0;
      }

      const handle = idleSceneRef?.current;
      if (handle) {
        handle.setFraming(out.cameraFraming === "bust" ? "bust" : "full_body");
        handle.setBodyPose({ x: out.bodyX, z: out.bodyZ, yaw: out.bodyYaw, clip: out.animationClip });
        // Visemes (Task 13) — synthetic AH/EE/OO/MM alternation while speaking.
        // The current AvatarProvider abstraction does not expose a usable
        // <audio>/MediaStreamAudioSourceNode for AnalyserNode tapping, and the
        // expo demo runs with audio OFF (the avatar visually mouths the
        // narration on a silent floor). Phoneme accuracy doesn't matter at
        // projector distance — what reads is "the mouth is moving in time
        // with the narration." Phoneme-accurate FFT-driven visemes are a
        // future swap once the provider exposes its audio source.
        if (speakingRef.current) {
          visemeTickRef.current += 1;
          // Cycle vowels every ~10 frames (~167ms at 60fps) — phoneme cadence.
          const phase = Math.floor(visemeTickRef.current / 10) % 4;
          const vowel = (["AH", "EE", "OO", "MM"] as const)[phase] as Vowel;
          handle.setMouthShape(vowelToMorphShape(vowel));
        } else {
          visemeTickRef.current = 0;
          handle.setMouthShape(null);
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      lastTickRef.current = 0;
    };
  }, [idleSceneRef]);

  // Speak new synthesis text.
  // Priority: configured AvatarProvider (ElevenLabs/Simli) → browser SpeechSynthesis fallback.
  //
  // CRITICAL: when ``paused`` is true the controller MUST NOT speak. The
  // backend uses a paused sentinel when the LLM is unavailable; speaking the
  // sentinel (or any error string) on the 60-inch projector reads as "the
  // AI is broken" to the audience. Stay silent and let AvatarPanel surface
  // the recovery pill instead.
  useEffect(() => {
    if (paused) {
      // Track the synthesisText so a subsequent non-paused identical reply
      // is not blocked by the dedup guard.
      prevSynthesisRef.current = synthesisText;
      return;
    }
    if (!synthesisText || synthesisText === prevSynthesisRef.current) return;
    if (speakingRef.current) return; // Don't interrupt current speech

    prevSynthesisRef.current = synthesisText;
    speakingRef.current = true;
    setState((s) => ({ ...s, speaking: true }));

    const done = () => {
      speakingRef.current = false;
      setState((s) => ({ ...s, speaking: false }));
    };

    const provider = providerRef.current;
    if (provider) {
      const emotion = computeEmotion(healthScore, prevHealthRef.current);
      provider.speak(synthesisText, emotion).then(done);
    } else {
      // No provider configured — fall back to browser Web Speech Synthesis API.
      // This gives immediate audible feedback without requiring external credentials.
      browserSpeakText(synthesisText).then(done);
    }
  }, [synthesisText, healthScore, computeEmotion, paused]);

  return state;
}
