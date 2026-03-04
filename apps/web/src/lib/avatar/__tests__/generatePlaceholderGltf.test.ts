import { describe, it, expect } from 'vitest';
import {
  generatePlaceholderGltf,
  hexToRgba,
  getAvatarGlbFilename,
  getAvatarUrl,
  getAnimationUrl,
} from '../generatePlaceholderGltf';
import { ARCHETYPE_IDS } from '../archetypeColors';

describe('hexToRgba', () => {
  it('converts Duke blue correctly', () => {
    const [r, g, b, a] = hexToRgba('#003087');
    expect(r).toBeCloseTo(0, 1);
    expect(g).toBeCloseTo(0.188, 2);
    expect(b).toBeCloseTo(0.529, 2);
    expect(a).toBe(1.0);
  });

  it('converts white', () => {
    expect(hexToRgba('#FFFFFF')).toEqual([1, 1, 1, 1.0]);
  });

  it('converts black', () => {
    expect(hexToRgba('#000000')).toEqual([0, 0, 0, 1.0]);
  });

  it('handles lowercase hex', () => {
    const [r, g, b] = hexToRgba('#ff0000');
    expect(r).toBe(1);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });
});

describe('generatePlaceholderGltf', () => {
  it('produces valid glTF 2.0 structure for each archetype', () => {
    for (const id of ARCHETYPE_IDS) {
      const gltf = generatePlaceholderGltf(id) as Record<string, unknown>;

      // Required glTF fields
      expect(gltf.asset).toEqual(
        expect.objectContaining({ version: '2.0' }),
      );
      expect(gltf.scene).toBe(0);
      expect(gltf.scenes).toBeDefined();
      expect(gltf.nodes).toBeDefined();
      expect(gltf.meshes).toBeDefined();
      expect(gltf.materials).toBeDefined();
      expect(gltf.accessors).toBeDefined();
      expect(gltf.bufferViews).toBeDefined();
      expect(gltf.buffers).toBeDefined();
    }
  });

  it('contains body and head nodes', () => {
    const gltf = generatePlaceholderGltf('neutral') as Record<string, unknown>;
    const nodes = gltf.nodes as Array<{ name: string }>;
    const names = nodes.map((n) => n.name);
    expect(names).toContain('Body');
    expect(names).toContain('Head');
    expect(names).toContain('Root');
  });

  it('has 2 materials (shirt + skin)', () => {
    const gltf = generatePlaceholderGltf('researcher') as Record<string, unknown>;
    const materials = gltf.materials as Array<{ name: string }>;
    expect(materials).toHaveLength(2);
    expect(materials[0].name).toBe('ShirtMaterial');
    expect(materials[1].name).toBe('SkinMaterial');
  });

  it('embeds buffers as base64 data URIs', () => {
    const gltf = generatePlaceholderGltf('faculty') as Record<string, unknown>;
    const buffers = gltf.buffers as Array<{ uri: string }>;
    for (const buf of buffers) {
      expect(buf.uri).toMatch(/^data:application\/octet-stream;base64,/);
    }
  });

  it('uses different shirt color for patient_participant', () => {
    const patient = generatePlaceholderGltf('patient_participant') as Record<string, unknown>;
    const neutral = generatePlaceholderGltf('neutral') as Record<string, unknown>;

    const patientMat = (patient.materials as Array<{ pbrMetallicRoughness: { baseColorFactor: number[] } }>)[0];
    const neutralMat = (neutral.materials as Array<{ pbrMetallicRoughness: { baseColorFactor: number[] } }>)[0];

    // Patient uses gray, neutral uses Duke blue — different shirt colors
    expect(patientMat.pbrMetallicRoughness.baseColorFactor).not.toEqual(
      neutralMat.pbrMetallicRoughness.baseColorFactor,
    );
  });
});

describe('getAvatarGlbFilename', () => {
  it('returns correct filename for each archetype', () => {
    expect(getAvatarGlbFilename('medical_clinical')).toBe('medical.glb');
    expect(getAvatarGlbFilename('engineer_tech')).toBe('tech.glb');
    expect(getAvatarGlbFilename('neutral')).toBe('neutral.glb');
  });
});

describe('getAvatarUrl', () => {
  it('returns /avatars/ prefixed path', () => {
    expect(getAvatarUrl('medical_clinical')).toBe('/avatars/medical.glb');
    expect(getAvatarUrl('student_undergrad')).toBe('/avatars/undergrad.glb');
  });
});

describe('getAnimationUrl', () => {
  it('returns /animations/ prefixed path with .gltf extension', () => {
    expect(getAnimationUrl('idle')).toBe('/animations/idle.gltf');
    expect(getAnimationUrl('walk')).toBe('/animations/walk.gltf');
    expect(getAnimationUrl('jog')).toBe('/animations/jog.gltf');
    expect(getAnimationUrl('sit')).toBe('/animations/sit.gltf');
  });
});
