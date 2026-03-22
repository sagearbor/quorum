/**
 * ElevenLabsProvider — ElevenLabs Conversational AI SDK integration.
 * Uses the @11labs/react SDK if available, otherwise falls back to REST TTS.
 */

import type { AvatarProvider, AvatarConfig, Emotion } from "./AvatarProvider";

export class ElevenLabsProvider implements AvatarProvider {
  private apiKey: string | null = null;
  private agentId: string | null = null;
  private container: HTMLElement | null = null;
  private speaking = false;
  private currentAudio: HTMLAudioElement | null = null;

  async init(config: AvatarConfig): Promise<void> {
    this.apiKey =
      config.apiKey ??
      (typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_ELEVENLABS_API_KEY : null) ??
      null;
    this.agentId =
      config.agentId ??
      (typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_ELEVENLABS_AGENT_ID : null) ??
      null;
    this.container = config.containerEl ?? null;

    if (!this.apiKey) {
      console.warn("ElevenLabsProvider: No API key configured. Speak calls will be no-ops.");
    }
  }

  async speak(text: string, emotion?: Emotion): Promise<void> {
    if (!this.apiKey) return;

    this.speaking = true;

    try {
      // Use ElevenLabs TTS REST API
      const voiceSettings = emotionToVoiceSettings(emotion);
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": this.apiKey,
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_monolingual_v1",
            voice_settings: voiceSettings,
          }),
        },
      );

      if (!response.ok) {
        console.error("ElevenLabs TTS failed:", response.status);
        return;
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);

      await new Promise<void>((resolve) => {
        this.currentAudio = new Audio(audioUrl);
        this.currentAudio.onended = () => {
          this.speaking = false;
          URL.revokeObjectURL(audioUrl);
          resolve();
        };
        this.currentAudio.onerror = () => {
          this.speaking = false;
          URL.revokeObjectURL(audioUrl);
          resolve();
        };
        this.currentAudio.play().catch(() => {
          this.speaking = false;
          resolve();
        });
      });
    } catch (err) {
      console.error("ElevenLabs speak error:", err);
      this.speaking = false;
    }
  }

  setHeadPose(_yaw: number, _pitch: number): void { // eslint-disable-line @typescript-eslint/no-unused-vars
    // ElevenLabs TTS API doesn't support head pose.
    // With their Conversational AI avatar widget, this would map to avatar params.
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  destroy(): void {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this.speaking = false;
    this.container = null;
  }
}

function emotionToVoiceSettings(emotion?: Emotion) {
  switch (emotion) {
    case "engaged":
      return { stability: 0.4, similarity_boost: 0.8 };
    case "tense":
      return { stability: 0.6, similarity_boost: 0.9 };
    case "resolved":
      return { stability: 0.7, similarity_boost: 0.7 };
    default:
      return { stability: 0.5, similarity_boost: 0.75 };
  }
}
