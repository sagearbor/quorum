import { describe, it, expect } from 'vitest';
import { resolveArchetype } from './resolveArchetype';

describe('resolveArchetype', () => {
  describe('medical_clinical', () => {
    it.each([
      'Physician', 'Doctor', 'Surgeon', 'Nurse', 'Clinician',
      'Clinical Researcher', 'PA', 'NP', 'Medical Director',
    ])('resolves "%s" to medical_clinical', (role) => {
      expect(resolveArchetype(role)).toBe('medical_clinical');
    });
  });

  describe('researcher', () => {
    it.each([
      'Scientist', 'Researcher', 'PI', 'Postdoc', 'Biologist',
      'Chemist', 'Lab Director', 'Senior Researcher',
    ])('resolves "%s" to researcher', (role) => {
      expect(resolveArchetype(role)).toBe('researcher');
    });
  });

  describe('faculty', () => {
    it.each([
      'Professor', 'Instructor', 'Lecturer', 'Faculty',
      'Associate Professor', 'Adjunct Instructor',
    ])('resolves "%s" to faculty', (role) => {
      expect(resolveArchetype(role)).toBe('faculty');
    });
  });

  describe('student_grad', () => {
    it.each([
      'PhD', 'Grad Student', 'Masters', 'Resident', 'Fellow',
      'Doctoral Candidate', 'PhD Student',
    ])('resolves "%s" to student_grad', (role) => {
      expect(resolveArchetype(role)).toBe('student_grad');
    });
  });

  describe('student_undergrad', () => {
    it.each([
      'Undergrad', 'Freshman', 'Sophomore', 'Junior', 'Senior',
      'Student', 'Undergraduate Student',
    ])('resolves "%s" to student_undergrad', (role) => {
      expect(resolveArchetype(role)).toBe('student_undergrad');
    });
  });

  describe('administrator', () => {
    it.each([
      'Dean', 'Provost', 'Chair', 'Director', 'VP', 'Chancellor',
      'President', 'Administrator', 'Associate Dean',
    ])('resolves "%s" to administrator', (role) => {
      expect(resolveArchetype(role)).toBe('administrator');
    });
  });

  describe('ethics', () => {
    it.each([
      'Ethicist', 'IRB', 'Compliance', 'Bioethics', 'Policy',
      'Regulatory', 'IRB Chair', 'Compliance Officer',
    ])('resolves "%s" to ethics', (role) => {
      expect(resolveArchetype(role)).toBe('ethics');
    });
  });

  describe('engineer_tech', () => {
    it.each([
      'Engineer', 'Developer', 'Data Scientist', 'Analyst', 'IT',
      'Software Engineer', 'Tech Lead',
    ])('resolves "%s" to engineer_tech', (role) => {
      expect(resolveArchetype(role)).toBe('engineer_tech');
    });
  });

  describe('finance_ops', () => {
    it.each([
      'Finance', 'CFO', 'Operations', 'HR', 'Budget', 'Accounting',
      'Finance Director', 'HR Manager',
    ])('resolves "%s" to finance_ops', (role) => {
      expect(resolveArchetype(role)).toBe('finance_ops');
    });
  });

  describe('patient_participant', () => {
    it.each([
      'Patient', 'Participant', 'Subject', 'Volunteer', 'Community Member',
      'Patient Advocate', 'Research Participant',
    ])('resolves "%s" to patient_participant', (role) => {
      expect(resolveArchetype(role)).toBe('patient_participant');
    });
  });

  describe('humanities_social', () => {
    it.each([
      'Historian', 'Philosopher', 'Sociologist', 'Anthropologist',
      'Humanities Scholar', 'Social Historian',
    ])('resolves "%s" to humanities_social', (role) => {
      expect(resolveArchetype(role)).toBe('humanities_social');
    });
  });

  describe('neutral (fallback)', () => {
    it.each([
      'Moderator', 'Facilitator', 'Observer',
    ])('resolves "%s" to neutral', (role) => {
      expect(resolveArchetype(role)).toBe('neutral');
    });
  });

  describe('edge cases', () => {
    it('returns neutral for empty string', () => {
      expect(resolveArchetype('')).toBe('neutral');
    });

    it('returns neutral for whitespace-only string', () => {
      expect(resolveArchetype('   ')).toBe('neutral');
    });

    it('returns neutral for numbers-only', () => {
      expect(resolveArchetype('12345')).toBe('neutral');
    });

    it('returns neutral for foreign characters without keywords', () => {
      expect(resolveArchetype('\u5B66\u751F')).toBe('neutral');
    });

    it('returns neutral for special characters', () => {
      expect(resolveArchetype('!@#$%')).toBe('neutral');
    });

    it('handles mixed case correctly', () => {
      expect(resolveArchetype('PHYSICIAN')).toBe('medical_clinical');
      expect(resolveArchetype('phYsIcIaN')).toBe('medical_clinical');
    });

    it('handles leading/trailing whitespace', () => {
      expect(resolveArchetype('  Doctor  ')).toBe('medical_clinical');
    });

    it('handles unknown role names', () => {
      expect(resolveArchetype('Astronaut')).toBe('neutral');
      expect(resolveArchetype('Zookeeper')).toBe('neutral');
    });
  });
});
