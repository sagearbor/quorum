/**
 * useAvatarController — React hook wiring:
 *  - Quorum synthesis output → avatar.speak()
 *  - Stereo mic → StereoAnalyzer → avatar.setHeadPose()
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

export interface AvatarControllerOptions {
  /** Provider type override (defaults to env var or 'mock') */
  providerType?: AvatarProviderType;
  /** DOM element for the avatar to render into */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Current quorum health score (0-100) */
  healthScore: number;
  /** Whether the quorum is resolved */
  resolved?: boolean;
  /** Enable stereo mic analysis (default true in browser) */
  enableMic?: boolean;
  /** Enable webcam vision tracking (default true in browser) */
  enableVision?: boolean;
  /** Enable webcam emotion detection (default true in browser) */
  enableEmotion?: boolean;
  /** Latest synthesis text to speak */
  synthesisText?: string;
}

export interface AvatarControllerState {
  /** Current speaker direction */
  direction: Direction;
  /** Current yaw value (-1 to 1) — merged from stereo + vision */
  yaw: number;
  /** Current emotion (from health score delta) */
  emotion: Emotion;
  /** Current detected emotion from webcam face analysis */
  detectedEmotion: DetectedEmotion;
  /** Whether avatar is speaking */
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

  // Initialize provider
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const provider = createAvatarProvider(providerType);
    providerRef.current = provider;

    provider.init({ containerEl: container }).then(() => {
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
  const mergeAndSetYaw = useCallback((stereoYaw: number, visionYaw: number) => {
    // Vision takes priority when it has signal; blend with stereo
    // If vision is providing yaw, weight it 70/30 over stereo; otherwise stereo alone
    const hasVision = Math.abs(visionYaw) > 0.01;
    const mergedYaw = hasVision
      ? visionYaw * 0.7 + stereoYaw * 0.3
      : stereoYaw;
    const clampedYaw = Math.max(-1, Math.min(1, mergedYaw));

    let direction: Direction = "center";
    if (clampedYaw < -0.2) direction = "left";
    else if (clampedYaw > 0.2) direction = "right";

    setState((s) => ({ ...s, direction, yaw: clampedYaw }));
    providerRef.current?.setHeadPose(clampedYaw, 0);
  }, []);

  // Initialize stereo analyzer
  useEffect(() => {
    if (!enableMic) return;

    const analyzer = new StereoAnalyzer({
      onDirection: (_direction, yaw) => {
        stereoYawRef.current = yaw;
        mergeAndSetYaw(yaw, visionYawRef.current);
      },
    });
    analyzerRef.current = analyzer;
    analyzer.start();

    return () => {
      analyzer.stop();
      analyzerRef.current = null;
    };
  }, [enableMic, mergeAndSetYaw]);

  // Initialize VisionTracker (webcam person detection → gaze yaw)
  useEffect(() => {
    if (!enableVision) return;

    const tracker = new VisionTracker({
      onGaze: (yaw) => {
        visionYawRef.current = yaw;
        mergeAndSetYaw(stereoYawRef.current, yaw);
      },
    });
    visionRef.current = tracker;
    tracker.start();

    return () => {
      tracker.stop();
      visionRef.current = null;
    };
  }, [enableVision, mergeAndSetYaw]);

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

  // Speak new synthesis text
  useEffect(() => {
    if (!synthesisText || synthesisText === prevSynthesisRef.current) return;
    if (speakingRef.current) return; // Don't interrupt

    prevSynthesisRef.current = synthesisText;

    const provider = providerRef.current;
    if (!provider) return;

    speakingRef.current = true;
    setState((s) => ({ ...s, speaking: true }));

    const emotion = computeEmotion(healthScore, prevHealthRef.current);
    provider.speak(synthesisText, emotion).then(() => {
      speakingRef.current = false;
      setState((s) => ({ ...s, speaking: false }));
    });
  }, [synthesisText, healthScore, computeEmotion]);

  return state;
}
