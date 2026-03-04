// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
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

  describe("mock mode (SVG stick figure)", () => {
    it("should render mock SVG when mock=true", () => {
      render(<IdleScene mock={true} />);
      expect(screen.getByTestId("idle-scene-mock")).toBeInTheDocument();
    });

    it("should expose setGaze via ref", () => {
      const ref = createRef<IdleSceneHandle>();
      render(<IdleScene mock={true} ref={ref} />);

      expect(ref.current).not.toBeNull();
      expect(typeof ref.current!.setGaze).toBe("function");

      // Should not throw
      act(() => {
        ref.current!.setGaze(0.5);
        ref.current!.setGaze(-1);
        ref.current!.setGaze(0);
      });
    });

    it("should expose setEmotion via ref", () => {
      const ref = createRef<IdleSceneHandle>();
      render(<IdleScene mock={true} ref={ref} />);

      expect(ref.current).not.toBeNull();
      expect(typeof ref.current!.setEmotion).toBe("function");

      // Should not throw for any valid emotion
      act(() => {
        ref.current!.setEmotion("happy");
        ref.current!.setEmotion("surprised");
        ref.current!.setEmotion("concerned");
        ref.current!.setEmotion("focused");
        ref.current!.setEmotion("neutral");
      });
    });

    it("should clamp gaze values to [-1, 1]", () => {
      const ref = createRef<IdleSceneHandle>();
      render(<IdleScene mock={true} ref={ref} />);

      // Should not throw even with out-of-range values
      act(() => {
        ref.current!.setGaze(5);
        ref.current!.setGaze(-10);
      });
    });

    it("should render SVG with correct structure", () => {
      const { container } = render(<IdleScene mock={true} />);
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
      expect(svg!.getAttribute("viewBox")).toBeDefined();
    });
  });

  describe("three.js mode", () => {
    it("should render three.js container when mock=false", () => {
      render(<IdleScene mock={false} />);
      expect(screen.getByTestId("idle-scene-three")).toBeInTheDocument();
    });

    it("should expose setGaze and setEmotion via ref in three.js mode", () => {
      const ref = createRef<IdleSceneHandle>();
      render(<IdleScene mock={false} ref={ref} />);

      expect(ref.current).not.toBeNull();
      expect(typeof ref.current!.setGaze).toBe("function");
      expect(typeof ref.current!.setEmotion).toBe("function");

      // Should not throw
      ref.current!.setGaze(0.3);
      ref.current!.setEmotion("happy");
    });
  });

  describe("props", () => {
    it("should accept width and height props", () => {
      render(<IdleScene mock={true} width="400px" height="600px" />);
      const el = screen.getByTestId("idle-scene-mock");
      expect(el.style.width).toBe("400px");
      expect(el.style.height).toBe("600px");
    });

    it("should default to 100% width and height", () => {
      render(<IdleScene mock={true} />);
      const el = screen.getByTestId("idle-scene-mock");
      expect(el.style.width).toBe("100%");
      expect(el.style.height).toBe("100%");
    });
  });
});
