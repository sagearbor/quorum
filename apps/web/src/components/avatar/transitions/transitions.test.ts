import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TransitionContext } from './Transition';
import { ZoomIn } from './ZoomIn';
import { JogAndPeek } from './JogAndPeek';
import { RunAndBounce } from './RunAndBounce';
import { SitDown } from './SitDown';
import { DepthBlur } from './DepthBlur';
import { EyeMatchCut } from './EyeMatchCut';
import { TransitionEngine, ALL_TRANSITIONS, ARCHETYPE_WEIGHTS } from './TransitionEngine';

/** Create a mock TransitionContext with two real DOM elements */
function createMockContext(): TransitionContext {
  const idleLayer = document.createElement('div');
  const bustLayer = document.createElement('div');
  idleLayer.style.display = 'block';
  bustLayer.style.display = 'none';
  document.body.appendChild(idleLayer);
  document.body.appendChild(bustLayer);
  return { idleLayer, bustLayer };
}

function cleanupContext(ctx: TransitionContext) {
  ctx.idleLayer.remove();
  ctx.bustLayer.remove();
}

describe('Transition interface', () => {
  let ctx: TransitionContext;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = createMockContext();
  });

  afterEach(() => {
    cleanupContext(ctx);
    vi.useRealTimers();
  });

  const transitions = [
    { Ctor: ZoomIn, name: 'ZoomIn' },
    { Ctor: JogAndPeek, name: 'JogAndPeek' },
    { Ctor: RunAndBounce, name: 'RunAndBounce' },
    { Ctor: SitDown, name: 'SitDown' },
    { Ctor: DepthBlur, name: 'DepthBlur' },
    { Ctor: EyeMatchCut, name: 'EyeMatchCut' },
  ];

  for (const { Ctor, name } of transitions) {
    describe(name, () => {
      it('has correct name', () => {
        const t = new Ctor();
        expect(t.name).toBe(name);
      });

      it('play() resolves a Promise', async () => {
        const t = new Ctor();
        const playPromise = t.play(ctx);
        // Advance timers past any transition durations
        await vi.advanceTimersByTimeAsync(5000);
        await expect(playPromise).resolves.toBeUndefined();
      });

      it('reverse() resolves a Promise', async () => {
        const t = new Ctor();
        // Play first so there's something to reverse
        const playPromise = t.play(ctx);
        await vi.advanceTimersByTimeAsync(5000);
        await playPromise;

        // Reset layers for reverse
        ctx.bustLayer.style.display = 'block';
        ctx.bustLayer.style.opacity = '1';

        const reversePromise = t.reverse(ctx);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(reversePromise).resolves.toBeUndefined();
      });

      it('play() modifies DOM styles', async () => {
        const t = new Ctor();
        const playPromise = t.play(ctx);
        await vi.advanceTimersByTimeAsync(5000);
        await playPromise;

        // After play: idle hidden, bust visible
        expect(ctx.idleLayer.style.display).toBe('none');
        expect(ctx.bustLayer.style.display).toBe('block');
      });
    });
  }
});

describe('TransitionEngine', () => {
  let engine: TransitionEngine;
  let ctx: TransitionContext;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new TransitionEngine();
    ctx = createMockContext();
  });

  afterEach(() => {
    cleanupContext(ctx);
    vi.useRealTimers();
  });

  it('has 6 transitions', () => {
    expect(engine.count).toBe(6);
    expect(ALL_TRANSITIONS).toHaveLength(6);
  });

  it('has weights for all 12 archetypes', () => {
    const archetypes = [
      'medical_clinical', 'researcher', 'faculty', 'student_grad',
      'student_undergrad', 'administrator', 'ethics', 'engineer_tech',
      'finance_ops', 'patient_participant', 'humanities_social', 'neutral',
    ] as const;

    for (const id of archetypes) {
      expect(ARCHETYPE_WEIGHTS[id]).toBeDefined();
      expect(ARCHETYPE_WEIGHTS[id]).toHaveLength(6);
    }
  });

  it('play() returns a transition name', async () => {
    const playPromise = engine.play('neutral', ctx);
    await vi.advanceTimersByTimeAsync(5000);
    const name = await playPromise;
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  it('playTest() plays a specific transition by index', async () => {
    const promise = engine.playTest(2, ctx);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    expect(engine.currentTransitionName).toBe('RunAndBounce');
  });

  it('next() and prev() cycle through transitions', () => {
    expect(engine.nameAt(0)).toBe('ZoomIn');

    engine.next();
    expect(engine.currentTransitionName).toBe('JogAndPeek');

    engine.next();
    expect(engine.currentTransitionName).toBe('RunAndBounce');

    engine.prev();
    expect(engine.currentTransitionName).toBe('JogAndPeek');
  });

  it('next() wraps around at end', () => {
    for (let i = 0; i < 6; i++) engine.next();
    // Should wrap back to ZoomIn (index 0)
    expect(engine.currentTransitionName).toBe('ZoomIn');
  });

  it('prev() wraps around at start', () => {
    engine.prev();
    expect(engine.currentTransitionName).toBe('EyeMatchCut');
  });

  it('cycleAll() returns a stop function', () => {
    const stop = engine.cycleAll(1000, ctx);
    expect(typeof stop).toBe('function');
    stop();
  });

  it('isPlaying reflects transition state', async () => {
    expect(engine.isPlaying).toBe(false);

    const promise = engine.playTest(0, ctx);
    // isPlaying should be true during playback
    expect(engine.isPlaying).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(engine.isPlaying).toBe(false);
  });

  it('nameAt() returns correct names for all indices', () => {
    const expected = ['ZoomIn', 'JogAndPeek', 'RunAndBounce', 'SitDown', 'DepthBlur', 'EyeMatchCut'];
    for (let i = 0; i < expected.length; i++) {
      expect(engine.nameAt(i)).toBe(expected[i]);
    }
  });

  it('each archetype weight array sums to > 0', () => {
    for (const [id, weights] of Object.entries(ARCHETYPE_WEIGHTS)) {
      const sum = weights.reduce((a: number, b: number) => a + b, 0);
      expect(sum).toBeGreaterThan(0);
    }
  });
});
