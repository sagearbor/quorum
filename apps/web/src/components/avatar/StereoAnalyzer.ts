/**
 * StereoAnalyzer — Web Audio API stereo mic analysis.
 * Detects L/R/Center speaker direction via channel energy comparison.
 * Gracefully falls back to 'center' if browser returns mono audio.
 */

import type { Direction } from "./AvatarProvider";

export interface StereoAnalyzerOptions {
  /** Direction threshold multiplier (default 1.3) */
  threshold?: number;
  /** EMA smoothing factor, 0-1 (default 0.15) */
  smoothingAlpha?: number;
  /** Callback fired when direction changes */
  onDirection?: (direction: Direction, yaw: number) => void;
  /** Analysis interval in ms (default 50) */
  intervalMs?: number;
}

const DEFAULT_THRESHOLD = 1.3;
const DEFAULT_ALPHA = 0.15;
const DEFAULT_INTERVAL_MS = 50;

export class StereoAnalyzer {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isMono = false;
  private smoothedYaw = 0;
  private _direction: Direction = "center";
  private _yaw = 0;
  private destroyed = false;

  private readonly threshold: number;
  private readonly alpha: number;
  private readonly intervalMs: number;
  private readonly onDirection?: (direction: Direction, yaw: number) => void;

  constructor(options: StereoAnalyzerOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.alpha = options.smoothingAlpha ?? DEFAULT_ALPHA;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onDirection = options.onDirection;
  }

  get direction(): Direction {
    return this._direction;
  }

  get yaw(): number {
    return this._yaw;
  }

  async start(): Promise<void> {
    if (this.destroyed) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 2 },
      });
    } catch {
      // No mic access — stay at center
      this.isMono = true;
      return;
    }

    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    const channelCount = source.channelCount;

    if (channelCount < 2) {
      // Mono mic — graceful fallback
      this.isMono = true;
      this.startMonoFallback();
      return;
    }

    const splitter = this.audioContext.createChannelSplitter(2);
    source.connect(splitter);

    this.analyserL = this.audioContext.createAnalyser();
    this.analyserL.fftSize = 256;
    splitter.connect(this.analyserL, 0);

    this.analyserR = this.audioContext.createAnalyser();
    this.analyserR.fftSize = 256;
    splitter.connect(this.analyserR, 1);

    this.startAnalysis();
  }

  stop(): void {
    this.destroyed = true;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.analyserL = null;
    this.analyserR = null;
  }

  private startMonoFallback(): void {
    // Always emit center — no errors
    this._direction = "center";
    this._yaw = 0;
    this.onDirection?.("center", 0);
  }

  private startAnalysis(): void {
    const bufferLength = this.analyserL!.frequencyBinCount;
    const dataL = new Float32Array(bufferLength);
    const dataR = new Float32Array(bufferLength);

    this.intervalId = setInterval(() => {
      if (!this.analyserL || !this.analyserR) return;

      this.analyserL.getFloatTimeDomainData(dataL);
      this.analyserR.getFloatTimeDomainData(dataR);

      const rmsL = computeRMS(dataL);
      const rmsR = computeRMS(dataR);

      const rawYaw = computeRawYaw(rmsL, rmsR, this.threshold);
      this.smoothedYaw = ema(this.smoothedYaw, rawYaw, this.alpha);

      const direction = yawToDirection(this.smoothedYaw);
      const changed = direction !== this._direction;

      this._direction = direction;
      this._yaw = this.smoothedYaw;

      if (changed) {
        this.onDirection?.(direction, this.smoothedYaw);
      }
    }, this.intervalMs);
  }
}

/** Root-mean-square of a Float32Array */
export function computeRMS(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  return Math.sqrt(sum / data.length);
}

/** Map L/R RMS to raw yaw value: -0.6 (left), 0 (center), +0.6 (right) */
export function computeRawYaw(rmsL: number, rmsR: number, threshold: number): number {
  if (rmsL > rmsR * threshold) return -0.6;
  if (rmsR > rmsL * threshold) return 0.6;
  return 0;
}

/** Exponential moving average */
export function ema(prev: number, current: number, alpha: number): number {
  return alpha * current + (1 - alpha) * prev;
}

/** Map yaw value to direction label */
export function yawToDirection(yaw: number): Direction {
  if (yaw < -0.2) return "left";
  if (yaw > 0.2) return "right";
  return "center";
}
