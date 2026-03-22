/**
 * VisionTracker — MediaPipe PersonDetector → gaze yaw [-1, 1].
 *
 * When AVATAR_MOCK=true (or camera unavailable), produces a sine-wave yaw.
 * Graceful fallback: if MediaPipe fails to load or no camera, auto-switches to mock.
 */

type GazeCallback = (yaw: number, pitch?: number) => void;

export interface VisionTrackerOptions {
  onGaze: GazeCallback;
  /** Force mock mode (sine wave). Defaults to AVATAR_MOCK env var. */
  mock?: boolean;
  /** Detection interval in ms (default 100). */
  intervalMs?: number;
}

export class VisionTracker {
  private onGaze: GazeCallback;
  private mock: boolean;
  private intervalMs: number;
  private detector: any = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private mockStartTime = 0;

  constructor(options: VisionTrackerOptions) {
    this.onGaze = options.onGaze;
    this.mock = options.mock ?? isMockEnv();
    this.intervalMs = options.intervalMs ?? 100;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.mock) {
      console.log("[VisionTracker] Starting in MOCK mode (env override)");
      this.startMock();
      return;
    }

    try {
      await this.initMediaPipe();
      console.log("[VisionTracker] MediaPipe + webcam active");
    } catch (err) {
      // Graceful fallback to mock if MediaPipe or camera fails
      console.warn("[VisionTracker] MediaPipe/camera failed, falling back to mock:", err);
      this.mock = true;
      this.startMock();
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

    this.detector = null;
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
      // Slow sine wave: period ~4s
      const yaw = Math.sin(elapsed * Math.PI * 0.5);
      const pitch = Math.sin(elapsed * Math.PI * 0.3) * 0.6; // vertical oscillation
      this.onGaze(yaw, pitch);
    }, this.intervalMs);
  }

  private async initMediaPipe(): Promise<void> {
    const { ObjectDetector, FilesetResolver } = await import(
      "@mediapipe/tasks-vision"
    );

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );

    this.detector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite",
        delegate: "GPU",
      },
      categoryAllowlist: ["person"],
      scoreThreshold: 0.3,
      runningMode: "VIDEO",
    });

    // Set up hidden video element for webcam
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
    if (!this.detector || !this.video || this.video.readyState < 2) return;

    try {
      const results = this.detector.detectForVideo(
        this.video,
        performance.now()
      );

      if (results.detections && results.detections.length > 0) {
        // Use the largest (closest) person detection
        const detection = results.detections.reduce(
          (best: any, d: any) =>
            d.boundingBox.width * d.boundingBox.height >
            best.boundingBox.width * best.boundingBox.height
              ? d
              : best,
          results.detections[0]
        );

        const bb = detection.boundingBox;
        const centerX = bb.originX + bb.width / 2;
        const centerY = bb.originY + bb.height / 2;
        const frameWidth = this.video.videoWidth || 320;
        const frameHeight = this.video.videoHeight || 240;

        // Map centerX [0, frameWidth] → yaw [-1, 1]
        // Mirror: person on right of camera → avatar looks right
        const yaw = ((centerX / frameWidth) * 2 - 1) * -1;
        // Map centerY [0, frameHeight] → pitch [-1, 1]
        // Person above center (small Y) → negative pitch (avatar looks up)
        // Person below center (large Y) → positive pitch (avatar looks down)
        const pitch = (centerY / frameHeight) * 2 - 1;
        this.onGaze(
          Math.max(-1, Math.min(1, yaw)),
          Math.max(-1, Math.min(1, pitch))
        );
      }
    } catch {
      // Detection frame errors are non-fatal; skip this frame
    }
  }
}

function isMockEnv(): boolean {
  if (typeof process !== "undefined") {
    if (process.env?.NEXT_PUBLIC_AVATAR_MOCK === "true") return true;
    if (process.env?.AVATAR_MOCK === "true") return true;
  }
  return false;
}
