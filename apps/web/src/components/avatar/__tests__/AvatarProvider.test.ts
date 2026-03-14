import { describe, it, expect, vi, afterEach } from "vitest";
import { createAvatarProvider } from "../AvatarProvider";

// Mock the provider modules
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

  it("returns ElevenLabsProvider when type is 'elevenlabs'", () => {
    const provider = createAvatarProvider("elevenlabs");
    expect(provider).not.toBeNull();
    expect(provider!.init).toBeDefined();
    expect(provider!.speak).toBeDefined();
    expect(provider!.setHeadPose).toBeDefined();
    expect(provider!.destroy).toBeDefined();
  });

  it("returns SimliProvider when type is 'simli'", () => {
    const provider = createAvatarProvider("simli");
    expect(provider).not.toBeNull();
  });

  it("returns null when no type is specified and no env var is set", () => {
    delete process.env.NEXT_PUBLIC_AVATAR_PROVIDER;
    const provider = createAvatarProvider();
    expect(provider).toBeNull();
  });

  it("reads NEXT_PUBLIC_AVATAR_PROVIDER=elevenlabs env var", () => {
    process.env.NEXT_PUBLIC_AVATAR_PROVIDER = "elevenlabs";
    const provider = createAvatarProvider();
    expect(provider).not.toBeNull();
  });

  it("reads NEXT_PUBLIC_AVATAR_PROVIDER=simli env var", () => {
    process.env.NEXT_PUBLIC_AVATAR_PROVIDER = "simli";
    const provider = createAvatarProvider();
    expect(provider).not.toBeNull();
  });

  it("returns null for unknown NEXT_PUBLIC_AVATAR_PROVIDER value", () => {
    process.env.NEXT_PUBLIC_AVATAR_PROVIDER = "unknown-provider";
    const provider = createAvatarProvider();
    expect(provider).toBeNull();
  });

  it("ElevenLabsProvider satisfies interface contract", async () => {
    const provider = createAvatarProvider("elevenlabs")!;
    await expect(provider.init({})).resolves.toBeUndefined();
    await expect(provider.speak("hello")).resolves.toBeUndefined();
    expect(() => provider.setHeadPose(0, 0)).not.toThrow();
    expect(typeof provider.isSpeaking()).toBe("boolean");
    expect(() => provider.destroy()).not.toThrow();
  });
});
