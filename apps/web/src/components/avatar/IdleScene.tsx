/**
 * IdleScene — React Three Fiber canvas that loads an RPM GLB avatar,
 * plays idle animations, and exposes setGaze(yaw) + setEmotion(emotion)
 * via useImperativeHandle.
 *
 * Idle-alive behaviors: random glances every 8-15s, look-down, blink.
 * AVATAR_MOCK=true: renders an animated SVG stick figure with the same interface.
 */

"use client";

import React, {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import type { DetectedEmotion } from "./EmotionDetector";

// ─── Public handle interface ────────────────────────────────────────

export interface IdleSceneHandle {
  setGaze: (yaw: number) => void;
  setEmotion: (emotion: DetectedEmotion) => void;
}

export interface IdleSceneProps {
  /** URL to the GLB model file */
  glbUrl?: string;
  /** Force mock mode (SVG stick figure). Defaults to AVATAR_MOCK env. */
  mock?: boolean;
  /** Width of canvas (default "100%") */
  width?: string | number;
  /** Height of canvas (default "100%") */
  height?: string | number;
}

// ─── Mock SVG Stick Figure ──────────────────────────────────────────

const EMOTION_COLORS: Record<DetectedEmotion, string> = {
  neutral: "#94a3b8",
  happy: "#4ade80",
  surprised: "#facc15",
  concerned: "#f87171",
  focused: "#60a5fa",
};

const MockIdleScene = forwardRef<IdleSceneHandle, IdleSceneProps>(
  function MockIdleScene(props, ref) {
    const [yaw, setYaw] = useState(0);
    const [emotion, setEmotion] = useState<DetectedEmotion>("neutral");
    const [blinkOpen, setBlinkOpen] = useState(true);
    const [breathPhase, setBreathPhase] = useState(0);

    useImperativeHandle(ref, () => ({
      setGaze: (y: number) => setYaw(Math.max(-1, Math.min(1, y))),
      setEmotion: (e: DetectedEmotion) => setEmotion(e),
    }));

    // Blink every 3-6s
    useEffect(() => {
      const scheduleBlink = () => {
        const delay = 3000 + Math.random() * 3000;
        return setTimeout(() => {
          setBlinkOpen(false);
          setTimeout(() => setBlinkOpen(true), 150);
          timer = scheduleBlink();
        }, delay);
      };
      let timer = scheduleBlink();
      return () => clearTimeout(timer);
    }, []);

    // Breathing cycle
    useEffect(() => {
      let raf: number;
      const start = Date.now();
      const animate = () => {
        const t = ((Date.now() - start) / 1000) % (Math.PI * 2);
        setBreathPhase(Math.sin(t) * 0.5 + 0.5);
        raf = requestAnimationFrame(animate);
      };
      raf = requestAnimationFrame(animate);
      return () => cancelAnimationFrame(raf);
    }, []);

    const headX = yaw * 15;
    const eyeOffsetX = yaw * 3;
    const bodyScale = 1 + breathPhase * 0.02;
    const color = EMOTION_COLORS[emotion];

    // Mouth shape per emotion
    const mouthPath = useMemo(() => {
      switch (emotion) {
        case "happy":
          return "M -4 2 Q 0 6 4 2";
        case "surprised":
          return "M -3 3 Q 0 0 3 3 Q 0 6 -3 3";
        case "concerned":
          return "M -4 4 Q 0 1 4 4";
        case "focused":
          return "M -3 3 L 3 3";
        default:
          return "M -3 3 L 3 3";
      }
    }, [emotion]);

    return (
      <div
        data-testid="idle-scene-mock"
        style={{
          width: props.width ?? "100%",
          height: props.height ?? "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f172a",
        }}
      >
        <svg viewBox="-30 -10 60 80" width="200" height="300">
          {/* Body */}
          <g transform={`scale(${bodyScale})`}>
            {/* Torso */}
            <line
              x1="0"
              y1="20"
              x2="0"
              y2="45"
              stroke={color}
              strokeWidth="2"
              strokeLinecap="round"
            />
            {/* Arms */}
            <line
              x1="0"
              y1="25"
              x2="-15"
              y2="38"
              stroke={color}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <line
              x1="0"
              y1="25"
              x2="15"
              y2="38"
              stroke={color}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            {/* Legs */}
            <line
              x1="0"
              y1="45"
              x2="-10"
              y2="65"
              stroke={color}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <line
              x1="0"
              y1="45"
              x2="10"
              y2="65"
              stroke={color}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </g>

          {/* Head (moves with gaze) */}
          <g transform={`translate(${headX}, 0)`}>
            <circle
              cx="0"
              cy="10"
              r="10"
              fill="none"
              stroke={color}
              strokeWidth="2"
            />
            {/* Eyes */}
            {blinkOpen ? (
              <>
                <circle
                  cx={-3 + eyeOffsetX}
                  cy="8"
                  r="1.5"
                  fill={color}
                />
                <circle
                  cx={3 + eyeOffsetX}
                  cy="8"
                  r="1.5"
                  fill={color}
                />
              </>
            ) : (
              <>
                <line
                  x1={-4.5 + eyeOffsetX}
                  y1="8"
                  x2={-1.5 + eyeOffsetX}
                  y2="8"
                  stroke={color}
                  strokeWidth="1"
                />
                <line
                  x1={1.5 + eyeOffsetX}
                  y1="8"
                  x2={4.5 + eyeOffsetX}
                  y2="8"
                  stroke={color}
                  strokeWidth="1"
                />
              </>
            )}
            {/* Mouth */}
            <g transform="translate(0, 10)">
              <path
                d={mouthPath}
                fill="none"
                stroke={color}
                strokeWidth="1"
                strokeLinecap="round"
              />
            </g>
          </g>
        </svg>
      </div>
    );
  }
);

// ─── Three.js Idle Scene ────────────────────────────────────────────

const ThreeIdleScene = forwardRef<IdleSceneHandle, IdleSceneProps>(
  function ThreeIdleScene(props, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<any>(null);
    const gazeRef = useRef(0);
    const emotionRef = useRef<DetectedEmotion>("neutral");
    const [loaded, setLoaded] = useState(false);

    useImperativeHandle(ref, () => ({
      setGaze: (y: number) => {
        gazeRef.current = Math.max(-1, Math.min(1, y));
      },
      setEmotion: (e: DetectedEmotion) => {
        emotionRef.current = e;
      },
    }));

    // Lazy-load Three.js scene
    useEffect(() => {
      let cancelled = false;
      let cleanup: (() => void) | undefined;

      (async () => {
        const THREE = await import("three");
        const { GLTFLoader } = await import(
          "three/examples/jsm/loaders/GLTFLoader.js"
        );

        if (cancelled || !containerRef.current) return;

        const container = containerRef.current;
        const width = container.clientWidth || 400;
        const height = container.clientHeight || 600;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0f172a);

        const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 100);
        camera.position.set(0, 1.2, 3);
        camera.lookAt(0, 1, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        container.appendChild(renderer.domElement);

        // Lighting
        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambient);
        const directional = new THREE.DirectionalLight(0xffffff, 0.8);
        directional.position.set(2, 3, 2);
        scene.add(directional);

        let mixer: THREE.AnimationMixer | null = null;
        let headBone: THREE.Bone | null = null;

        // Load GLB
        if (props.glbUrl) {
          const loader = new GLTFLoader();
          try {
            const gltf = await new Promise<any>((resolve, reject) => {
              loader.load(props.glbUrl!, resolve, undefined, reject);
            });

            if (cancelled) return;

            scene.add(gltf.scene);

            // Find head bone for gaze
            gltf.scene.traverse((child: any) => {
              if (child.isBone && /head/i.test(child.name)) {
                headBone = child;
              }
            });

            // Play first animation (idle) if available
            if (gltf.animations.length > 0) {
              mixer = new THREE.AnimationMixer(gltf.scene);
              const action = mixer.clipAction(gltf.animations[0]);
              action.play();
            }
          } catch {
            // GLB load failure is non-fatal; show empty scene
          }
        }

        sceneRef.current = { scene, camera, renderer, mixer, headBone };
        if (!cancelled) setLoaded(true);

        // Idle-alive: random glances every 8-15s
        let idleGlanceTimer: ReturnType<typeof setTimeout>;
        const scheduleGlance = () => {
          const delay = 8000 + Math.random() * 7000;
          idleGlanceTimer = setTimeout(() => {
            // Random glance: yaw between -0.5 and 0.5 (subtle)
            const glanceYaw = (Math.random() - 0.5) * 1.0;
            gazeRef.current = glanceYaw;

            // Return to center after 1-2s
            setTimeout(() => {
              gazeRef.current = 0;
            }, 1000 + Math.random() * 1000);

            scheduleGlance();
          }, delay);
        };
        scheduleGlance();

        // Animation loop
        const clock = new THREE.Clock();
        let rafId: number;
        const animate = () => {
          rafId = requestAnimationFrame(animate);
          const delta = clock.getDelta();

          if (mixer) mixer.update(delta);

          // Apply gaze to head bone
          if (headBone) {
            const targetY = gazeRef.current * (Math.PI / 6); // max ±30°
            headBone.rotation.y +=
              (targetY - headBone.rotation.y) * 0.1; // smooth lerp
          }

          renderer.render(scene, camera);
        };
        animate();

        // Resize handler
        const onResize = () => {
          const w = container.clientWidth || 400;
          const h = container.clientHeight || 600;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        };
        window.addEventListener("resize", onResize);

        cleanup = () => {
          clearTimeout(idleGlanceTimer);
          cancelAnimationFrame(rafId);
          window.removeEventListener("resize", onResize);
          renderer.dispose();
          if (container.contains(renderer.domElement)) {
            container.removeChild(renderer.domElement);
          }
        };
      })();

      return () => {
        cancelled = true;
        cleanup?.();
      };
    }, [props.glbUrl]);

    return (
      <div
        ref={containerRef}
        data-testid="idle-scene-three"
        style={{
          width: props.width ?? "100%",
          height: props.height ?? "100%",
          background: "#0f172a",
        }}
      />
    );
  }
);

// ─── Exported component ─────────────────────────────────────────────

function isMockEnv(): boolean {
  if (typeof process !== "undefined") {
    if (process.env?.NEXT_PUBLIC_AVATAR_MOCK === "true") return true;
    if (process.env?.AVATAR_MOCK === "true") return true;
  }
  return false;
}

export const IdleScene = forwardRef<IdleSceneHandle, IdleSceneProps>(
  function IdleScene(props, ref) {
    const useMock = props.mock ?? isMockEnv();

    if (useMock) {
      return <MockIdleScene ref={ref} {...props} />;
    }

    return <ThreeIdleScene ref={ref} {...props} />;
  }
);
