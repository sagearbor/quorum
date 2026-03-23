/**
 * EmotionDetector — MediaPipe FaceLandmarker → emotion classification.
 *
 * Landmark geometry is mapped to: happy | surprised | concerned | focused | neutral.
 * 1-second smoothing window prevents jarring snaps.
 * AVATAR_MOCK=true: slow cycle through all emotions (~3s each).
 */

export type DetectedEmotion =
  | "happy"
  | "surprised"
  | "concerned"
  | "focused"
  | "neutral";

type EmotionCallback = (emotion: DetectedEmotion) => void;

export interface EmotionDetectorOptions {
  onEmotion: EmotionCallback;
  /** Force mock mode. Defaults to AVATAR_MOCK env var. */
  mock?: boolean;
  /** Detection interval in ms (default 200). */
  intervalMs?: number;
  /** Smoothing window in ms (default 1000). */
  smoothingMs?: number;
}

const EMOTIONS: DetectedEmotion[] = [
  "neutral",
  "happy",
  "surprised",
  "concerned",
  "focused",
];

export class EmotionDetector {
  private onEmotion: EmotionCallback;
  private mock: boolean;
  private intervalMs: number;
  private smoothingMs: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private landmarker: any = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private mockStartTime = 0;

  // Smoothing buffer: timestamps + emotions
  private buffer: Array<{ time: number; emotion: DetectedEmotion }> = [];
  private lastEmitted: DetectedEmotion = "neutral";

  constructor(options: EmotionDetectorOptions) {
    this.onEmotion = options.onEmotion;
    this.mock = options.mock ?? isMockEnv();
    this.intervalMs = options.intervalMs ?? 200;
    this.smoothingMs = options.smoothingMs ?? 1000;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.mock) {
      this.startMock();
      return;
    }

    try {
      await this.initMediaPipe();
    } catch (err) {
      console.error("[EmotionDetector] MediaPipe init failed:", err);
      this.running = false;
    }
  }

  stop(): void {
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    if (this.video) {
      this.video.remove();
      this.video = null;
    }

    this.landmarker = null;
    this.buffer = [];
  }

  isRunning(): boolean {
    return this.running;
  }

  isMock(): boolean {
    return this.mock;
  }

  private startMock(): void {
    this.mockStartTime = Date.now();
    this.timer = setInterval(() => {
      const elapsed = (Date.now() - this.mockStartTime) / 1000;
      // Cycle through emotions every ~3s
      const idx = Math.floor(elapsed / 3) % EMOTIONS.length;
      this.emit(EMOTIONS[idx]);
    }, this.intervalMs);
  }

  private async initMediaPipe(): Promise<void> {
    const { FaceLandmarker, FilesetResolver } = await import(
      "@mediapipe/tasks-vision"
    );

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );

    this.landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.tflite",
        delegate: "GPU",
      },
      outputFaceBlendshapes: true,
      runningMode: "VIDEO",
      numFaces: 1,
    });

    this.video = document.createElement("video");
    this.video.setAttribute("playsinline", "");
    this.video.setAttribute("autoplay", "");
    this.video.style.display = "none";
    document.body.appendChild(this.video);

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 320, height: 240 },
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    this.timer = setInterval(() => {
      this.detectFrame();
    }, this.intervalMs);
  }

  private detectFrame(): void {
    if (!this.landmarker || !this.video || this.video.readyState < 2) return;

    try {
      const results = this.landmarker.detectForVideo(
        this.video,
        performance.now()
      );

      if (
        results.faceBlendshapes &&
        results.faceBlendshapes.length > 0
      ) {
        const blendshapes = results.faceBlendshapes[0].categories;
        const emotion = classifyEmotion(blendshapes);
        this.addToBuffer(emotion);
        const smoothed = this.getSmoothedEmotion();
        this.emit(smoothed);
      }
    } catch {
      // Non-fatal frame error
    }
  }

  private addToBuffer(emotion: DetectedEmotion): void {
    const now = Date.now();
    this.buffer.push({ time: now, emotion });
    // Prune entries older than smoothing window
    const cutoff = now - this.smoothingMs;
    this.buffer = this.buffer.filter((e) => e.time >= cutoff);
  }

  private getSmoothedEmotion(): DetectedEmotion {
    if (this.buffer.length === 0) return "neutral";

    // Count occurrences, pick majority
    const counts: Record<string, number> = {};
    for (const entry of this.buffer) {
      counts[entry.emotion] = (counts[entry.emotion] || 0) + 1;
    }

    let best: DetectedEmotion = "neutral";
    let bestCount = 0;
    for (const [emotion, count] of Object.entries(counts)) {
      if (count > bestCount) {
        bestCount = count;
        best = emotion as DetectedEmotion;
      }
    }

    return best;
  }

  private emit(emotion: DetectedEmotion): void {
    if (emotion !== this.lastEmitted) {
      this.lastEmitted = emotion;
      this.onEmotion(emotion);
    }
  }
}

/**
 * Classify emotion from MediaPipe face blendshape categories.
 * Uses blendshape scores for mouth, brow, and eye regions.
 */
function classifyEmotion(
  categories: Array<{ categoryName: string; score: number }>
): DetectedEmotion {
  const get = (name: string): number =>
    categories.find((c) => c.categoryName === name)?.score ?? 0;

  const mouthSmileL = get("mouthSmileLeft");
  const mouthSmileR = get("mouthSmileRight");
  const browDownL = get("browDownLeft");
  const browDownR = get("browDownRight");
  const browInnerUp = get("browInnerUp");
  const browOuterUpL = get("browOuterUpLeft");
  const browOuterUpR = get("browOuterUpRight");
  const eyeWideL = get("eyeWideLeft");
  const eyeWideR = get("eyeWideRight");
  const jawOpen = get("jawOpen");
  const mouthPressL = get("mouthPressLeft");
  const mouthPressR = get("mouthPressRight");

  const smile = (mouthSmileL + mouthSmileR) / 2;
  const browRaise = (browOuterUpL + browOuterUpR + browInnerUp) / 3;
  const eyeWide = (eyeWideL + eyeWideR) / 2;
  const browFurrow = (browDownL + browDownR) / 2;
  const mouthPress = (mouthPressL + mouthPressR) / 2;

  // happy: lip corner raise
  if (smile > 0.4) return "happy";

  // surprised: brow raise + eye wide
  if (browRaise > 0.35 && eyeWide > 0.3) return "surprised";

  // concerned: brow furrow + lip press
  if (browFurrow > 0.3 && mouthPress > 0.2) return "concerned";

  // focused: jaw tension + brow down (concentration)
  if (browFurrow > 0.25 && jawOpen < 0.1) return "focused";

  return "neutral";
}

function isMockEnv(): boolean {
  if (typeof process !== "undefined") {
    if (process.env?.NEXT_PUBLIC_AVATAR_MOCK === "true") return true;
    if (process.env?.AVATAR_MOCK === "true") return true;
  }
  return false;
}

// Export for testing
export { classifyEmotion };
