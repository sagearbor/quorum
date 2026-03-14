/**
 * speechSynthesis — lightweight browser TTS utility.
 *
 * Used as a fallback when no AvatarProvider (ElevenLabs/Simli) is configured.
 * Resolves when speech ends, or immediately if the API is unavailable
 * (server-side rendering, older browsers).
 */

/**
 * Speak `text` using the Web Speech Synthesis API.
 * Resolves when speech ends (or on error/unavailability).
 */
export function speakText(text: string, rate = 1.0): Promise<void> {
  return new Promise<void>((resolve) => {
    // Guard: SSR or browsers that don't implement the API
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve();
      return;
    }

    // Cancel any currently queued speech so we don't backlog
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();

    window.speechSynthesis.speak(utterance);
  });
}

/**
 * Cancel any ongoing browser speech synthesis.
 * Safe to call even when nothing is playing.
 */
export function cancelSpeech(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

/** True when the browser is actively speaking. */
export function isSpeaking(): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return false;
  }
  return window.speechSynthesis.speaking;
}
