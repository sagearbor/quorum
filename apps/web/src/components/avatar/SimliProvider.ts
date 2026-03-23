/**
 * SimliProvider — Simli.ai streaming avatar SDK integration.
 * Stub implementation: the simli npm package may not be available.
 * When the SDK becomes available, implement the real streaming here.
 */

import type { AvatarProvider, AvatarConfig, Emotion } from "./AvatarProvider";

export class SimliProvider implements AvatarProvider {
  private container: HTMLElement | null = null;
  private speaking = false;
  private currentYaw = 0;
  private currentPitch = 0;

  async init(config: AvatarConfig): Promise<void> {
    this.container = config.containerEl ?? null;

    const apiKey =
      config.apiKey ??
      (typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_SIMLI_API_KEY : null) ??
      null;

    if (!apiKey) {
      console.warn(
        "SimliProvider: No API key configured. This is a stub — install the Simli SDK and provide SIMLI_API_KEY to enable.",
      );
    }

    // TODO: When Simli SDK is available:
    // import { SimliClient } from 'simli-client';
    // this.client = new SimliClient({ apiKey, faceId: '...' });
    // await this.client.initialize(this.container);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async speak(text: string, _emotion?: Emotion): Promise<void> {
    this.speaking = true;
    console.log(`[SimliProvider stub] speak: "${text.slice(0, 50)}..."`);

    // Stub: simulate speech duration
    const duration = Math.min(Math.max(text.length * 80, 500), 5000);
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        this.speaking = false;
        resolve();
      }, duration);
    });
  }

  setHeadPose(yaw: number, pitch: number): void {
    this.currentYaw = yaw;
    this.currentPitch = pitch;
    // TODO: When Simli SDK is available:
    // this.client?.setHeadPose({ yaw, pitch });
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  destroy(): void {
    this.speaking = false;
    this.container = null;
    // TODO: this.client?.destroy();
  }
}
