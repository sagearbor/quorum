/**
 * TransitionEngine — orchestrates all 6 transitions with archetype-weighted
 * random selection. Includes test harness mode (AVATAR_TRANSITION_TEST=true).
 *
 * API:
 *  - play(archetypeId)  → weighted random transition for that archetype
 *  - playTest(index)    → play a specific transition by index
 *  - cycleAll(interval) → auto-cycle through all transitions (test mode)
 *  - stop()             → stop cycling
 */

import type {
  Transition,
  TransitionContext,
  ArchetypeId,
  TransitionWeights,
} from './Transition';
import { ZoomIn } from './ZoomIn';
import { JogAndPeek } from './JogAndPeek';
import { RunAndBounce } from './RunAndBounce';
import { SitDown } from './SitDown';
import { DepthBlur } from './DepthBlur';
import { EyeMatchCut } from './EyeMatchCut';

/** All transitions in canonical order */
const ALL_TRANSITIONS: Transition[] = [
  new ZoomIn(),        // 0
  new JogAndPeek(),    // 1
  new RunAndBounce(),  // 2
  new SitDown(),       // 3
  new DepthBlur(),     // 4
  new EyeMatchCut(),   // 5
];

/**
 * Archetype → weight array (one weight per transition, same order as ALL_TRANSITIONS).
 * Higher weight = more likely to be selected.
 *
 * Mapping rationale from personality profiles:
 *  - Formal/low-energy archetypes → ZoomIn, SitDown, DepthBlur (elegant)
 *  - Energetic archetypes → JogAndPeek, RunAndBounce (dynamic)
 *  - Dramatic/technical → EyeMatchCut
 */
const ARCHETYPE_WEIGHTS: TransitionWeights = {
  //                           Zoom  Jog  Run  Sit  Blur  Eye
  medical_clinical:           [  3,   1,   0,   3,   2,    1 ],
  researcher:                 [  2,   1,   1,   1,   3,    2 ],
  faculty:                    [  3,   1,   0,   3,   2,    1 ],
  student_grad:               [  1,   3,   2,   1,   1,    2 ],
  student_undergrad:          [  1,   2,   3,   1,   1,    2 ],
  administrator:              [  3,   0,   0,   3,   2,    1 ],
  ethics:                     [  2,   1,   0,   2,   3,    1 ],
  engineer_tech:              [  2,   2,   1,   1,   1,    3 ],
  finance_ops:                [  3,   1,   0,   3,   2,    1 ],
  patient_participant:        [  1,   2,   1,   3,   1,    1 ],
  humanities_social:          [  1,   2,   1,   1,   3,    2 ],
  neutral:                    [  2,   2,   1,   2,   2,    1 ],
};

export class TransitionEngine {
  private transitions: Transition[] = ALL_TRANSITIONS;
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private currentIndex = 0;
  private playing = false;

  /** Current transition name (for test harness UI) */
  get currentTransitionName(): string {
    return this.transitions[this.currentIndex].name;
  }

  get count(): number {
    return this.transitions.length;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Play a weighted-random transition for the given archetype */
  async play(archetypeId: ArchetypeId, ctx: TransitionContext): Promise<string> {
    const weights = ARCHETYPE_WEIGHTS[archetypeId] ?? ARCHETYPE_WEIGHTS.neutral;
    const index = weightedRandom(weights);
    this.currentIndex = index;
    await this.playIndex(index, ctx);
    return this.transitions[index].name;
  }

  /** Reverse the current transition */
  async reverse(ctx: TransitionContext): Promise<void> {
    this.playing = true;
    try {
      await this.transitions[this.currentIndex].reverse(ctx);
    } finally {
      this.playing = false;
    }
  }

  /** Play a specific transition by index (for test harness) */
  async playTest(index: number, ctx: TransitionContext): Promise<void> {
    this.currentIndex = index % this.transitions.length;
    await this.playIndex(this.currentIndex, ctx);
  }

  /** Auto-cycle all transitions with play+reverse. Returns stop function. */
  cycleAll(intervalMs: number, ctx: TransitionContext, onTransition?: (name: string, index: number) => void): () => void {
    let index = 0;
    let running = true;

    const cycle = async () => {
      while (running) {
        const t = this.transitions[index % this.transitions.length];
        this.currentIndex = index % this.transitions.length;
        onTransition?.(t.name, this.currentIndex);

        await this.playIndex(this.currentIndex, ctx);
        await wait(intervalMs / 2);
        await this.reverse(ctx);
        await wait(intervalMs / 2);

        index++;
      }
    };

    cycle();

    return () => {
      running = false;
    };
  }

  /** Next transition in test mode */
  next(): number {
    this.currentIndex = (this.currentIndex + 1) % this.transitions.length;
    return this.currentIndex;
  }

  /** Previous transition in test mode */
  prev(): number {
    this.currentIndex = (this.currentIndex - 1 + this.transitions.length) % this.transitions.length;
    return this.currentIndex;
  }

  /** Get transition name at index */
  nameAt(index: number): string {
    return this.transitions[index % this.transitions.length].name;
  }

  private async playIndex(index: number, ctx: TransitionContext): Promise<void> {
    this.playing = true;
    try {
      await this.transitions[index].play(ctx);
    } finally {
      this.playing = false;
    }
  }
}

/** Weighted random selection. Returns index. */
function weightedRandom(weights: number[]): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total === 0) return 0;

  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** For testing: expose the weight table */
export { ARCHETYPE_WEIGHTS, ALL_TRANSITIONS };
