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
  /** Latest synthesis text to speak */
  synthesisText?: string;
}

export interface AvatarControllerState {
  /** Current speaker direction */
  direction: Direction;
  /** Current yaw value (-1 to 1) */
  yaw: number;
  /** Current emotion */
  emotion: Emotion;
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
    synthesisText,
  } = options;

  const [state, setState] = useState<AvatarControllerState>({
    direction: "center",
    yaw: 0,
    emotion: "neutral",
    speaking: false,
    ready: false,
  });

  const providerRef = useRef<AvatarProvider | null>(null);
  const analyzerRef = useRef<StereoAnalyzer | null>(null);
  const prevHealthRef = useRef<number>(healthScore);
  const prevSynthesisRef = useRef<string | undefined>(undefined);
  const speakingRef = useRef(false);

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

  // Initialize stereo analyzer
  useEffect(() => {
    if (!enableMic) return;

    const analyzer = new StereoAnalyzer({
      onDirection: (direction, yaw) => {
        setState((s) => ({ ...s, direction, yaw }));
        providerRef.current?.setHeadPose(yaw, 0);
      },
    });
    analyzerRef.current = analyzer;
    analyzer.start();

    return () => {
      analyzer.stop();
      analyzerRef.current = null;
    };
  }, [enableMic]);

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
