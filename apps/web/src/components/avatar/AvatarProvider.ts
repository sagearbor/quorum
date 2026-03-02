/**
 * AvatarProvider — swappable provider pattern for real-time avatar rendering.
 * Supports ElevenLabs, Simli, and a zero-API MockProvider for testing.
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

export type AvatarProviderType = "mock" | "elevenlabs" | "simli";

import { MockProvider } from "./MockProvider";
import { ElevenLabsProvider } from "./ElevenLabsProvider";
import { SimliProvider } from "./SimliProvider";

/**
 * Factory: create the appropriate AvatarProvider based on type or env vars.
 */
export function createAvatarProvider(type?: AvatarProviderType): AvatarProvider {
  const resolved = resolveProviderType(type);

  switch (resolved) {
    case "elevenlabs":
      return new ElevenLabsProvider();
    case "simli":
      return new SimliProvider();
    case "mock":
    default:
      return new MockProvider();
  }
}

function resolveProviderType(explicit?: AvatarProviderType): AvatarProviderType {
  if (explicit) return explicit;

  // AVATAR_MOCK=true always forces mock
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_AVATAR_MOCK === "true") {
    return "mock";
  }
  if (typeof process !== "undefined" && process.env?.AVATAR_MOCK === "true") {
    return "mock";
  }

  // Read from AVATAR_PROVIDER env var
  const envProvider =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_AVATAR_PROVIDER) || "";
  if (envProvider === "elevenlabs" || envProvider === "simli") {
    return envProvider;
  }

  // Default to mock for safety
  return "mock";
}
