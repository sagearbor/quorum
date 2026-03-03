/**
 * JogAndPeek — avatar jogs off screen edge, bust slides in from same edge with spring.
 */

import type { Transition, TransitionContext } from './Transition';

const DURATION = 1000;
const SLIDE_DURATION = 600;

export class JogAndPeek implements Transition {
  readonly name = 'JogAndPeek';

  async play(ctx: TransitionContext): Promise<void> {
    const { idleLayer, bustLayer } = ctx;

    bustLayer.style.opacity = '0';
    bustLayer.style.transform = 'translateX(100%)';
    bustLayer.style.display = 'block';

    // Avatar jogs off right edge
    idleLayer.style.transition = `transform ${DURATION}ms ease-in`;
    idleLayer.style.transform = 'translateX(-110%)';

    await wait(DURATION);
    idleLayer.style.display = 'none';

    // Bust slides in from right with spring overshoot
    bustLayer.style.transition = `transform ${SLIDE_DURATION}ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 200ms ease-out`;
    bustLayer.style.transform = 'translateX(0)';
    bustLayer.style.opacity = '1';

    await wait(SLIDE_DURATION);
    clearTransitions(idleLayer, bustLayer);
  }

  async reverse(ctx: TransitionContext): Promise<void> {
    const { idleLayer, bustLayer } = ctx;

    // Bust slides out right
    bustLayer.style.transition = `transform ${SLIDE_DURATION}ms ease-in, opacity 200ms ease-in ${SLIDE_DURATION * 0.7}ms`;
    bustLayer.style.transform = 'translateX(100%)';
    bustLayer.style.opacity = '0';

    await wait(SLIDE_DURATION);
    bustLayer.style.display = 'none';

    // Avatar jogs back from left
    idleLayer.style.display = 'block';
    idleLayer.style.transform = 'translateX(-110%)';
    idleLayer.style.transition = `transform ${DURATION}ms cubic-bezier(0.34, 1.56, 0.64, 1)`;
    idleLayer.style.transform = 'translateX(0)';

    await wait(DURATION);
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
