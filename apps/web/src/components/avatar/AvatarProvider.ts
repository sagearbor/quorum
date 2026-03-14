/**
 * AvatarProvider — swappable provider pattern for real-time avatar rendering.
 * Supports ElevenLabs and Simli. MockProvider has been removed.
 */

export type Emotion = "neutral" | "engaged" | "tense" | "resolved";

export type Direction = "left" | "center" | "right";

export interface AvatarConfig {
  /** DOM element to mount the avatar into (if provider needs it) */
  containerEl?: HTMLElement;
  /** ElevenLabs agent ID */
  agentId?: string;
  /** API key (provider-specific) */
  apiKey?: string;
}

export interface AvatarProvider {
  /** Initialize the provider with config. Call once before speak/setHeadPose. */
  init(config: AvatarConfig): Promise<void>;
  /** Speak text with optional emotion. Resolves when speech starts (not ends). */
  speak(text: string, emotion?: Emotion): Promise<void>;
  /** Set head pose: yaw -1.0 (left) to 1.0 (right), pitch -1.0 (down) to 1.0 (up). */
  setHeadPose(yaw: number, pitch: number): void;
  /** True while the avatar is actively speaking. */
  isSpeaking(): boolean;
  /** Clean up resources (audio, video, connections). */
  destroy(): void;
}

export type AvatarProviderType = "elevenlabs" | "simli";

import { ElevenLabsProvider } from "./ElevenLabsProvider";
import { SimliProvider } from "./SimliProvider";

/**
 * Factory: create the appropriate AvatarProvider based on type or env vars.
 * Returns null if no provider type is configured — callers should handle this
 * gracefully (avatar panel works without a TTS provider).
 */
export function createAvatarProvider(type?: AvatarProviderType): AvatarProvider | null {
  const resolved = resolveProviderType(type);
  if (!resolved) return null;

  switch (resolved) {
    case "elevenlabs":
      return new ElevenLabsProvider();
    case "simli":
      return new SimliProvider();
    default:
      return null;
  }
}

function resolveProviderType(explicit?: AvatarProviderType): AvatarProviderType | null {
  if (explicit) return explicit;

  // Read from AVATAR_PROVIDER env var
  const envProvider =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_AVATAR_PROVIDER) || "";
  if (envProvider === "elevenlabs" || envProvider === "simli") {
    return envProvider;
  }

  // No provider configured
  return null;
}
