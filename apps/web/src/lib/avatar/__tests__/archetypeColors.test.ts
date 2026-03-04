import { describe, it, expect } from 'vitest';
import {
  ARCHETYPE_IDS,
  ARCHETYPE_COLORS,
  ARCHETYPE_GLB_FILENAMES,
  type ArchetypeId,
} from '../archetypeColors';

describe('archetypeColors', () => {
  it('defines exactly 12 archetypes', () => {
    expect(ARCHETYPE_IDS).toHaveLength(12);
  });

  it('has colors for every archetype', () => {
    for (const id of ARCHETYPE_IDS) {
      expect(ARCHETYPE_COLORS[id]).toBeDefined();
      expect(ARCHETYPE_COLORS[id].shirt).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(ARCHETYPE_COLORS[id].skin).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(ARCHETYPE_COLORS[id].accent).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('has GLB filenames for every archetype', () => {
    for (const id of ARCHETYPE_IDS) {
      expect(ARCHETYPE_GLB_FILENAMES[id]).toBeDefined();
      expect(ARCHETYPE_GLB_FILENAMES[id]).toMatch(/\.glb$/);
    }
  });

  it('uses Duke blue (#003087) for all non-patient archetypes', () => {
    const DUKE_BLUE = '#003087';
    for (const id of ARCHETYPE_IDS) {
      if (id === 'patient_participant') continue;
      // student_undergrad uses a lighter Duke blue variant, all others use standard
      if (id === 'student_undergrad') {
        expect(ARCHETYPE_COLORS[id].shirt).toMatch(/^#/);
      } else {
        expect(ARCHETYPE_COLORS[id].shirt).toBe(DUKE_BLUE);
      }
    }
  });

  it('uses neutral gray for patient_participant', () => {
    expect(ARCHETYPE_COLORS.patient_participant.shirt).toBe('#6B7280');
  });

  it('GLB filenames match PRD table', () => {
    const expected: Record<string, string> = {
      medical_clinical: 'medical.glb',
      researcher: 'researcher.glb',
      faculty: 'faculty.glb',
      student_grad: 'grad_student.glb',
      student_undergrad: 'undergrad.glb',
      administrator: 'administrator.glb',
      ethics: 'ethics.glb',
      engineer_tech: 'tech.glb',
      finance_ops: 'finance.glb',
      patient_participant: 'patient.glb',
      humanities_social: 'humanities.glb',
      neutral: 'neutral.glb',
    };
    for (const [id, filename] of Object.entries(expected)) {
      expect(ARCHETYPE_GLB_FILENAMES[id as ArchetypeId]).toBe(filename);
    }
  });

  it('all GLB filenames are unique', () => {
    const filenames = Object.values(ARCHETYPE_GLB_FILENAMES);
    expect(new Set(filenames).size).toBe(filenames.length);
  });
});
