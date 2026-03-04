/**
 * ZoomIn — camera push to face, bust crossfades in at 70%.
 * Elegant/cinematic transition.
 */

import type { Transition, TransitionContext } from './Transition';

const DURATION = 1200;

export class ZoomIn implements Transition {
  readonly name = 'ZoomIn';

  async play(ctx: TransitionContext): Promise<void> {
    const { idleLayer, bustLayer } = ctx;

    bustLayer.style.opacity = '0';
    bustLayer.style.display = 'block';

    idleLayer.style.transition = `transform ${DURATION}ms ease-in-out, opacity ${DURATION}ms ease-in-out`;
    bustLayer.style.transition = `opacity ${DURATION * 0.3}ms ease-in ${DURATION * 0.7}ms`;

    // Zoom idle scene into face
    idleLayer.style.transform = 'scale(2.5) translateY(20%)';
    idleLayer.style.opacity = '0';
    // Crossfade bust at 70% mark
    bustLayer.style.opacity = '1';

    await wait(DURATION);
    idleLayer.style.display = 'none';
    clearTransitions(idleLayer, bustLayer);
  }

  async reverse(ctx: TransitionContext): Promise<void> {
    const { idleLayer, bustLayer } = ctx;

    idleLayer.style.display = 'block';
    idleLayer.style.transform = 'scale(2.5) translateY(20%)';
    idleLayer.style.opacity = '0';

    idleLayer.style.transition = `transform ${DURATION}ms ease-in-out, opacity ${DURATION}ms ease-in-out`;
    bustLayer.style.transition = `opacity ${DURATION * 0.3}ms ease-out`;

    // Fade bust out, zoom idle back
    bustLayer.style.opacity = '0';

    await wait(DURATION * 0.3);
    idleLayer.style.transform = 'scale(1) translateY(0)';
    idleLayer.style.opacity = '1';

    await wait(DURATION);
    bustLayer.style.display = 'none';
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
