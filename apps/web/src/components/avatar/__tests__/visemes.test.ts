import { describe, it, expect } from "vitest";
import { classifyVowel, vowelToMorphShape } from "../visemes";

describe("visemes", () => {
  it("classifyVowel returns neutral for silence", () => {
    const silent = new Uint8Array(64).fill(0);
    expect(classifyVowel(silent)).toBe("neutral");
  });

  it("classifyVowel returns AH when low-mid frequency band dominates", () => {
    const fft = new Uint8Array(64).fill(20);
    fft[5] = 200; fft[6] = 200; fft[7] = 200;
    expect(classifyVowel(fft)).toBe("AH");
  });

  it("classifyVowel returns EE when high band dominates", () => {
    const fft = new Uint8Array(64).fill(20);
    fft[20] = 200; fft[21] = 200; fft[22] = 200;
    expect(classifyVowel(fft)).toBe("EE");
  });

  it("vowelToMorphShape AH opens jaw without funnel", () => {
    const shape = vowelToMorphShape("AH");
    expect(shape.jawOpen).toBeGreaterThan(0.5);
    expect(shape.mouthFunnel).toBe(0);
  });

  it("vowelToMorphShape OO funnels and puckers", () => {
    const shape = vowelToMorphShape("OO");
    expect(shape.mouthFunnel).toBeGreaterThan(0.5);
    expect(shape.mouthPucker).toBeGreaterThan(0.3);
  });

  it("vowelToMorphShape neutral closes everything", () => {
    const shape = vowelToMorphShape("neutral");
    expect(shape.jawOpen).toBe(0);
    expect(shape.mouthFunnel).toBe(0);
  });
});
