/**
 * AvatarPanel — Facilitator avatar panel with 3D GLB avatar.
 * Uses IdleScene for rendering (Three.js).
 * VisionTracker + EmotionDetector drive gaze and expressions via useAvatarController.
 * TTS is provider-driven (ElevenLabs / Simli) — no provider is wired by default until
 * a real LLM conversation channel is connected.
 */

"use client";

import { useRef, useEffect, useMemo } from "react";
import { useAvatarController } from "./useAvatarController";
import { useQuorumLive } from "@/hooks/useQuorumLive";
import { IdleScene, type IdleSceneHandle } from "./IdleScene";
import { resolveArchetype } from "./archetypes/resolveArchetype";
import { ARCHETYPES, resolveGlbUrl } from "./archetypes/archetypes";

interface AvatarPanelProps {
  quorumId: string;
  /** Show dev-mode direction indicator (default false) */
  showDirectionIndicator?: boolean;
  /** Enable webcam emotion tracking (default false — only enable on station pages with webcam) */
  enableEmotionTracking?: boolean;
  /** For testing: bypass useQuorumLive with a static score */
  staticHealthScore?: number;
  /** For testing: synthesis text to speak */
  staticSynthesisText?: string;
  /** Role name used to resolve archetype and GLB model */
  roleName?: string;
}

export function AvatarPanel({
  quorumId,
  showDirectionIndicator = false,
  enableEmotionTracking = false,
  staticHealthScore,
  staticSynthesisText,
  roleName,
}: AvatarPanelProps) {
  const idleSceneRef = useRef<IdleSceneHandle>(null);

  // Get live quorum data (unless overridden for testing)
  const liveState = useQuorumLive(quorumId);
  const healthScore = staticHealthScore ?? liveState.healthScore;
  const resolved = liveState.artifact?.status === "final";

  // Resolve archetype from role name
  const effectiveRoleName = roleName
    ?? (liveState.recentContributions.length > 0
      ? liveState.recentContributions[0].role_name
      : undefined);

  const glbUrl = useMemo(() => {
    const archetypeId = resolveArchetype(effectiveRoleName ?? "");
    const archetype = ARCHETYPES[archetypeId];
    return resolveGlbUrl(archetype);
  }, [effectiveRoleName]);

  // Synthesis text: only speak LLM-generated output, never parrot user contributions.
  // TODO: wire to Tier 3 artifact synthesis or a dedicated facilitator response channel
  const latestSynthesis = staticSynthesisText ?? undefined;

  // useAvatarController manages gaze (VisionTracker + StereoAnalyzer), emotion
  // (EmotionDetector + health score), and optional TTS when a provider is configured.
  const avatarState = useAvatarController({
    healthScore,
    resolved,
    enableMic: typeof window !== "undefined",
    enableEmotion: enableEmotionTracking,
    synthesisText: latestSynthesis,
  });

  // Connect gaze (yaw + pitch) from controller to IdleScene
  useEffect(() => {
    if (idleSceneRef.current) {
      idleSceneRef.current.setGaze(avatarState.yaw, avatarState.pitch);
    }
  }, [avatarState.yaw, avatarState.pitch]);

  // Connect detected emotion from controller to IdleScene
  useEffect(() => {
    if (idleSceneRef.current) {
      idleSceneRef.current.setEmotion(avatarState.detectedEmotion);
    }
  }, [avatarState.detectedEmotion]);

  return (
    <div
      className="w-full h-full flex flex-col items-center justify-center relative bg-black/20 rounded-xl"
      data-testid="avatar-panel"
    >
      {/* 3D avatar — IdleScene handles WebGL */}
      <div
        className="flex-1 flex items-center justify-center min-h-0 w-full"
        data-testid="avatar-container"
      >
        <IdleScene
          ref={idleSceneRef}
          glbUrl={glbUrl}
          width="100%"
          height="100%"
        />
      </div>

      {/* Status bar */}
      <div className="w-full px-4 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-2" data-testid="avatar-status">
          <div
            className={`w-2 h-2 rounded-full transition-colors duration-300 ${
              avatarState.speaking ? "bg-emerald-400 animate-pulse" : "bg-white/20"
            }`}
          />
          <span className="text-xs text-white/50">
            {avatarState.speaking ? "Speaking…" : "Facilitator"}
          </span>
        </div>

        <span
          className={`text-xs px-2 py-0.5 rounded-full ${emotionStyles[avatarState.emotion]}`}
          data-testid="avatar-emotion"
        >
          {avatarState.emotion}
        </span>

        {showDirectionIndicator && (
          <div className="flex items-center gap-1" data-testid="avatar-direction">
            <DirectionDot active={avatarState.direction === "left"} label="L" />
            <DirectionDot active={avatarState.direction === "center"} label="C" />
            <DirectionDot active={avatarState.direction === "right"} label="R" />
          </div>
        )}
      </div>

      {avatarState.speaking && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex gap-0.5" data-testid="avatar-waveform">
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className="w-1 bg-emerald-400/60 rounded-full animate-pulse"
              style={{
                height: `${8 + Math.random() * 16}px`,
                animationDelay: `${i * 0.1}s`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const emotionStyles: Record<string, string> = {
  neutral: "bg-white/10 text-white/50",
  engaged: "bg-emerald-500/20 text-emerald-400",
  tense: "bg-red-500/20 text-red-400",
  resolved: "bg-purple-500/20 text-purple-400",
};

function DirectionDot({ active, label }: { active: boolean; label: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        className={`w-1.5 h-1.5 rounded-full transition-colors duration-200 ${
          active ? "bg-yellow-400" : "bg-white/10"
        }`}
      />
      <span className="text-[8px] text-white/30">{label}</span>
    </div>
  );
}
