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
});
