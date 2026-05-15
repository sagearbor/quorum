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
  setFraming: (mode: CameraMode) => void;
  setBodyPose: (pose: { x: number; z: number; clip: "breathing" | "walking" }) => void;
  setMouthShape: (shape: { jawOpen: number; mouthFunnel: number; mouthPucker: number; mouthSmile: number; mouthClose: number } | null) => void;
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
export type CameraMode = "full_body" | "torso" | "bust";

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
  // Head + neck + top of shoulders in frame. Earlier numbers (z=1.15,
  // FOV 24) zoomed in to just the eyes — too tight. Pulled back + widened.
  bust: {
    position: [0, 1.55, 1.9],
    lookAt: [0, 1.5, 0],
    fov: 30,
  },
};

/** Duration of the camera lerp when cameraMode changes (ms). */
const CAMERA_LERP_MS = 600;

export interface IdleSceneProps {
  /** URL to the GLB model file */
  glbUrl?: string;
  /** Width of canvas (default "100%") */
  width?: string | number;
  /** Height of canvas (default "100%") */
  height?: string | number;
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
    // controller drives framing/pose/mouth — we just morph the existing scene.
    const framingRef = useRef<CameraMode>("full_body");
    const bodyPoseRef = useRef<{ x: number; z: number; clip: "breathing" | "walking" }>({ x: 0, z: 0, clip: "breathing" });
    const mouthShapeRef = useRef<{ jawOpen: number; mouthFunnel: number; mouthPucker: number; mouthSmile: number; mouthClose: number } | null>(null);
    // The Three.js scene boots asynchronously; this flag becomes true once the
    // scene exists so setFraming() knows to start a lerp instead of just
    // updating the initial preset selection.
    const sceneReadyRef = useRef(false);
    // When set, the animation loop interpolates camera/avatar params toward
    // the target preset over the configured duration. `null` = no animation
    // in flight (camera held at the last preset).
    type LerpState = {
      from: CameraPreset;
      to: CameraPreset;
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
      setFraming: (mode: CameraMode) => {
        if (framingRef.current === mode) return;
        const fromPreset = CAMERA_PRESETS[framingRef.current];
        const toPreset = CAMERA_PRESETS[mode];
        framingRef.current = mode;
        // Pre-mount: just record the requested mode — the mount path reads
        // framingRef.current to pick the initial preset, so no lerp needed.
        // Without this guard a stale lerp would queue full_body→target and
        // briefly snap the camera away from target on cold start.
        if (!sceneReadyRef.current) return;
        lerpRef.current = {
          from: fromPreset,
          to: toPreset,
          lerpRemainingMs: CAMERA_LERP_MS,
          totalLerpMs: CAMERA_LERP_MS,
        };
      },
      setBodyPose: (pose) => { bodyPoseRef.current = pose; },
      setMouthShape: (shape) => { mouthShapeRef.current = shape; },
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

        // Initial camera framing comes from the current framing preset.
        // We never re-create the camera on framing changes — the animation
        // loop lerps its existing position/lookAt/fov toward the new preset.
        // If setFraming() was called before mount, framingRef already holds
        // the requested mode; if not, it defaults to "full_body".
        const initialPreset = CAMERA_PRESETS[framingRef.current];
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
        // Mixer actions for the bundled breathing idle and the optional
        // Mixamo walk clip. Both exist in parallel; the animate loop
        // crossfades their weights based on bodyPoseRef.current.clip.
        let breathingAction: any = null;
        let walkAction: any = null;
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

            // Play first animation (idle/breathing) if available
            if (gltf.animations.length > 0) {
              mixer = new THREE.AnimationMixer(gltf.scene);
              breathingAction = mixer.clipAction(gltf.animations[0]);
              breathingAction.play();
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

            // Load the Mixamo walk clip alongside breathing. Tries GLB
            // first, then falls back to FBX (Mixamo's actual export format
            // since they dropped direct GLB export). Both paths are
            // wrapped in try/catch so a missing file just falls back to
            // breathing-only — no crash. Skipped when no mixer exists
            // (the avatar GLB had no animations) since AnimationMixer
            // needs the avatar root and we'd have no breathing action
            // to crossfade against.
            if (mixer) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let walkClip: any = null;
              try {
                walkClip = await new Promise<any>((resolve, reject) => {
                  loader.load("/animations/walk.glb", resolve, undefined, reject);
                });
              } catch {
                try {
                  const { FBXLoader } = await import(
                    "three/examples/jsm/loaders/FBXLoader.js"
                  );
                  const fbxLoader = new FBXLoader();
                  walkClip = await new Promise<any>((resolve, reject) => {
                    fbxLoader.load("/animations/walk.fbx", resolve, undefined, reject);
                  });
                } catch {
                  // both missing — falls back to breathing-only
                }
              }
              if (!cancelled && walkClip?.animations?.length > 0) {
                // Strip Mixamo's `mixamorig:` bone-name prefix from each
                // track so the clip binds to standard humanoid bones on the
                // Avaturn / RPM skeleton. Use /g so the prefix is stripped
                // even when it appears mid-path (some Mixamo exports use
                // hierarchical track names like `Y_Bot/mixamorig:Hips`).
                walkClip.animations.forEach((clip: { tracks: Array<{ name: string }> }) => {
                  clip.tracks.forEach((track) => {
                    track.name = track.name.replace(/mixamorig[1-9]?:/g, "");
                  });
                });
                // DEBUG: log skeleton + clip track names so a bone-mismatch
                // is visible in the browser console. Remove once verified.
                // eslint-disable-next-line no-console
                console.log("[IdleScene] walk clip tracks:", walkClip.animations[0].tracks.map((t: { name: string }) => t.name).slice(0, 20));
                if (avatarRoot) {
                  const boneNames: string[] = [];
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  avatarRoot.traverse((child: any) => {
                    if (child.isBone) boneNames.push(child.name);
                  });
                  // eslint-disable-next-line no-console
                  console.log("[IdleScene] avatar skeleton bones:", boneNames.slice(0, 30));
                }
                walkAction = mixer.clipAction(walkClip.animations[0]);
                walkAction.setEffectiveWeight(0); // start hidden — breathing leads
                walkAction.play();
              }
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
        const animate = () => {
          rafId = requestAnimationFrame(animate);
          const delta = clock.getDelta();
          const deltaMs = delta * 1000;

          if (mixer) mixer.update(delta);

          // ─── Body clip crossfade (breathing ↔ walking) ─────────
          // bodyPoseRef.current.clip drives the mixer weight. Slow lerp
          // (~0.05 per frame ≈ 1s @ 60fps) gives a smooth gait transition
          // rather than an abrupt swap. Both actions must be present —
          // the walk clip is optional, so guard on both refs.
          if (walkAction && breathingAction) {
            const targetWalkWeight = bodyPoseRef.current.clip === "walking" ? 1 : 0;
            const currentWeight = walkAction.getEffectiveWeight();
            const newWeight = currentWeight + (targetWalkWeight - currentWeight) * 0.05;
            walkAction.setEffectiveWeight(newWeight);
            breathingAction.setEffectiveWeight(1 - newWeight);
          }

          // ─── Camera lerp ─────────────────────────────────────────
          // When a new cameraMode is requested, lerpRef holds a from→to
          // preset plus a countdown. The avatar body is now externally
          // controlled (controller-driven choreography lands in a follow-up),
          // so there's no "settle to center" pre-phase any more.
          const lerp = lerpRef.current;
          if (lerp) {
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

          // Re-apply lookAt every frame so the camera tracks the lerping
          // target during the camera-lerp phase. Cheap (just a matrix op).
          camera.lookAt(lookAtTarget.x, lookAtTarget.y, lookAtTarget.z);

          // ─── Body pose (controller-driven X/Z) ───────────────────
          // Soft lerp toward the controller's target position so motion reads
          // smooth even when the controller updates intermittently. Skipped
          // when the GLB hasn't loaded yet (avatarRoot is still null).
          if (avatarRoot) {
            const target = bodyPoseRef.current;
            avatarRoot.position.x += (target.x - avatarRoot.position.x) * 0.1;
            avatarRoot.position.z += (target.z - avatarRoot.position.z) * 0.1;
          }

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

            // ─── Mouth shape (viseme-driven) ───────────────────────
            // mouthShapeRef is null when no audio is playing; clear all
            // mouth morphs in that case so the avatar's mouth is at rest.
            const mouthShape = mouthShapeRef.current;
            for (const key of ["jawOpen", "mouthFunnel", "mouthPucker", "mouthSmile", "mouthClose"] as const) {
              if (dict[key] !== undefined) {
                infl[dict[key]] = mouthShape ? mouthShape[key] : 0;
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
