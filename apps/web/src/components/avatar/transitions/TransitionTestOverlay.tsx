'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TransitionEngine } from './TransitionEngine';
import type { TransitionContext } from './Transition';

interface TransitionTestOverlayProps {
  engine: TransitionEngine;
  ctx: TransitionContext;
}

/**
 * Overlay UI for AVATAR_TRANSITION_TEST=true mode.
 * Shows current transition name + prev/next buttons.
 */
export function TransitionTestOverlay({ engine, ctx }: TransitionTestOverlayProps) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [cycling, setCycling] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  const playCurrentTransition = useCallback(async () => {
    if (playing) return;
    setPlaying(true);
    try {
      await engine.playTest(index, ctx);
    } finally {
      setPlaying(false);
    }
  }, [engine, index, ctx, playing]);

  const reverseCurrentTransition = useCallback(async () => {
    if (playing) return;
    setPlaying(true);
    try {
      await engine.reverse(ctx);
    } finally {
      setPlaying(false);
    }
  }, [engine, ctx, playing]);

  const handlePrev = useCallback(() => {
    if (playing) return;
    const newIndex = engine.prev();
    setIndex(newIndex);
  }, [engine, playing]);

  const handleNext = useCallback(() => {
    if (playing) return;
    const newIndex = engine.next();
    setIndex(newIndex);
  }, [engine, playing]);

  const toggleCycle = useCallback(() => {
    if (cycling && stopRef.current) {
      stopRef.current();
      stopRef.current = null;
      setCycling(false);
      return;
    }
    setCycling(true);
    const stop = engine.cycleAll(5000, ctx, (_name, i) => {
      setIndex(i);
    });
    stopRef.current = stop;
  }, [cycling, engine, ctx]);

  useEffect(() => {
    return () => {
      stopRef.current?.();
    };
  }, []);

  const name = engine.nameAt(index);

  return (
    <div
      data-testid="transition-test-overlay"
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'rgba(0, 0, 0, 0.8)',
        color: '#fff',
        padding: '8px 16px',
        borderRadius: 8,
        fontFamily: 'monospace',
        fontSize: 14,
        pointerEvents: 'auto',
      }}
    >
      <button onClick={handlePrev} disabled={playing} aria-label="Previous transition">
        &larr;
      </button>
      <span data-testid="transition-name" style={{ minWidth: 120, textAlign: 'center' }}>
        {index + 1}/{engine.count}: {name}
      </span>
      <button onClick={handleNext} disabled={playing} aria-label="Next transition">
        &rarr;
      </button>
      <button onClick={playCurrentTransition} disabled={playing} style={{ marginLeft: 8 }}>
        Play
      </button>
      <button onClick={reverseCurrentTransition} disabled={playing}>
        Reverse
      </button>
      <button onClick={toggleCycle} style={{ marginLeft: 8 }}>
        {cycling ? 'Stop' : 'Cycle'}
      </button>
    </div>
  );
}
