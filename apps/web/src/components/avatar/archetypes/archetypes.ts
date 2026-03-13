/**
 * Archetype definitions and personality profiles for avatar system.
 * 12 university-wide archetypes covering Duke Tech Expo audience.
 */

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

export type GlbProvider = 'avaturn' | 'makehuman' | 'placeholder';

export interface GlbSource {
  provider: GlbProvider;
  path: string;
}

export interface PersonalityProfile {
  walkSpeed: number;
  gestureFreq: number;
  fidget: number;
  headSway: number;
  elStability: number;
  elStyle: number;
  elRate: number;
}

export interface ArchetypeDefinition {
  id: ArchetypeId;
  /** Default/placeholder GLB filename (legacy field, kept for backward compatibility). */
  glb: string;
  /** Ordered list of GLB sources. resolveGlbUrl() walks this list when selecting a URL. */
  glbSources: GlbSource[];
  shirt: 'duke_blue' | 'duke_tshirt' | 'neutral';
  covers: string[];
  personality: PersonalityProfile;
}

export const DUKE_BLUE = '#003087';

export const ARCHETYPES: Record<ArchetypeId, ArchetypeDefinition> = {
  medical_clinical: {
    id: 'medical_clinical',
    glb: 'medical.glb',
    glbSources: [
      { provider: 'avaturn', path: '/avatars/avaturn/medical_clinical.glb' },
      { provider: 'makehuman', path: '/avatars/makehuman/medical_clinical.glb' },
      { provider: 'placeholder', path: '/avatars/medical.glb' },
    ],
    shirt: 'duke_blue',
    covers: ['Physician', 'Doctor', 'Surgeon', 'Nurse', 'Clinician', 'PA', 'NP'],
    personality: { walkSpeed: 0.8, gestureFreq: 0.4, fidget: 0.2, headSway: 3, elStability: 0.85, elStyle: 0.2, elRate: 0.9 },
  },
  researcher: {
    id: 'researcher',
    glb: 'researcher.glb',
    glbSources: [
      { provider: 'avaturn', path: '/avatars/avaturn/researcher.glb' },
      { provider: 'makehuman', path: '/avatars/makehuman/researcher.glb' },
      { provider: 'placeholder', path: '/avatars/researcher.glb' },
    ],
    shirt: 'duke_blue',
    covers: ['Scientist', 'PI', 'Postdoc', 'Biologist', 'Chemist', 'Lab Director'],
    personality: { walkSpeed: 1.1, gestureFreq: 0.7, fidget: 0.5, headSway: 6, elStability: 0.65, elStyle: 0.6, elRate: 1.1 },
  },
  faculty: {
    id: 'faculty',
    glb: 'faculty.glb',
    glbSources: [
      { provider: 'avaturn', path: '/avatars/avaturn/faculty.glb' },
      { provider: 'makehuman', path: '/avatars/makehuman/faculty.glb' },
      { provider: 'placeholder', path: '/avatars/faculty.glb' },
    ],
    shirt: 'duke_blue',
    covers: ['Professor', 'Instructor', 'Lecturer', 'Dr.', 'Faculty'],
    personality: { walkSpeed: 0.9, gestureFreq: 0.5, fidget: 0.3, headSway: 4, elStability: 0.80, elStyle: 0.3, elRate: 0.95 },
  },
  student_grad: {
    id: 'student_grad',
    glb: 'grad_student.glb',
    glbSources: [
      { provider: 'avaturn', path: '/avatars/avaturn/student_grad.glb' },
      { provider: 'makehuman', path: '/avatars/makehuman/student_grad.glb' },
      { provider: 'placeholder', path: '/avatars/grad_student.glb' },
    ],
    shirt: 'duke_blue',
    covers: ['PhD', 'Grad Student', 'Masters', 'Resident', 'Fellow'],
    personality: { walkSpeed: 1.0, gestureFreq: 0.6, fidget: 0.5, headSway: 5, elStability: 0.70, elStyle: 0.5, elRate: 1.05 },
  },
  student_undergrad: {
    id: 'student_undergrad',
    glb: 'undergrad.glb',
    glbSources: [
      { provider: 'avaturn', path: '/avatars/avaturn/student_undergrad.glb' },
      { provider: 'makehuman', path: '/avatars/makehuman/student_undergrad.glb' },
      { provider: 'placeholder', path: '/avatars/undergrad.glb' },
    ],
    shirt: 'duke_tshirt',
    covers: ['Undergrad', 'Freshman', 'Sophomore', 'Junior', 'Senior', 'Student'],
    personality: { walkSpeed: 1.2, gestureFreq: 0.8, fidget: 0.7, headSway: 7, elStability: 0.60, elStyle: 0.7, elRate: 1.15 },
  },
  administrator: {
    id: 'administrator',
    glb: 'administrator.glb',
    glbSources: [
      { provider: 'avaturn', path: '/avatars/avaturn/administrator.glb' },
      { provider: 'makehuman', path: '/avatars/makehuman/administrator.glb' },
      { provider: 'placeholder', path: '/avatars/administrator.glb' },
    ],
    shirt: 'duke_blue',
    covers: ['Dean', 'Provost', 'Chair', 'Director', 'VP', 'Chancellor', 'President'],
    personality: { walkSpeed: 0.7, gestureFreq: 0.3, fidget: 0.1, headSway: 2, elStability: 0.90, elStyle: 0.15, elRate: 0.85 },
  },
  ethics: {
    id: 'ethics',
    glb: 'ethics.glb',
    glbSources: [
      { provider: 'avaturn', path: '/avatars/avaturn/ethics.glb' },
      { provider: 'makehuman', path: '/avatars/makehuman/ethics.glb' },
      { provider: 'placeholder', path: '/avatars/ethics.glb' },
    ],
    shirt: 'duke_blue',
    covers: ['Ethicist', 'IRB', 'Compliance', 'Bioethicist', 'Policy', 'Regulatory'],
    personality: { walkSpeed: 0.8, gestureFreq: 0.4, fidget: 0.2, headSway: 3, elStability: 0.82, elStyle: 0.25, elRate: 0.90 },
  },
  engineer_tech: {
    id: 'engineer_tech',
    glb: 'tech.glb',
    glbSources: [
      { provider: 'avaturn', path: '/avatars/avaturn/engineer_tech.glb' },
      { provider: 'makehuman', path: '/avatars/makehuman/engineer_tech.glb' },
      { provider: 'placeholder', path: '/avatars/tech.glb' },
    ],
    shirt: 'duke_blue',
    covers: ['Engineer', 'Developer', 'Data Scientist', 'Analyst', 'IT'],
    personality: { walkSpeed: 1.0, gestureFreq: 0.6, fidget: 0.4, headSway: 4, elStability: 0.72, elStyle: 0.5, elRate: 1.05 },
  },
  finance_ops: {
    id: 'finance_ops',
    glb: 'finance.glb',
    glbSources: [
      { provider: 'avaturn', path: '/avatars/avaturn/finance_ops.glb' },
      { provider: 'makehuman', path: '/avatars/makehuman/finance_ops.glb' },
      { provider: 'placeholder', path: '/avatars/finance.glb' },
    ],
    shirt: 'duke_blue',
    covers: ['Finance', 'CFO', 'Operations', 'HR', 'Budget', 'Accounting'],
    personality: { walkSpeed: 0.75, gestureFreq: 0.35, fidget: 0.2, headSway: 3, elStability: 0.85, elStyle: 0.2, elRate: 0.88 },
  },
  patient_participant: {
    id: 'patient_participant',
    glb: 'patient.glb',
    glbSources: [
      { provider: 'avaturn', path: '/avatars/avaturn/patient_participant.glb' },
      { provider: 'makehuman', path: '/avatars/makehuman/patient_participant.glb' },
      { provider: 'placeholder', path: '/avatars/patient.glb' },
    ],
    shirt: 'neutral',
    covers: ['Patient', 'Participant', 'Subject', 'Volunteer', 'Community Member'],
    personality: { walkSpeed: 0.9, gestureFreq: 0.5, fidget: 0.6, headSway: 5, elStability: 0.70, elStyle: 0.4, elRate: 1.0 },
  },
  humanities_social: {
    id: 'humanities_social',
    glb: 'humanities.glb',
    glbSources: [
      { provider: 'avaturn', path: '/avatars/avaturn/humanities_social.glb' },
      { provider: 'makehuman', path: '/avatars/makehuman/humanities_social.glb' },
      { provider: 'placeholder', path: '/avatars/humanities.glb' },
    ],
    shirt: 'duke_blue',
    covers: ['Historian', 'Philosopher', 'Sociologist', 'Anthropologist', 'Ethicist'],
    personality: { walkSpeed: 0.9, gestureFreq: 0.6, fidget: 0.4, headSway: 5, elStability: 0.68, elStyle: 0.55, elRate: 1.0 },
  },
  neutral: {
    id: 'neutral',
    glb: 'neutral.glb',
    glbSources: [
      { provider: 'avaturn', path: '/avatars/avaturn/neutral.glb' },
      { provider: 'makehuman', path: '/avatars/makehuman/neutral.glb' },
      { provider: 'placeholder', path: '/avatars/neutral.glb' },
    ],
    shirt: 'duke_blue',
    covers: ['Moderator', 'Facilitator', 'Observer'],
    personality: { walkSpeed: 0.9, gestureFreq: 0.5, fidget: 0.3, headSway: 4, elStability: 0.75, elStyle: 0.35, elRate: 1.0 },
  },
};

export function isDukeBlueArchetype(id: ArchetypeId): boolean {
  return ARCHETYPES[id].shirt !== 'neutral';
}

/**
 * Resolve the GLB URL for an archetype, with optional provider preference.
 *
 * Walk order:
 *   1. If preferredProvider is given, try to find a matching source first.
 *   2. Walk glbSources in declaration order (avaturn → makehuman → placeholder).
 *   3. The placeholder entry is always last and is always present, so this
 *      function always returns a non-empty string.
 */
export function resolveGlbUrl(
  archetype: ArchetypeDefinition,
  preferredProvider?: GlbProvider,
): string {
  if (preferredProvider) {
    const preferred = archetype.glbSources.find(
      (s) => s.provider === preferredProvider,
    );
    if (preferred) {
      return preferred.path;
    }
  }

  // Fall through sources in declaration order; placeholder is guaranteed last.
  const fallback = archetype.glbSources.find((s) => s.provider !== 'placeholder')
    ?? archetype.glbSources.find((s) => s.provider === 'placeholder');

  // Defensive: if glbSources is somehow empty, fall back to legacy glb field.
  return fallback?.path ?? `/avatars/${archetype.glb}`;
}
