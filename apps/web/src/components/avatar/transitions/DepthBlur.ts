/**
 * DepthBlur — scene blurs, bust fades in sharp. Elegant/abstract.
 */

import type { Transition, TransitionContext } from './Transition';

const BLUR_DURATION = 900;
const FADE_DURATION = 600;

export class DepthBlur implements Transition {
  readonly name = 'DepthBlur';

  async play(ctx: TransitionContext): Promise<void> {
    const { idleLayer, bustLayer } = ctx;

    bustLayer.style.opacity = '0';
    bustLayer.style.display = 'block';

    // Blur idle scene + fade out
    idleLayer.style.transition = `filter ${BLUR_DURATION}ms ease-in-out, opacity ${FADE_DURATION}ms ease-in ${BLUR_DURATION * 0.5}ms`;
    idleLayer.style.filter = 'blur(20px)';
    idleLayer.style.opacity = '0';

    // Bust fades in sharp, slightly delayed
    bustLayer.style.transition = `opacity ${FADE_DURATION}ms ease-in-out ${BLUR_DURATION * 0.4}ms`;
    bustLayer.style.opacity = '1';

    await wait(BLUR_DURATION + FADE_DURATION * 0.5);
    idleLayer.style.display = 'none';
    clearAll(idleLayer, bustLayer);
  }

  async reverse(ctx: TransitionContext): Promise<void> {
    const { idleLayer, bustLayer } = ctx;

    // Bust fades out
    bustLayer.style.transition = `opacity ${FADE_DURATION}ms ease-out`;
    bustLayer.style.opacity = '0';

    await wait(FADE_DURATION * 0.5);

    // Idle unblurs back in
    idleLayer.style.display = 'block';
    idleLayer.style.filter = 'blur(20px)';
    idleLayer.style.opacity = '0';
    idleLayer.style.transition = `filter ${BLUR_DURATION}ms ease-in-out, opacity ${FADE_DURATION}ms ease-out`;
    idleLayer.style.filter = 'blur(0px)';
    idleLayer.style.opacity = '1';

    await wait(BLUR_DURATION);
    bustLayer.style.display = 'none';
    clearAll(idleLayer, bustLayer);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearAll(...els: HTMLElement[]): void {
  for (const el of els) {
    el.style.transition = '';
    el.style.filter = '';
  }
}
