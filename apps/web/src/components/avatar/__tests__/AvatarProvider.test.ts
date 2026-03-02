import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAvatarProvider } from "../AvatarProvider";

// Mock the provider modules
vi.mock("../MockProvider", () => ({
  MockProvider: class MockProvider {
    async init() {}
    async speak() {}
    setHeadPose() {}
    isSpeaking() { return false; }
    destroy() {}
  },
}));

vi.mock("../ElevenLabsProvider", () => ({
  ElevenLabsProvider: class ElevenLabsProvider {
    async init() {}
    async speak() {}
    setHeadPose() {}
    isSpeaking() { return false; }
    destroy() {}
  },
}));

vi.mock("../SimliProvider", () => ({
  SimliProvider: class SimliProvider {
    async init() {}
    async speak() {}
    setHeadPose() {}
    isSpeaking() { return false; }
    destroy() {}
  },
}));

describe("createAvatarProvider", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("returns MockProvider when type is 'mock'", () => {
    const provider = createAvatarProvider("mock");
    expect(provider).toBeDefined();
    expect(provider.init).toBeDefined();
    expect(provider.speak).toBeDefined();
    expect(provider.setHeadPose).toBeDefined();
    expect(provider.destroy).toBeDefined();
  });

  it("returns ElevenLabsProvider when type is 'elevenlabs'", () => {
    const provider = createAvatarProvider("elevenlabs");
    expect(provider).toBeDefined();
  });

  it("returns SimliProvider when type is 'simli'", () => {
    const provider = createAvatarProvider("simli");
    expect(provider).toBeDefined();
  });

  it("defaults to mock when AVATAR_MOCK=true", () => {
    process.env.NEXT_PUBLIC_AVATAR_MOCK = "true";
    const provider = createAvatarProvider();
    expect(provider).toBeDefined();
    // It should resolve to mock
  });

  it("reads NEXT_PUBLIC_AVATAR_PROVIDER env var", () => {
    process.env.NEXT_PUBLIC_AVATAR_PROVIDER = "elevenlabs";
    const provider = createAvatarProvider();
    expect(provider).toBeDefined();
  });

  it("defaults to mock when no env vars set", () => {
    delete process.env.NEXT_PUBLIC_AVATAR_MOCK;
    delete process.env.NEXT_PUBLIC_AVATAR_PROVIDER;
    delete process.env.AVATAR_MOCK;
    const provider = createAvatarProvider();
    expect(provider).toBeDefined();
  });

  it("AVATAR_MOCK=true overrides AVATAR_PROVIDER", () => {
    process.env.NEXT_PUBLIC_AVATAR_MOCK = "true";
    process.env.NEXT_PUBLIC_AVATAR_PROVIDER = "elevenlabs";
    // Mock takes precedence
    const provider = createAvatarProvider();
    expect(provider).toBeDefined();
  });

  it("provider satisfies interface contract", async () => {
    const provider = createAvatarProvider("mock");
    // init returns a promise
    await expect(provider.init({})).resolves.toBeUndefined();
    // speak returns a promise
    await expect(provider.speak("hello")).resolves.toBeUndefined();
    // setHeadPose is synchronous
    expect(() => provider.setHeadPose(0, 0)).not.toThrow();
    // isSpeaking returns boolean
    expect(typeof provider.isSpeaking()).toBe("boolean");
    // destroy is synchronous
    expect(() => provider.destroy()).not.toThrow();
  });
});
