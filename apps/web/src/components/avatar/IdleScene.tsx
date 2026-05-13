/**
 * IdleScene — React Three Fiber canvas that loads an RPM GLB avatar,
 * plays idle animations, and exposes setGaze(yaw) + setEmotion(emotion)
 * via useImperativeHandle.
 *
 * Idle-alive behaviors: random glances every 8-15s, look-down, blink.
 */

"use client";

import React, {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useState,
} from "react";
import type { DetectedEmotion } from "./EmotionDetector";

// ─── Public handle interface ────────────────────────────────────────

export interface IdleSceneHandle {
  setGaze: (yaw: number, pitch?: number) => void;
  setEmotion: (emotion: DetectedEmotion) => void;
}

/**
 * Camera framing presets.
 *
 * - "full_body": default — wide shot showing the avatar head-to-toe.
 *   Used while idle so the pacing animation reads clearly.
 * - "torso": close-up — camera raised + pushed in, FOV tightened, frames
 *   the avatar from roughly the waist up. Used while speaking so the
 *   facilitator stops reading as "standing mannequin" and starts reading
 *   as "talking head."
 */
export type CameraMode = "full_body" | "torso";

interface CameraPreset {
  /** Camera world position (x, y, z). */
  position: [number, number, number];
  /** lookAt target (x, y, z). */
  lookAt: [number, number, number];
  /** Vertical FOV in degrees. */
  fov: number;
}

const CAMERA_PRESETS: Record<CameraMode, CameraPreset> = {
  // Matches the historical default — wide framing, whole avatar visible.
  full_body: {
    position: [0, 1.2, 3],
    lookAt: [0, 1, 0],
    fov: 35,
  },
  // Raise camera, push in, narrow FOV — frames torso + head.
  // Tuned for an RPM-style avatar where the head sits around y=1.6 and
  // the chest sits around y=1.3.
  torso: {
    position: [0, 1.5, 1.55],
    lookAt: [0, 1.45, 0],
    fov: 28,
  },
};

/** Duration of the camera lerp when cameraMode changes (ms). */
const CAMERA_LERP_MS = 600;
/**
 * Duration of the "settle to center X = 0" animation that plays BEFORE the
 * camera lerps to torso. Sequence is: settle position → camera tightens →
 * mouth animates.
 */
const SETTLE_TO_CENTER_MS = 400;
/** Full cycle period for idle pacing (ms). */
const PACE_PERIOD_MS = 10_000;
/** Half-amplitude (units) of horizontal pacing. */
const PACE_AMPLITUDE = 0.3;
/** Max yaw (radians) the body turns toward direction of motion. */
const PACE_YAW = 0.08;

export interface IdleSceneProps {
  /** URL to the GLB model file */
  glbUrl?: string;
  /** Width of canvas (default "100%") */
  width?: string | number;
  /** Height of canvas (default "100%") */
  height?: string | number;
  /**
   * Camera framing mode. Defaults to "full_body" (matches legacy behavior).
   * When set to "torso", the camera smoothly lerps to a close-up framing
   * over ~600ms. Pair with the speaking state from useAvatarController so
   * the camera tightens whenever the facilitator speaks.
   */
  cameraMode?: CameraMode;
}

// ─── Three.js Idle Scene ────────────────────────────────────────────

export const IdleScene = forwardRef<IdleSceneHandle, IdleSceneProps>(
  function IdleScene(props, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sceneRef = useRef<any>(null);
    const gazeRef = useRef(0);
    const pitchRef = useRef(0);
    const emotionRef = useRef<DetectedEmotion>("neutral");
    // Mutable refs the animation loop reads on every frame. Using refs (not
    // state) so we don't tear down / rebuild the Three.js scene when the
    // parent flips cameraMode — we just morph the existing camera.
    const cameraModeRef = useRef<CameraMode>(props.cameraMode ?? "full_body");
    // The Three.js scene boots asynchronously; this flag becomes true once the
    // scene exists so subsequent cameraMode prop changes know to start a lerp.
    const sceneReadyRef = useRef(false);
    // When set, the animation loop interpolates camera/avatar params toward
    // the target preset over the configured duration. `null` = no animation
    // in flight (camera held at the last preset).
    type LerpState = {
      from: CameraPreset;
      to: CameraPreset;
      /** ms remaining in the settle-to-center phase before camera lerp starts. */
      settleRemainingMs: number;
      /** ms remaining in the camera lerp itself. */
      lerpRemainingMs: number;
      totalLerpMs: number;
    };
    const lerpRef = useRef<LerpState | null>(null);
    const [, setLoaded] = useState(false);

    useImperativeHandle(ref, () => ({
      setGaze: (y: number, p?: number) => {
        gazeRef.current = Math.max(-1, Math.min(1, y));
        if (p !== undefined) pitchRef.current = Math.max(-1, Math.min(1, p));
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

        // Initial camera framing comes from the current cameraMode preset.
        // We never re-create the camera on mode changes — the animation loop
        // lerps its existing position/lookAt/fov toward the new preset.
        const initialPreset = CAMERA_PRESETS[cameraModeRef.current];
        const camera = new THREE.PerspectiveCamera(
          initialPreset.fov,
          width / height,
          0.1,
          100
        );
        camera.position.set(...initialPreset.position);
        const lookAtTarget = { x: initialPreset.lookAt[0], y: initialPreset.lookAt[1], z: initialPreset.lookAt[2] };
        camera.lookAt(lookAtTarget.x, lookAtTarget.y, lookAtTarget.z);

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

        /* eslint-disable @typescript-eslint/no-explicit-any */
        let mixer: any = null;
        let headBone: any = null;
        let leftEyeBone: any = null;
        let rightEyeBone: any = null;
        let skinnedMesh: any = null;
        // Root group of the loaded avatar — we translate this on X to pace
        // and yaw it slightly toward the direction of motion. Captured after
        // GLB load so the pacing loop has something to move.
        let avatarRoot: any = null;
        /* eslint-enable @typescript-eslint/no-explicit-any */

        // Load GLB
        if (props.glbUrl) {
          const loader = new GLTFLoader();
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const gltf = await new Promise<any>((resolve, reject) => {
              loader.load(props.glbUrl!, resolve, undefined, reject);
            });

            if (cancelled) return;

            scene.add(gltf.scene);
            avatarRoot = gltf.scene;

            // Find bones for gaze control
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            gltf.scene.traverse((child: any) => {
              if (child.isBone) {
                if (/head/i.test(child.name) && !headBone) {
                  headBone = child;
                }
                if (/eye.?l|lefteye|l_eye/i.test(child.name) && !leftEyeBone) {
                  leftEyeBone = child;
                }
                if (/eye.?r|righteye|r_eye/i.test(child.name) && !rightEyeBone) {
                  rightEyeBone = child;
                }
              }
              if (child.isSkinnedMesh && !skinnedMesh) {
                skinnedMesh = child;
              }
            });

            // Play first animation (idle) if available
            if (gltf.animations.length > 0) {
              mixer = new THREE.AnimationMixer(gltf.scene);
              const action = mixer.clipAction(gltf.animations[0]);
              action.play();
            } else {
              // Fix T-pose for GLBs whose arms are near-horizontal.
              // Detect by checking if LeftArm/RightArm quaternion is near-identity
              // (= T-pose, e.g. Avaturn) vs already rotated (= arms-down, e.g. MakeHuman).
              // Quaternion values computed analytically per skeleton type.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              gltf.scene.traverse((bone: any) => {
                if (!bone.isBone) return;
                const name = bone.name;
                if (name !== "LeftArm" && name !== "RightArm") return;

                // Check if arm is in T-pose: w > 0.95 means near-identity quaternion
                const isTPose = Math.abs(bone.quaternion.w) > 0.95;
                if (!isTPose) return; // Already posed (e.g. MakeHuman) — don't touch

                const isLeft = name === "LeftArm";
                // Target: arms hanging at sides with 10° natural outward splay.
                // Avaturn skeleton: [0.638, 0, ±0.080, 0.766]
                bone.quaternion.set(
                  0.637797,
                  0,
                  isLeft ? 0.079552 : -0.079552,
                  0.766085
                );
              });
            }
          } catch {
            // GLB load failure is non-fatal; show empty scene
          }
        }

        sceneRef.current = {
          scene,
          camera,
          renderer,
          mixer,
          headBone,
          leftEyeBone,
          rightEyeBone,
          skinnedMesh,
          avatarRoot,
          // Persisted lookAt target — the lerp mutates this and the animate
          // loop re-applies it every frame, so a one-shot `camera.lookAt()`
          // is enough to keep the camera pointed correctly while the avatar
          // paces along X.
          lookAtTarget,
        };
        sceneReadyRef.current = true;
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
        let currentEyeYaw = 0;
        let currentHeadYaw = 0;
        let currentHeadPitch = 0;
        // Idle pacing state — accumulated wall-clock time in seconds, fed
        // into a sine wave to oscillate the avatar's X position.
        let paceElapsedS = 0;
        // Last computed pacing X — needed so that on "settle to center"
        // transitions we lerp from wherever the avatar happens to be.
        let lastPaceX = 0;
        // Avatar body yaw added on top of any other rotation. Lerped each
        // frame so direction changes feel natural.
        let bodyYaw = 0;
        // While true, the pacing loop is suppressed and the avatar's X glides
        // back toward 0 over SETTLE_TO_CENTER_MS. Driven by the lerpRef state
        // machine — when a lerp toward "torso" starts, settle phase runs
        // first; the camera lerp itself only begins after the settle.
        const animate = () => {
          rafId = requestAnimationFrame(animate);
          const delta = clock.getDelta();
          const deltaMs = delta * 1000;

          if (mixer) mixer.update(delta);

          // ─── Camera lerp + settle phase ──────────────────────────
          // When a new cameraMode is requested, lerpRef holds a from→to
          // preset plus two countdowns. We run "settle to center" first
          // (avatar X glides to 0) so the body isn't off-axis when the
          // camera tightens, then we run the actual camera lerp.
          const lerp = lerpRef.current;
          let pacingSuppressed = false;
          if (lerp) {
            if (lerp.settleRemainingMs > 0) {
              // Phase 1: hold camera, glide avatar X to 0.
              lerp.settleRemainingMs = Math.max(0, lerp.settleRemainingMs - deltaMs);
              pacingSuppressed = true;
            } else {
              // Phase 2: lerp camera from `from` preset to `to` preset.
              lerp.lerpRemainingMs = Math.max(0, lerp.lerpRemainingMs - deltaMs);
              const t = 1 - lerp.lerpRemainingMs / lerp.totalLerpMs;
              // easeInOutCubic — feels less mechanical than linear lerp.
              const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
              const px =
                lerp.from.position[0] + (lerp.to.position[0] - lerp.from.position[0]) * e;
              const py =
                lerp.from.position[1] + (lerp.to.position[1] - lerp.from.position[1]) * e;
              const pz =
                lerp.from.position[2] + (lerp.to.position[2] - lerp.from.position[2]) * e;
              camera.position.set(px, py, pz);

              lookAtTarget.x =
                lerp.from.lookAt[0] + (lerp.to.lookAt[0] - lerp.from.lookAt[0]) * e;
              lookAtTarget.y =
                lerp.from.lookAt[1] + (lerp.to.lookAt[1] - lerp.from.lookAt[1]) * e;
              lookAtTarget.z =
                lerp.from.lookAt[2] + (lerp.to.lookAt[2] - lerp.from.lookAt[2]) * e;

              camera.fov = lerp.from.fov + (lerp.to.fov - lerp.from.fov) * e;
              camera.updateProjectionMatrix();

              // Pacing stays suppressed for the entire torso framing —
              // a torso shot looks weird if the body is drifting sideways
              // out of frame. For full_body→full_body or torso→full_body
              // we allow pacing to resume once the lerp completes.
              if (cameraModeRef.current === "torso") {
                pacingSuppressed = true;
              }

              if (lerp.lerpRemainingMs === 0) {
                // Snap to final values to avoid lingering FP drift.
                camera.position.set(
                  lerp.to.position[0],
                  lerp.to.position[1],
                  lerp.to.position[2]
                );
                lookAtTarget.x = lerp.to.lookAt[0];
                lookAtTarget.y = lerp.to.lookAt[1];
                lookAtTarget.z = lerp.to.lookAt[2];
                camera.fov = lerp.to.fov;
                camera.updateProjectionMatrix();
                lerpRef.current = null;
              }
            }
          } else if (cameraModeRef.current === "torso") {
            // Lerp already finished — but if we settled into torso framing,
            // keep pacing suppressed so the body stays centered.
            pacingSuppressed = true;
          }

          // ─── Idle pacing ─────────────────────────────────────────
          // Subtle sine-wave horizontal motion + slight body yaw toward
          // direction of travel. Like someone waiting at a podium.
          if (avatarRoot) {
            if (pacingSuppressed) {
              // Glide back to X = 0 + cancel body yaw. The 0.12 factor gives
              // roughly the SETTLE_TO_CENTER_MS feel at 60fps.
              lastPaceX += (0 - lastPaceX) * 0.12;
              bodyYaw += (0 - bodyYaw) * 0.12;
              avatarRoot.position.x = lastPaceX;
              avatarRoot.rotation.y = bodyYaw;
              // Don't advance paceElapsedS while suppressed so when pacing
              // resumes the avatar starts from the center of the cycle
              // (smooth re-entry).
            } else {
              paceElapsedS += delta;
              const phase = (paceElapsedS / (PACE_PERIOD_MS / 1000)) * Math.PI * 2;
              const targetX = Math.sin(phase) * PACE_AMPLITUDE;
              // Yaw toward direction of motion using the derivative of sin
              // (which is cos) — when moving right, turn slightly right.
              const targetYaw = Math.cos(phase) * PACE_YAW;
              // Light lerp so a sudden resume after settle doesn't snap.
              lastPaceX += (targetX - lastPaceX) * 0.1;
              bodyYaw += (targetYaw - bodyYaw) * 0.1;
              avatarRoot.position.x = lastPaceX;
              avatarRoot.rotation.y = bodyYaw;
            }
          }

          // Re-apply lookAt every frame so the camera tracks the lerping
          // target during the camera-lerp phase. Cheap (just a matrix op).
          camera.lookAt(lookAtTarget.x, lookAtTarget.y, lookAtTarget.z);

          const gazeTarget = gazeRef.current;

          // Eyes lead: fast lerp to target
          const eyeTargetY = gazeTarget * (Math.PI / 8); // max ±22.5°
          currentEyeYaw += (eyeTargetY - currentEyeYaw) * 0.5;

          // Head follows: slower lerp, creating natural delay
          const headTargetY = gazeTarget * (Math.PI / 6); // max ±30°
          currentHeadYaw += (headTargetY - currentHeadYaw) * 0.35;

          // Apply eye gaze via bones
          if (leftEyeBone) leftEyeBone.rotation.y = currentEyeYaw;
          if (rightEyeBone) rightEyeBone.rotation.y = currentEyeYaw;

          // Apply eye gaze via morph targets (ARKit blend shapes)
          if (skinnedMesh?.morphTargetDictionary && skinnedMesh.morphTargetInfluences) {
            const dict = skinnedMesh.morphTargetDictionary;
            const infl = skinnedMesh.morphTargetInfluences;
            const lookAmount = Math.abs(gazeTarget);
            if (gazeTarget > 0.05) {
              // Looking right
              if (dict["eyeLookOutRight"] !== undefined) infl[dict["eyeLookOutRight"]] = lookAmount;
              if (dict["eyeLookInLeft"] !== undefined) infl[dict["eyeLookInLeft"]] = lookAmount;
              if (dict["eyeLookOutLeft"] !== undefined) infl[dict["eyeLookOutLeft"]] = 0;
              if (dict["eyeLookInRight"] !== undefined) infl[dict["eyeLookInRight"]] = 0;
            } else if (gazeTarget < -0.05) {
              // Looking left
              if (dict["eyeLookOutLeft"] !== undefined) infl[dict["eyeLookOutLeft"]] = lookAmount;
              if (dict["eyeLookInRight"] !== undefined) infl[dict["eyeLookInRight"]] = lookAmount;
              if (dict["eyeLookOutRight"] !== undefined) infl[dict["eyeLookOutRight"]] = 0;
              if (dict["eyeLookInLeft"] !== undefined) infl[dict["eyeLookInLeft"]] = 0;
            } else {
              // Center — clear all look morphs
              for (const key of ["eyeLookOutRight", "eyeLookInLeft", "eyeLookOutLeft", "eyeLookInRight"]) {
                if (dict[key] !== undefined) infl[dict[key]] = 0;
              }
            }
          }

          // Apply head rotation (yaw + pitch)
          const pitchTarget = pitchRef.current;
          const headTargetX = pitchTarget * (Math.PI / 5); // max ±36° up/down
          currentHeadPitch += (headTargetX - currentHeadPitch) * 0.35;

          if (headBone) {
            headBone.rotation.y = currentHeadYaw;
            headBone.rotation.x = currentHeadPitch;
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

    // ─── React to cameraMode changes ─────────────────────────────────
    // When the parent toggles cameraMode (e.g. on `avatarState.speaking`),
    // kick off a lerp in the animation loop. We never rebuild the scene —
    // just hand the loop a new target preset and let it interpolate.
    useEffect(() => {
      const nextMode = props.cameraMode ?? "full_body";
      const prevMode = cameraModeRef.current;
      cameraModeRef.current = nextMode;

      // First render before the scene boots — the mount path already reads
      // cameraModeRef and picks the right initial preset, so we're done.
      if (!sceneReadyRef.current) return;
      if (prevMode === nextMode) return;

      const fromPreset = CAMERA_PRESETS[prevMode];
      const toPreset = CAMERA_PRESETS[nextMode];

      // Sequence per spec: settle position → camera tightens → mouth animates.
      // We only run the settle phase when tightening INTO torso framing —
      // backing out to full_body looks fine without an extra pause.
      const settleMs = nextMode === "torso" ? SETTLE_TO_CENTER_MS : 0;

      lerpRef.current = {
        from: fromPreset,
        to: toPreset,
        settleRemainingMs: settleMs,
        lerpRemainingMs: CAMERA_LERP_MS,
        totalLerpMs: CAMERA_LERP_MS,
      };
    }, [props.cameraMode]);

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
