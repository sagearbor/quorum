// apps/web/src/components/avatar/visemes.ts

export type Vowel = "AH" | "EE" | "OO" | "MM" | "neutral";

export interface MouthShape {
  jawOpen: number;
  mouthFunnel: number;
  mouthPucker: number;
  mouthSmile: number;
  mouthClose: number;
}

const SILENCE_THRESHOLD = 15;

export function classifyVowel(fft: Uint8Array): Vowel {
  const totalEnergy = fft.reduce((a, b) => a + b, 0) / fft.length;
  if (totalEnergy < SILENCE_THRESHOLD) return "neutral";

  // Bin index → frequency assumes 44.1kHz sample rate, 256-sample FFT
  // (each bin ≈ 172Hz). Adjust if AnalyserNode is configured differently.
  const lowMid = fft.slice(3, 9).reduce((a, b) => a + b, 0);   // ~500-1500 Hz (AH)
  const high = fft.slice(15, 25).reduce((a, b) => a + b, 0);   // ~2500-4300 Hz (EE)
  const mid = fft.slice(9, 15).reduce((a, b) => a + b, 0);     // ~1500-2500 Hz (OO/UH)
  const low = fft.slice(0, 3).reduce((a, b) => a + b, 0);      // ~0-500 Hz (MM)

  const max = Math.max(lowMid, high, mid, low);
  if (max === lowMid) return "AH";
  if (max === high) return "EE";
  if (max === mid) return "OO";
  return "MM";
}

export function vowelToMorphShape(vowel: Vowel): MouthShape {
  switch (vowel) {
    case "AH": return { jawOpen: 0.6, mouthFunnel: 0, mouthPucker: 0, mouthSmile: 0, mouthClose: 0 };
    case "EE": return { jawOpen: 0.2, mouthFunnel: 0, mouthPucker: 0, mouthSmile: 0.4, mouthClose: 0 };
    case "OO": return { jawOpen: 0.3, mouthFunnel: 0.7, mouthPucker: 0.4, mouthSmile: 0, mouthClose: 0 };
    case "MM": return { jawOpen: 0, mouthFunnel: 0, mouthPucker: 0, mouthSmile: 0, mouthClose: 0.5 };
    case "neutral": return { jawOpen: 0, mouthFunnel: 0, mouthPucker: 0, mouthSmile: 0, mouthClose: 0 };
  }
}
