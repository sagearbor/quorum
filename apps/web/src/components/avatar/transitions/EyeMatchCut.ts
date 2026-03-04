/**
 * EyeMatchCut — hard cut to extreme close-up eyes, pulls back to bust. Dramatic.
 */

import type { Transition, TransitionContext } from './Transition';

const CUT_HOLD = 300;
const PULLBACK_DURATION = 800;

export class EyeMatchCut implements Transition {
  readonly name = 'EyeMatchCut';

  async play(ctx: TransitionContext): Promise<void> {
    const { idleLayer, bustLayer } = ctx;

    // Hard cut: zoom idle to eyes instantly
    idleLayer.style.transition = 'none';
    idleLayer.style.transform = 'scale(6) translateY(30%)';

    await wait(CUT_HOLD);

    // Swap layers — hard cut to bust zoomed into eyes
    idleLayer.style.display = 'none';
    bustLayer.style.display = 'block';
    bustLayer.style.transition = 'none';
    bustLayer.style.transform = 'scale(3) translateY(25%)';
    bustLayer.style.opacity = '1';

    await wait(CUT_HOLD);

    // Pull back bust to normal framing
    bustLayer.style.transition = `transform ${PULLBACK_DURATION}ms cubic-bezier(0.25, 0.1, 0.25, 1)`;
    bustLayer.style.transform = 'scale(1) translateY(0)';

    await wait(PULLBACK_DURATION);
    clearTransitions(idleLayer, bustLayer);
  }

  async reverse(ctx: TransitionContext): Promise<void> {
    const { idleLayer, bustLayer } = ctx;

    // Push into bust eyes
    bustLayer.style.transition = `transform ${PULLBACK_DURATION}ms ease-in`;
    bustLayer.style.transform = 'scale(3) translateY(25%)';

    await wait(PULLBACK_DURATION);

    // Hard cut back to idle (zoomed eyes)
    bustLayer.style.display = 'none';
    idleLayer.style.display = 'block';
    idleLayer.style.transition = 'none';
    idleLayer.style.transform = 'scale(6) translateY(30%)';
    idleLayer.style.opacity = '1';

    await wait(CUT_HOLD);

    // Pull back idle to normal
    idleLayer.style.transition = `transform ${PULLBACK_DURATION}ms cubic-bezier(0.25, 0.1, 0.25, 1)`;
    idleLayer.style.transform = 'scale(1) translateY(0)';

    await wait(PULLBACK_DURATION);
    clearTransitions(idleLayer, bustLayer);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearTransitions(...els: HTMLElement[]): void {
  for (const el of els) {
    el.style.transition = '';
  }
}
