/**
 * AvatarPanel — Facilitator avatar panel for /display carousel.
 * Full-screen avatar with waveform indicator and L/C/R direction dot (dev mode).
 */

"use client";

import { useRef } from "react";
import { useAvatarController, type AvatarControllerOptions } from "./useAvatarController";
import { useQuorumLive } from "@/hooks/useQuorumLive";
import type { AvatarProviderType } from "./AvatarProvider";

interface AvatarPanelProps {
  quorumId: string;
  providerType?: AvatarProviderType;
  /** Show dev-mode direction indicator (default false) */
  showDirectionIndicator?: boolean;
  /** For testing: bypass useQuorumLive with a static score */
  staticHealthScore?: number;
  /** For testing: synthesis text to speak */
  staticSynthesisText?: string;
}

export function AvatarPanel({
  quorumId,
  providerType,
  showDirectionIndicator = false,
  staticHealthScore,
  staticSynthesisText,
}: AvatarPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Get live quorum data (unless overridden for testing)
  const liveState = useQuorumLive(quorumId);
  const healthScore = staticHealthScore ?? liveState.healthScore;
  const resolved = liveState.artifact?.status === "final";

  // Get latest synthesis text from recent contributions (last one as proxy)
  const latestSynthesis =
    staticSynthesisText ??
    (liveState.recentContributions.length > 0
      ? liveState.recentContributions[liveState.recentContributions.length - 1].content
      : undefined);

  const avatarState = useAvatarController({
    providerType,
    containerRef: containerRef as React.RefObject<HTMLElement | null>,
    healthScore,
    resolved,
    enableMic: typeof window !== "undefined",
    synthesisText: latestSynthesis,
  });

  return (
    <div
      className="w-full h-full flex flex-col items-center justify-center relative bg-black/20 rounded-xl"
      data-testid="avatar-panel"
    >
      {/* Avatar container */}
      <div
        ref={containerRef}
        className="flex-1 flex items-center justify-center min-h-0 w-full max-w-lg"
        data-testid="avatar-container"
      />

      {/* Status bar */}
      <div className="w-full px-4 pb-3 flex items-center justify-between">
        {/* Speaking indicator / waveform */}
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

        {/* Emotion badge */}
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${emotionStyles[avatarState.emotion]}`}
          data-testid="avatar-emotion"
        >
          {avatarState.emotion}
        </span>

        {/* Direction indicator (dev mode only) */}
        {showDirectionIndicator && (
          <div className="flex items-center gap-1" data-testid="avatar-direction">
            <DirectionDot active={avatarState.direction === "left"} label="L" />
            <DirectionDot active={avatarState.direction === "center"} label="C" />
            <DirectionDot active={avatarState.direction === "right"} label="R" />
          </div>
        )}
      </div>

      {/* Waveform visualization (simple bar animation when speaking) */}
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
