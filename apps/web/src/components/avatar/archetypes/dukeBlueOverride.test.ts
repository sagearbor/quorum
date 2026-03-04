import { describe, it, expect } from 'vitest';
import { applyDukeBlueOverride } from './dukeBlueOverride';
import { DUKE_BLUE } from './archetypes';
import type { ArchetypeId } from './archetypes';

// Mock Three.js primitives
class MockColor {
  hex: string;
  constructor(hex: string) {
    this.hex = hex;
  }
}

class MockMaterial {
  color: MockColor;
  name: string;
  constructor(params: { color: MockColor }) {
    this.color = params.color;
    this.name = '';
  }
}

const MockTHREE = {
  Color: MockColor as unknown as new (hex: string) => unknown,
  MeshStandardMaterial: MockMaterial as unknown as new (params: { color: unknown }) => unknown,
};

function createMockScene(meshes: { name: string; materialName: string }[]) {
  const children = meshes.map((m) => ({
    isMesh: true,
    name: m.name,
    material: { name: m.materialName, color: null },
  }));

  return {
    traverse(cb: (child: unknown) => void) {
      children.forEach(cb);
    },
    children,
  };
}

describe('applyDukeBlueOverride', () => {
  it('overrides shirt materials for Duke blue archetypes', () => {
    const scene = createMockScene([
      { name: 'Body', materialName: 'Wolf3D_Outfit_Top' },
      { name: 'Legs', materialName: 'pants' },
    ]);

    const count = applyDukeBlueOverride(scene, 'faculty', MockTHREE);

    expect(count).toBe(1);
    const mat = scene.children[0].material as unknown as MockMaterial;
    expect(mat.color.hex).toBe(DUKE_BLUE);
  });

  it('overrides multiple shirt materials', () => {
    const scene = createMockScene([
      { name: 'Top', materialName: 'shirt' },
      { name: 'Torso', materialName: 'torso' },
    ]);

    const count = applyDukeBlueOverride(scene, 'researcher', MockTHREE);
    expect(count).toBe(2);
  });

  it('skips patient_participant archetype', () => {
    const scene = createMockScene([
      { name: 'Top', materialName: 'shirt' },
    ]);

    const count = applyDukeBlueOverride(scene, 'patient_participant', MockTHREE);
    expect(count).toBe(0);
  });

  it('skips non-mesh children', () => {
    const scene = {
      traverse(cb: (child: unknown) => void) {
        cb({ isMesh: false, material: { name: 'shirt' } });
        cb({ isLight: true });
      },
    };

    const count = applyDukeBlueOverride(scene, 'faculty', MockTHREE);
    expect(count).toBe(0);
  });

  it('skips meshes without material', () => {
    const scene = {
      traverse(cb: (child: unknown) => void) {
        cb({ isMesh: true, material: null });
      },
    };

    const count = applyDukeBlueOverride(scene, 'faculty', MockTHREE);
    expect(count).toBe(0);
  });

  it('handles case-insensitive material name matching', () => {
    const scene = createMockScene([
      { name: 'Body', materialName: 'SHIRT_Material' },
    ]);

    const count = applyDukeBlueOverride(scene, 'neutral', MockTHREE);
    expect(count).toBe(1);
  });

  it('works for all Duke blue archetypes', () => {
    const dukeArchetypes: ArchetypeId[] = [
      'medical_clinical', 'researcher', 'faculty', 'student_grad',
      'student_undergrad', 'administrator', 'ethics', 'engineer_tech',
      'finance_ops', 'humanities_social', 'neutral',
    ];

    for (const arch of dukeArchetypes) {
      const scene = createMockScene([{ name: 'Top', materialName: 'shirt' }]);
      expect(applyDukeBlueOverride(scene, arch, MockTHREE)).toBe(1);
    }
  });

  it('returns 0 when no shirt materials found', () => {
    const scene = createMockScene([
      { name: 'Hair', materialName: 'hair_mat' },
      { name: 'Legs', materialName: 'pants_mat' },
    ]);

    const count = applyDukeBlueOverride(scene, 'faculty', MockTHREE);
    expect(count).toBe(0);
  });
});
