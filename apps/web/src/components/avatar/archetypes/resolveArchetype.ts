/**
 * Resolves a role name string to an ArchetypeId via keyword matching.
 * Edge cases (empty, numbers-only, foreign characters) fall through to 'neutral'.
 */

import type { ArchetypeId } from './archetypes';

export function resolveArchetype(roleName: string): ArchetypeId {
  const r = roleName.toLowerCase().trim();

  if (!r) return 'neutral';

  if (/physician|\bdoctor\b|surgeon|nurse|clinician|clinical|\bpa\b|\bnp\b|medical/.test(r)) return 'medical_clinical';
  if (/engineer|developer|data scientist|analyst|\bit\b|software|tech/.test(r)) return 'engineer_tech';
  if (/scientist|researcher|\bpi\b|postdoc|biolog|chemist|lab director/.test(r)) return 'researcher';
  if (/professor|instructor|lecturer|faculty/.test(r)) return 'faculty';
  if (/phd|grad student|masters|\bresident\b|fellow|doctoral/.test(r)) return 'student_grad';
  if (/undergrad|freshman|sophomore|junior|senior|\bstudent\b/.test(r)) return 'student_undergrad';
  if (/ethicist|irb|compliance|bioethics|policy|regulatory/.test(r)) return 'ethics';
  if (/finance|cfo|operations|\bhr\b|budget|accounting/.test(r)) return 'finance_ops';
  if (/dean|provost|chair|director|chancellor|president|\bvp\b|administrator/.test(r)) return 'administrator';
  if (/patient|participant|subject|volunteer|community/.test(r)) return 'patient_participant';
  if (/histor|philosoph|sociolog|anthropolog|humanit/.test(r)) return 'humanities_social';

  return 'neutral';
}
