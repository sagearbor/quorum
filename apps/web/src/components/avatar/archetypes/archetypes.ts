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
// Only these high-quality .glb avatars are actually shipped under /avatars/avaturn/.
// Other archetypes fall through to the .gltf placeholders to avoid 404 spam.
const AVAILABLE_AVATURN: ReadonlySet<string> = new Set([
  '/avatars/avaturn/humanities_social.glb',
  '/avatars/avaturn/neutral.glb',
  '/avatars/avaturn/female_assistant.glb',
  '/avatars/avaturn/female_business.glb',
]);

// When an archetype's own avaturn file isn't shipped, fall back to one of the
// available faces. Curated (not hashed) so the assignment is predictable and
// the 4 available avatars are distributed evenly across the 10 archetypes
// that don't have their own avaturn-specific file. Each face appears for
// 2-3 archetypes so all 4 are visible in a multi-role quorum.
const AVATURN_FALLBACK_BY_ARCHETYPE: Partial<Record<ArchetypeId, string>> = {
  // female_assistant.glb — Taf (caring/generic feminine roles)
  medical_clinical:    '/avatars/avaturn/female_assistant.glb',
  patient_participant: '/avatars/avaturn/female_assistant.glb',
  student_undergrad:   '/avatars/avaturn/female_assistant.glb',

  // female_business.glb — Stephanie (IT colleague; tech / business roles)
  engineer_tech:       '/avatars/avaturn/female_business.glb',
  finance_ops:         '/avatars/avaturn/female_business.glb',
  administrator:       '/avatars/avaturn/female_business.glb',

  // neutral.glb — Sage (research / generic)
  researcher:          '/avatars/avaturn/neutral.glb',
  student_grad:        '/avatars/avaturn/neutral.glb',

  // humanities_social.glb — Sage (academic / formal)
  faculty:             '/avatars/avaturn/humanities_social.glb',
  ethics:              '/avatars/avaturn/humanities_social.glb',
};

export function resolveGlbUrl(
  archetype: ArchetypeDefinition,
  preferredProvider?: GlbProvider,
): string {
  const sourceExists = (s: { provider: GlbProvider; path: string }) => {
    if (s.provider === 'avaturn') return AVAILABLE_AVATURN.has(s.path);
    // MakeHuman dir is empty; placeholder files are .gltf, not .glb, so swap.
    if (s.provider === 'makehuman') return false;
    return true;
  };

  if (preferredProvider) {
    const preferred = archetype.glbSources.find(
      (s) => s.provider === preferredProvider && sourceExists(s),
    );
    if (preferred) return toPlaceholderGltf(preferred.path);
  }

  // Walk sources in declaration order, skipping ones we know don't ship.
  const chosen =
    archetype.glbSources.find((s) => s.provider !== 'placeholder' && sourceExists(s));
  if (chosen) return toPlaceholderGltf(chosen.path);

  // No archetype-specific avaturn ship exists — fall back to the curated
  // avaturn assignment before dropping to the .gltf placeholder. Keeps the
  // photoreal look for every role; reuses one of the 3 available faces.
  const fallback = AVATURN_FALLBACK_BY_ARCHETYPE[archetype.id];
  if (fallback) return fallback;

  const placeholder = archetype.glbSources.find((s) => s.provider === 'placeholder');
  if (!placeholder) return `/avatars/${archetype.glb}`;
  return toPlaceholderGltf(placeholder.path);
}

// Placeholder files are generated as .gltf, but archetypes.ts lists them as .glb.
// Map placeholder paths to their actual on-disk extension.
function toPlaceholderGltf(path: string): string {
  if (path.startsWith('/avatars/') && !path.includes('/avaturn/') && !path.includes('/makehuman/')) {
    return path.replace(/\.glb$/, '.gltf');
  }
  return path;
}
