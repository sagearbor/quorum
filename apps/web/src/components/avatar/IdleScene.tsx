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
    const sceneRef = useRef<any>(null);
    const gazeRef = useRef(0);
    const pitchRef = useRef(0);
    const emotionRef = useRef<DetectedEmotion>("neutral");
    const [loaded, setLoaded] = useState(false);

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

        /* eslint-disable @typescript-eslint/no-explicit-any */
        let mixer: any = null;
        let headBone: any = null;
        let leftEyeBone: any = null;
        let rightEyeBone: any = null;
        let skinnedMesh: any = null;
        /* eslint-enable @typescript-eslint/no-explicit-any */

        // Load GLB
        if (props.glbUrl) {
          const loader = new GLTFLoader();
          try {
            const gltf = await new Promise<any>((resolve, reject) => {
              loader.load(props.glbUrl!, resolve, undefined, reject);
            });

            if (cancelled) return;

            scene.add(gltf.scene);

            // Find bones for gaze control
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

        sceneRef.current = { scene, camera, renderer, mixer, headBone, leftEyeBone, rightEyeBone, skinnedMesh };
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

          if (mixer) mixer.update(delta);

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
