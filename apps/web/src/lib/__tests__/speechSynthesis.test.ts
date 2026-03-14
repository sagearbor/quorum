/**
 * Tests for speechSynthesis utility
 *
 * Uses a mock of the browser's SpeechSynthesis API since jsdom doesn't
 * implement it. Verifies the correct API calls are made and that the
 * promise resolves on end/error events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { speakText, cancelSpeech, isSpeaking } from "../speechSynthesis";

// ---------------------------------------------------------------------------
// Mock SpeechSynthesisUtterance and speechSynthesis
// ---------------------------------------------------------------------------

class MockUtterance {
  text: string;
  rate = 1.0;
  pitch = 1.0;
  volume = 1.0;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

const mockSpeak = vi.fn();
const mockCancel = vi.fn();
const mockSpeaking = vi.fn().mockReturnValue(false);

const mockSpeechSynthesis = {
  speak: mockSpeak,
  cancel: mockCancel,
  get speaking() {
    return mockSpeaking();
  },
};

beforeEach(() => {
  vi.clearAllMocks();

  // Install on window
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    value: MockUtterance,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "speechSynthesis", {
    value: mockSpeechSynthesis,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  // Clean up
  delete (window as Record<string, unknown>).SpeechSynthesisUtterance;
  delete (window as Record<string, unknown>).speechSynthesis;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("speakText", () => {
  it("calls speechSynthesis.speak with an utterance for the text", async () => {
    mockSpeak.mockImplementation((utt: MockUtterance) => {
      // Simulate immediate end event
      setTimeout(() => utt.onend?.(), 0);
    });

    await speakText("Hello world");

    expect(mockSpeak).toHaveBeenCalledOnce();
    expect(mockSpeak.mock.calls[0][0]).toBeInstanceOf(MockUtterance);
    expect((mockSpeak.mock.calls[0][0] as MockUtterance).text).toBe("Hello world");
  });

  it("cancels existing speech before speaking", async () => {
    mockSpeak.mockImplementation((utt: MockUtterance) => {
      setTimeout(() => utt.onend?.(), 0);
    });

    await speakText("Test");

    expect(mockCancel).toHaveBeenCalledBefore(mockSpeak);
  });

  it("resolves when utterance fires onend", async () => {
    let capturedUtterance: MockUtterance | null = null;
    mockSpeak.mockImplementation((utt: MockUtterance) => {
      capturedUtterance = utt;
    });

    let resolved = false;
    const promise = speakText("Resolve test").then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    capturedUtterance!.onend?.();
    await promise;

    expect(resolved).toBe(true);
  });

  it("resolves when utterance fires onerror (does not reject)", async () => {
    mockSpeak.mockImplementation((utt: MockUtterance) => {
      setTimeout(() => utt.onerror?.(), 0);
    });

    // Should not throw
    await expect(speakText("Error test")).resolves.toBeUndefined();
  });

  it("resolves immediately when speechSynthesis is not available", async () => {
    // Remove the API
    delete (window as Record<string, unknown>).speechSynthesis;

    await expect(speakText("No API")).resolves.toBeUndefined();
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it("applies the rate parameter to the utterance", async () => {
    mockSpeak.mockImplementation((utt: MockUtterance) => {
      setTimeout(() => utt.onend?.(), 0);
    });

    await speakText("Rate test", 1.5);

    expect((mockSpeak.mock.calls[0][0] as MockUtterance).rate).toBe(1.5);
  });
});

describe("cancelSpeech", () => {
  it("calls speechSynthesis.cancel", () => {
    cancelSpeech();
    expect(mockCancel).toHaveBeenCalledOnce();
  });

  it("does not throw when speechSynthesis is not available", () => {
    delete (window as Record<string, unknown>).speechSynthesis;
    expect(() => cancelSpeech()).not.toThrow();
  });
});

describe("isSpeaking", () => {
  it("returns false when not speaking", () => {
    mockSpeaking.mockReturnValue(false);
    expect(isSpeaking()).toBe(false);
  });

  it("returns true when speaking", () => {
    mockSpeaking.mockReturnValue(true);
    expect(isSpeaking()).toBe(true);
  });

  it("returns false when speechSynthesis is not available", () => {
    delete (window as Record<string, unknown>).speechSynthesis;
    expect(isSpeaking()).toBe(false);
  });
});
