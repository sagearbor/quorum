/**
 * MockProvider — renders an animated SVG face for testing/dev.
 * Eyes follow yaw, mouth animates during speech. Zero external APIs.
 */

import type { AvatarProvider, AvatarConfig, Emotion } from "./AvatarProvider";

export class MockProvider implements AvatarProvider {
  private container: HTMLElement | null = null;
  private svgEl: SVGSVGElement | null = null;
  private speaking = false;
  private currentYaw = 0;
  private currentPitch = 0;
  private currentEmotion: Emotion = "neutral";
  private mouthAnimFrame: number | null = null;
  private speakTimeout: ReturnType<typeof setTimeout> | null = null;

  async init(config: AvatarConfig): Promise<void> {
    this.container = config.containerEl ?? null;
    if (this.container) {
      this.svgEl = this.buildSvg();
      this.container.appendChild(this.svgEl);
      this.updateSvg();
    }
  }

  async speak(text: string, emotion?: Emotion): Promise<void> {
    if (emotion) this.currentEmotion = emotion;
    this.speaking = true;
    this.updateSvg();
    this.startMouthAnimation();

    // Simulate speech duration: ~80ms per character, min 500ms, max 5000ms
    const duration = Math.min(Math.max(text.length * 80, 500), 5000);
    return new Promise((resolve) => {
      this.speakTimeout = setTimeout(() => {
        this.speaking = false;
        this.stopMouthAnimation();
        this.updateSvg();
        resolve();
      }, duration);
    });
  }

  setHeadPose(yaw: number, pitch: number): void {
    this.currentYaw = Math.max(-1, Math.min(1, yaw));
    this.currentPitch = Math.max(-1, Math.min(1, pitch));
    this.updateSvg();
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  destroy(): void {
    this.stopMouthAnimation();
    if (this.speakTimeout) {
      clearTimeout(this.speakTimeout);
      this.speakTimeout = null;
    }
    if (this.svgEl && this.container) {
      this.container.removeChild(this.svgEl);
    }
    this.svgEl = null;
    this.container = null;
    this.speaking = false;
  }

  // -- SVG rendering --

  private buildSvg(): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 200 200");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("data-testid", "mock-avatar-svg");
    svg.style.maxWidth = "400px";
    svg.style.maxHeight = "400px";

    // Face circle
    const face = document.createElementNS(ns, "circle");
    face.setAttribute("cx", "100");
    face.setAttribute("cy", "100");
    face.setAttribute("r", "80");
    face.setAttribute("fill", "#3b82f6");
    face.setAttribute("data-testid", "mock-avatar-face");
    svg.appendChild(face);

    // Left eye
    const leftEye = document.createElementNS(ns, "circle");
    leftEye.setAttribute("r", "8");
    leftEye.setAttribute("fill", "white");
    leftEye.setAttribute("data-testid", "mock-avatar-left-eye");
    svg.appendChild(leftEye);

    // Right eye
    const rightEye = document.createElementNS(ns, "circle");
    rightEye.setAttribute("r", "8");
    rightEye.setAttribute("fill", "white");
    rightEye.setAttribute("data-testid", "mock-avatar-right-eye");
    svg.appendChild(rightEye);

    // Mouth
    const mouth = document.createElementNS(ns, "ellipse");
    mouth.setAttribute("cx", "100");
    mouth.setAttribute("fill", "white");
    mouth.setAttribute("data-testid", "mock-avatar-mouth");
    svg.appendChild(mouth);

    return svg;
  }

  private updateSvg(): void {
    if (!this.svgEl) return;

    const leftEye = this.svgEl.querySelector('[data-testid="mock-avatar-left-eye"]');
    const rightEye = this.svgEl.querySelector('[data-testid="mock-avatar-right-eye"]');
    const mouth = this.svgEl.querySelector('[data-testid="mock-avatar-mouth"]');
    const face = this.svgEl.querySelector('[data-testid="mock-avatar-face"]');

    if (!leftEye || !rightEye || !mouth || !face) return;

    // Eye positions shift with yaw (-1 to 1 maps to -15px to +15px)
    const eyeShiftX = this.currentYaw * 15;
    const eyeShiftY = this.currentPitch * -8;

    leftEye.setAttribute("cx", String(70 + eyeShiftX));
    leftEye.setAttribute("cy", String(85 + eyeShiftY));
    rightEye.setAttribute("cx", String(130 + eyeShiftX));
    rightEye.setAttribute("cy", String(85 + eyeShiftY));

    // Mouth: larger when speaking
    const mouthRx = this.speaking ? 20 : 15;
    const mouthRy = this.speaking ? 12 : 4;
    mouth.setAttribute("cy", String(130 + eyeShiftY * 0.5));
    mouth.setAttribute("rx", String(mouthRx));
    mouth.setAttribute("ry", String(mouthRy));

    // Face color based on emotion
    const colorMap: Record<string, string> = {
      neutral: "#3b82f6",
      engaged: "#22c55e",
      tense: "#ef4444",
      resolved: "#a78bfa",
    };
    face.setAttribute("fill", colorMap[this.currentEmotion] ?? "#3b82f6");
  }

  private startMouthAnimation(): void {
    let phase = 0;
    const animate = () => {
      if (!this.speaking || !this.svgEl) return;
      const mouth = this.svgEl.querySelector('[data-testid="mock-avatar-mouth"]');
      if (mouth) {
        // Oscillate mouth open/close
        const ry = 6 + Math.sin(phase) * 8;
        mouth.setAttribute("ry", String(Math.max(2, ry)));
        phase += 0.3;
      }
      this.mouthAnimFrame = requestAnimationFrame(animate);
    };
    this.mouthAnimFrame = requestAnimationFrame(animate);
  }

  private stopMouthAnimation(): void {
    if (this.mouthAnimFrame !== null) {
      cancelAnimationFrame(this.mouthAnimFrame);
      this.mouthAnimFrame = null;
    }
  }
}
