/**
 * useAvatarController — React hook wiring:
 *  - Quorum synthesis output → avatar.speak() (only when a provider is configured)
 *  - Stereo mic → StereoAnalyzer → avatar.setHeadPose()
 *  - Webcam → VisionTracker → gaze yaw + pitch
 *  - Webcam → EmotionDetector → detected emotion
 *  - Health score delta → emotion
 */

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  createAvatarProvider,
  type AvatarProvider,
  type AvatarProviderType,
  type Emotion,
  type Direction,
} from "./AvatarProvider";
import { StereoAnalyzer } from "./StereoAnalyzer";
import { VisionTracker } from "./VisionTracker";
import { EmotionDetector, type DetectedEmotion } from "./EmotionDetector";
import { speakText as browserSpeakText } from "@/lib/speechSynthesis";

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
  /** Enable webcam emotion detection (default true in browser — callers override via prop) */
  enableEmotion?: boolean;
  /** Latest synthesis text to speak */
  synthesisText?: string;
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
}

export function useAvatarController(options: AvatarControllerOptions): AvatarControllerState {
  const {
    providerType,
    containerRef,
    healthScore,
    resolved = false,
    enableMic = true,
    enableVision = typeof window !== "undefined",
    enableEmotion = typeof window !== "undefined",
    synthesisText,
  } = options;

  const [state, setState] = useState<AvatarControllerState>({
    direction: "center",
    yaw: 0,
    pitch: 0,
    emotion: "neutral",
    detectedEmotion: "neutral",
    speaking: false,
    ready: false,
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
      onGaze: (yaw, pitch) => {
        visionYawRef.current = yaw;
        visionPitchRef.current = pitch ?? 0;
        mergeAndSetGaze(stereoYawRef.current, yaw, visionPitchRef.current);
      },
    });
    visionRef.current = tracker;
    tracker.start();

    return () => {
      tracker.stop();
      visionRef.current = null;
    };
  }, [enableVision, mergeAndSetGaze]);

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

  // Speak new synthesis text.
  // Priority: configured AvatarProvider (ElevenLabs/Simli) → browser SpeechSynthesis fallback.
  useEffect(() => {
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
  }, [synthesisText, healthScore, computeEmotion]);

  return state;
}
