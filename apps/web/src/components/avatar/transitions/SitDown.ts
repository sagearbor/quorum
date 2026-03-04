/**
 * SitDown — avatar plays sit animation, camera lowers, bust crossfades.
 * Most humanizing transition.
 */

import type { Transition, TransitionContext } from './Transition';

const SIT_DURATION = 1400;

export class SitDown implements Transition {
  readonly name = 'SitDown';

  async play(ctx: TransitionContext): Promise<void> {
    const { idleLayer, bustLayer } = ctx;

    bustLayer.style.opacity = '0';
    bustLayer.style.display = 'block';

    // Camera lowers + slight zoom as avatar sits
    idleLayer.style.transition = `transform ${SIT_DURATION}ms ease-in-out, opacity ${SIT_DURATION * 0.3}ms ease-in ${SIT_DURATION * 0.7}ms`;
    idleLayer.style.transform = 'scale(1.3) translateY(-10%)';
    idleLayer.style.opacity = '0';

    // Bust dissolves in during second half
    bustLayer.style.transition = `opacity ${SIT_DURATION * 0.4}ms ease-in-out ${SIT_DURATION * 0.6}ms`;
    bustLayer.style.opacity = '1';

    await wait(SIT_DURATION);
    idleLayer.style.display = 'none';
    clearTransitions(idleLayer, bustLayer);
  }

  async reverse(ctx: TransitionContext): Promise<void> {
    const { idleLayer, bustLayer } = ctx;

    // Bust fades out
    bustLayer.style.transition = `opacity ${SIT_DURATION * 0.3}ms ease-out`;
    bustLayer.style.opacity = '0';

    await wait(SIT_DURATION * 0.3);
    bustLayer.style.display = 'none';

    // Avatar stands back up
    idleLayer.style.display = 'block';
    idleLayer.style.transform = 'scale(1.3) translateY(-10%)';
    idleLayer.style.opacity = '0';
    idleLayer.style.transition = `transform ${SIT_DURATION}ms ease-in-out, opacity ${SIT_DURATION * 0.3}ms ease-out`;
    idleLayer.style.transform = 'scale(1) translateY(0)';
    idleLayer.style.opacity = '1';

    await wait(SIT_DURATION);
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
