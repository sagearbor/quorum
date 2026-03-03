/**
 * Archetype shirt colors for procedural placeholder avatars.
 * Duke blue (#003087) for all non-patient archetypes per PRD.
 */

export const ARCHETYPE_IDS = [
  'medical_clinical',
  'researcher',
  'faculty',
  'student_grad',
  'student_undergrad',
  'administrator',
  'ethics',
  'engineer_tech',
  'finance_ops',
  'patient_participant',
  'humanities_social',
  'neutral',
] as const;

export type ArchetypeId = (typeof ARCHETYPE_IDS)[number];

const DUKE_BLUE = '#003087';
const NEUTRAL_GRAY = '#6B7280';
const DUKE_TSHIRT = '#1E4D8C'; // lighter Duke blue for t-shirt look

export interface ArchetypeColor {
  shirt: string;
  /** Skin tone placeholder — neutral warm tone */
  skin: string;
  /** Head/hair tint for visual differentiation */
  accent: string;
}

/**
 * Per-archetype color map. All non-patient archetypes use Duke blue shirt.
 * Accent colors provide visual differentiation between archetypes.
 */
export const ARCHETYPE_COLORS: Record<ArchetypeId, ArchetypeColor> = {
  medical_clinical:    { shirt: DUKE_BLUE,    skin: '#D4A574', accent: '#FFFFFF' },
  researcher:          { shirt: DUKE_BLUE,    skin: '#D4A574', accent: '#8B5E3C' },
  faculty:             { shirt: DUKE_BLUE,    skin: '#D4A574', accent: '#4A4A4A' },
  student_grad:        { shirt: DUKE_BLUE,    skin: '#D4A574', accent: '#2D1B0E' },
  student_undergrad:   { shirt: DUKE_TSHIRT,  skin: '#D4A574', accent: '#FFD700' },
  administrator:       { shirt: DUKE_BLUE,    skin: '#D4A574', accent: '#C0C0C0' },
  ethics:              { shirt: DUKE_BLUE,    skin: '#D4A574', accent: '#704214' },
  engineer_tech:       { shirt: DUKE_BLUE,    skin: '#D4A574', accent: '#333333' },
  finance_ops:         { shirt: DUKE_BLUE,    skin: '#D4A574', accent: '#1A1A1A' },
  patient_participant: { shirt: NEUTRAL_GRAY, skin: '#D4A574', accent: '#8B7355' },
  humanities_social:   { shirt: DUKE_BLUE,    skin: '#D4A574', accent: '#5C3317' },
  neutral:             { shirt: DUKE_BLUE,    skin: '#D4A574', accent: '#6B6B6B' },
};

/** GLB filename for an archetype (matches PRD table). */
export const ARCHETYPE_GLB_FILENAMES: Record<ArchetypeId, string> = {
  medical_clinical:    'medical.glb',
  researcher:          'researcher.glb',
  faculty:             'faculty.glb',
  student_grad:        'grad_student.glb',
  student_undergrad:   'undergrad.glb',
  administrator:       'administrator.glb',
  ethics:              'ethics.glb',
  engineer_tech:       'tech.glb',
  finance_ops:         'finance.glb',
  patient_participant: 'patient.glb',
  humanities_social:   'humanities.glb',
  neutral:             'neutral.glb',
};
