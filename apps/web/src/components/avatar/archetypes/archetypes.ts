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
  glb: string;
  shirt: 'duke_blue' | 'duke_tshirt' | 'neutral';
  covers: string[];
  personality: PersonalityProfile;
}

export const DUKE_BLUE = '#003087';

export const ARCHETYPES: Record<ArchetypeId, ArchetypeDefinition> = {
  medical_clinical: {
    id: 'medical_clinical',
    glb: 'medical.glb',
    shirt: 'duke_blue',
    covers: ['Physician', 'Doctor', 'Surgeon', 'Nurse', 'Clinician', 'PA', 'NP'],
    personality: { walkSpeed: 0.8, gestureFreq: 0.4, fidget: 0.2, headSway: 3, elStability: 0.85, elStyle: 0.2, elRate: 0.9 },
  },
  researcher: {
    id: 'researcher',
    glb: 'researcher.glb',
    shirt: 'duke_blue',
    covers: ['Scientist', 'PI', 'Postdoc', 'Biologist', 'Chemist', 'Lab Director'],
    personality: { walkSpeed: 1.1, gestureFreq: 0.7, fidget: 0.5, headSway: 6, elStability: 0.65, elStyle: 0.6, elRate: 1.1 },
  },
  faculty: {
    id: 'faculty',
    glb: 'faculty.glb',
    shirt: 'duke_blue',
    covers: ['Professor', 'Instructor', 'Lecturer', 'Dr.', 'Faculty'],
    personality: { walkSpeed: 0.9, gestureFreq: 0.5, fidget: 0.3, headSway: 4, elStability: 0.80, elStyle: 0.3, elRate: 0.95 },
  },
  student_grad: {
    id: 'student_grad',
    glb: 'grad_student.glb',
    shirt: 'duke_blue',
    covers: ['PhD', 'Grad Student', 'Masters', 'Resident', 'Fellow'],
    personality: { walkSpeed: 1.0, gestureFreq: 0.6, fidget: 0.5, headSway: 5, elStability: 0.70, elStyle: 0.5, elRate: 1.05 },
  },
  student_undergrad: {
    id: 'student_undergrad',
    glb: 'undergrad.glb',
    shirt: 'duke_tshirt',
    covers: ['Undergrad', 'Freshman', 'Sophomore', 'Junior', 'Senior', 'Student'],
    personality: { walkSpeed: 1.2, gestureFreq: 0.8, fidget: 0.7, headSway: 7, elStability: 0.60, elStyle: 0.7, elRate: 1.15 },
  },
  administrator: {
    id: 'administrator',
    glb: 'administrator.glb',
    shirt: 'duke_blue',
    covers: ['Dean', 'Provost', 'Chair', 'Director', 'VP', 'Chancellor', 'President'],
    personality: { walkSpeed: 0.7, gestureFreq: 0.3, fidget: 0.1, headSway: 2, elStability: 0.90, elStyle: 0.15, elRate: 0.85 },
  },
  ethics: {
    id: 'ethics',
    glb: 'ethics.glb',
    shirt: 'duke_blue',
    covers: ['Ethicist', 'IRB', 'Compliance', 'Bioethicist', 'Policy', 'Regulatory'],
    personality: { walkSpeed: 0.8, gestureFreq: 0.4, fidget: 0.2, headSway: 3, elStability: 0.82, elStyle: 0.25, elRate: 0.90 },
  },
  engineer_tech: {
    id: 'engineer_tech',
    glb: 'tech.glb',
    shirt: 'duke_blue',
    covers: ['Engineer', 'Developer', 'Data Scientist', 'Analyst', 'IT'],
    personality: { walkSpeed: 1.0, gestureFreq: 0.6, fidget: 0.4, headSway: 4, elStability: 0.72, elStyle: 0.5, elRate: 1.05 },
  },
  finance_ops: {
    id: 'finance_ops',
    glb: 'finance.glb',
    shirt: 'duke_blue',
    covers: ['Finance', 'CFO', 'Operations', 'HR', 'Budget', 'Accounting'],
    personality: { walkSpeed: 0.75, gestureFreq: 0.35, fidget: 0.2, headSway: 3, elStability: 0.85, elStyle: 0.2, elRate: 0.88 },
  },
  patient_participant: {
    id: 'patient_participant',
    glb: 'patient.glb',
    shirt: 'neutral',
    covers: ['Patient', 'Participant', 'Subject', 'Volunteer', 'Community Member'],
    personality: { walkSpeed: 0.9, gestureFreq: 0.5, fidget: 0.6, headSway: 5, elStability: 0.70, elStyle: 0.4, elRate: 1.0 },
  },
  humanities_social: {
    id: 'humanities_social',
    glb: 'humanities.glb',
    shirt: 'duke_blue',
    covers: ['Historian', 'Philosopher', 'Sociologist', 'Anthropologist', 'Ethicist'],
    personality: { walkSpeed: 0.9, gestureFreq: 0.6, fidget: 0.4, headSway: 5, elStability: 0.68, elStyle: 0.55, elRate: 1.0 },
  },
  neutral: {
    id: 'neutral',
    glb: 'neutral.glb',
    shirt: 'duke_blue',
    covers: ['Moderator', 'Facilitator', 'Observer'],
    personality: { walkSpeed: 0.9, gestureFreq: 0.5, fidget: 0.3, headSway: 4, elStability: 0.75, elStyle: 0.35, elRate: 1.0 },
  },
};

export function isDukeBlueArchetype(id: ArchetypeId): boolean {
  return ARCHETYPES[id].shirt !== 'neutral';
}
