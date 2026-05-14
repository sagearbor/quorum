// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React, { createRef } from "react";
import { IdleScene, type IdleSceneHandle } from "../IdleScene";

// Mock Three.js and loaders to avoid WebGL in test environment
vi.mock("three", () => {
  const Scene = vi.fn(() => ({
    add: vi.fn(),
    background: null,
  }));
  const PerspectiveCamera = vi.fn(() => ({
    position: { set: vi.fn() },
    lookAt: vi.fn(),
    aspect: 1,
    fov: 35,
    updateProjectionMatrix: vi.fn(),
  }));
  const WebGLRenderer = vi.fn(() => ({
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    domElement: document.createElement("canvas"),
    outputColorSpace: "",
  }));
  const AmbientLight = vi.fn(() => ({}));
  const DirectionalLight = vi.fn(() => ({ position: { set: vi.fn() } }));
  const AnimationMixer = vi.fn(() => ({
    update: vi.fn(),
    clipAction: vi.fn(() => ({ play: vi.fn() })),
  }));
  const Clock = vi.fn(() => ({ getDelta: vi.fn(() => 0.016) }));
  const Color = vi.fn();

  return {
    Scene,
    PerspectiveCamera,
    WebGLRenderer,
    AmbientLight,
    DirectionalLight,
    AnimationMixer,
    Clock,
    Color,
    SRGBColorSpace: "srgb",
  };
});

vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: vi.fn(() => ({
    load: vi.fn(),
  })),
}));

describe("IdleScene", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("three.js mode (default)", () => {
    it("should render three.js container", () => {
      render(<IdleScene />);
      expect(screen.getByTestId("idle-scene-three")).toBeInTheDocument();
    });

    it("should expose setGaze and setEmotion via ref", () => {
      const ref = createRef<IdleSceneHandle>();
      render(<IdleScene ref={ref} />);

      expect(ref.current).not.toBeNull();
      expect(typeof ref.current!.setGaze).toBe("function");
      expect(typeof ref.current!.setEmotion).toBe("function");

      // Should not throw
      ref.current!.setGaze(0.3);
      ref.current!.setEmotion("happy");
    });

    it("should expose setGaze with optional pitch parameter", () => {
      const ref = createRef<IdleSceneHandle>();
      render(<IdleScene ref={ref} />);

      // Should not throw with or without pitch
      ref.current!.setGaze(0.5);
      ref.current!.setGaze(0.5, 0.2);
      ref.current!.setGaze(-0.3, -0.1);
    });

    it("should accept all DetectedEmotion values via setEmotion", () => {
      const ref = createRef<IdleSceneHandle>();
      render(<IdleScene ref={ref} />);

      // Should not throw for any valid emotion
      ref.current!.setEmotion("neutral");
      ref.current!.setEmotion("happy");
      ref.current!.setEmotion("surprised");
      ref.current!.setEmotion("concerned");
      ref.current!.setEmotion("focused");
    });

    it("should accept width and height props", () => {
      render(<IdleScene width="400px" height="600px" />);
      const el = screen.getByTestId("idle-scene-three");
      expect(el.style.width).toBe("400px");
      expect(el.style.height).toBe("600px");
    });

    it("should default to 100% width and height", () => {
      render(<IdleScene />);
      const el = screen.getByTestId("idle-scene-three");
      expect(el.style.width).toBe("100%");
      expect(el.style.height).toBe("100%");
    });

    it("should accept a glbUrl prop without throwing", () => {
      expect(() => {
        render(<IdleScene glbUrl="/avatars/test.glb" />);
      }).not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Imperative handle — setFraming / setBodyPose / setMouthShape
  //
  // The choreographer (useAvatarController) drives framing, body pose,
  // and visemes per-frame via the imperative handle, not via React props.
  // We smoke-mount here: the Three.js scene boots inside an async IIFE
  // so unit-asserting camera params requires real WebGL or a much heavier
  // mock setup. End-to-end behavior is exercised by AvatarPanel + visual QA.
  // ─────────────────────────────────────────────────────────────────
  describe("imperative handle", () => {
    it("mounts cleanly with no props (defaults to full_body framing)", () => {
      expect(() => {
        render(<IdleScene />);
      }).not.toThrow();
      expect(screen.getByTestId("idle-scene-three")).toBeInTheDocument();
    });

    it("exposes setFraming, setBodyPose, setMouthShape via ref", () => {
      const ref = createRef<IdleSceneHandle>();
      render(<IdleScene ref={ref} />);

      expect(ref.current).not.toBeNull();
      expect(typeof ref.current!.setFraming).toBe("function");
      expect(typeof ref.current!.setBodyPose).toBe("function");
      expect(typeof ref.current!.setMouthShape).toBe("function");
    });

    it("setFraming accepts all CameraMode values without throwing", () => {
      const ref = createRef<IdleSceneHandle>();
      render(<IdleScene ref={ref} />);

      expect(() => ref.current!.setFraming("full_body")).not.toThrow();
      expect(() => ref.current!.setFraming("torso")).not.toThrow();
      expect(() => ref.current!.setFraming("bust")).not.toThrow();
      // Calling with the same mode again is a no-op.
      expect(() => ref.current!.setFraming("bust")).not.toThrow();
    });

    it("setBodyPose accepts breathing and walking clip targets", () => {
      const ref = createRef<IdleSceneHandle>();
      render(<IdleScene ref={ref} />);

      expect(() =>
        ref.current!.setBodyPose({ x: 0, z: 0, clip: "breathing" })
      ).not.toThrow();
      expect(() =>
        ref.current!.setBodyPose({ x: 0.5, z: -0.3, clip: "walking" })
      ).not.toThrow();
    });

    it("setMouthShape accepts a shape object and null (rest)", () => {
      const ref = createRef<IdleSceneHandle>();
      render(<IdleScene ref={ref} />);

      expect(() =>
        ref.current!.setMouthShape({
          jawOpen: 0.4,
          mouthFunnel: 0.1,
          mouthPucker: 0,
          mouthSmile: 0,
          mouthClose: 0,
        })
      ).not.toThrow();
      expect(() => ref.current!.setMouthShape(null)).not.toThrow();
    });
  });
});
