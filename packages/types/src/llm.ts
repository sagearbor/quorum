// LLM provider interface from CONTRACT.md

import type { LLMTier } from "./enums";

export interface LLMProviderInterface {
  complete(prompt: string, tier: LLMTier): Promise<string>;
  embed(text: string): Promise<number[]>;
}
