/**
 * RunAndBounce — avatar sprints at camera, screen flash, bust bounces in with squash.
 */

import type { Transition, TransitionContext } from './Transition';

const SPRINT_DURATION = 600;
const FLASH_DURATION = 150;
const BOUNCE_DURATION = 500;

export class RunAndBounce implements Transition {
  readonly name = 'RunAndBounce';

  async play(ctx: TransitionContext): Promise<void> {
    const { idleLayer, bustLayer } = ctx;

    bustLayer.style.opacity = '0';
    bustLayer.style.display = 'block';

    // Avatar sprints toward camera (scale up fast)
    idleLayer.style.transition = `transform ${SPRINT_DURATION}ms ease-in, opacity ${FLASH_DURATION}ms ease-in ${SPRINT_DURATION - FLASH_DURATION}ms`;
    idleLayer.style.transform = 'scale(4)';
    idleLayer.style.opacity = '0';

    await wait(SPRINT_DURATION);
    idleLayer.style.display = 'none';

    // Screen flash via bust layer background flash
    bustLayer.style.transition = 'none';
    bustLayer.style.transform = 'scale(0.8)';
    bustLayer.style.opacity = '1';

    // Bounce in with squash/stretch
    await wait(FLASH_DURATION);
    bustLayer.style.transition = `transform ${BOUNCE_DURATION}ms cubic-bezier(0.34, 1.56, 0.64, 1)`;
    bustLayer.style.transform = 'scale(1)';

    await wait(BOUNCE_DURATION);
    clearTransitions(idleLayer, bustLayer);
  }

  async reverse(ctx: TransitionContext): Promise<void> {
    const { idleLayer, bustLayer } = ctx;

    // Bust squashes down and fades
    bustLayer.style.transition = `transform ${BOUNCE_DURATION}ms ease-in, opacity ${FLASH_DURATION}ms ease-in ${BOUNCE_DURATION - FLASH_DURATION}ms`;
    bustLayer.style.transform = 'scale(0.8)';
    bustLayer.style.opacity = '0';

    await wait(BOUNCE_DURATION);
    bustLayer.style.display = 'none';

    // Avatar zooms back from large
    idleLayer.style.display = 'block';
    idleLayer.style.transform = 'scale(4)';
    idleLayer.style.opacity = '0';
    idleLayer.style.transition = `transform ${SPRINT_DURATION}ms ease-out, opacity ${FLASH_DURATION}ms ease-out`;
    idleLayer.style.transform = 'scale(1)';
    idleLayer.style.opacity = '1';

    await wait(SPRINT_DURATION);
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
