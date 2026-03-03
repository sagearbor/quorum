/**
 * Transition interface and shared types for RPM full-body → EL bust transitions.
 *
 * Each transition bridges two DOM layers:
 *  - idleLayer: the Three.js canvas (RPM full-body scene)
 *  - bustLayer: the ElevenLabs conversational bust overlay
 */

export interface TransitionContext {
  /** The Three.js canvas / RPM idle scene container */
  idleLayer: HTMLElement;
  /** The ElevenLabs bust overlay container */
  bustLayer: HTMLElement;
}

export interface Transition {
  /** Unique name for display in test harness */
  readonly name: string;
  /** Play the idle → engaged transition. Resolves when complete. */
  play(ctx: TransitionContext): Promise<void>;
  /** Reverse the transition (engaged → idle). Resolves when complete. */
  reverse(ctx: TransitionContext): Promise<void>;
}

/** All archetype IDs from the PRD */
export type ArchetypeId =
  | 'medical_clinical'
  | 'researcher'
  | 'faculty'
  | 'student_grad'
  | 'student_undergrad'
  | 'administrator'
  | 'ethics'
  | 'engineer_tech'
  | 'finance_ops'
  | 'patient_participant'
  | 'humanities_social'
  | 'neutral';

/** Index into the transitions array, used for weighted selection */
export type TransitionWeights = Record<ArchetypeId, number[]>;
