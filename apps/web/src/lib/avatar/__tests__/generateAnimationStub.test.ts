import { describe, it, expect } from 'vitest';
import {
  generateAnimationStub,
  ANIMATION_TYPES,

} from '../generateAnimationStub';

describe('ANIMATION_TYPES', () => {
  it('includes idle, walk, jog, sit', () => {
    expect(ANIMATION_TYPES).toEqual(['idle', 'walk', 'jog', 'sit']);
  });
});

describe('generateAnimationStub', () => {
  it.each(ANIMATION_TYPES)('produces valid glTF 2.0 for %s', (type) => {
    const gltf = generateAnimationStub(type) as Record<string, unknown>;

    expect(gltf.asset).toEqual(
      expect.objectContaining({ version: '2.0' }),
    );
    expect(gltf.scene).toBe(0);
    expect(gltf.scenes).toBeDefined();
    expect(gltf.nodes).toBeDefined();
    expect(gltf.animations).toBeDefined();
    expect(gltf.accessors).toBeDefined();
    expect(gltf.bufferViews).toBeDefined();
    expect(gltf.buffers).toBeDefined();
  });

  it.each(ANIMATION_TYPES)('has a single animation named "%s"', (type) => {
    const gltf = generateAnimationStub(type) as Record<string, unknown>;
    const animations = gltf.animations as Array<{ name: string }>;
    expect(animations).toHaveLength(1);
    expect(animations[0].name).toBe(type);
  });

  it.each(ANIMATION_TYPES)('animation %s targets translation path', (type) => {
    const gltf = generateAnimationStub(type) as Record<string, unknown>;
    const animations = gltf.animations as Array<{
      channels: Array<{ target: { path: string } }>;
    }>;
    expect(animations[0].channels[0].target.path).toBe('translation');
  });

  it.each(ANIMATION_TYPES)('embeds buffers as base64 data URIs for %s', (type) => {
    const gltf = generateAnimationStub(type) as Record<string, unknown>;
    const buffers = gltf.buffers as Array<{ uri: string }>;
    for (const buf of buffers) {
      expect(buf.uri).toMatch(/^data:application\/octet-stream;base64,/);
    }
  });

  it('marks stubs as placeholders in asset extras', () => {
    const gltf = generateAnimationStub('idle') as Record<string, unknown>;
    const asset = gltf.asset as { extras?: { placeholder?: boolean } };
    expect(asset.extras?.placeholder).toBe(true);
  });

  it('sit animation has negative Y values (downward motion)', () => {
    const gltf = generateAnimationStub('sit') as Record<string, unknown>;
    const accessors = gltf.accessors as Array<{ min: number[]; type: string }>;
    // The VEC3 accessor (output values) should have negative Y min
    const vec3Accessor = accessors.find((a) => a.type === 'VEC3');
    expect(vec3Accessor).toBeDefined();
    expect(vec3Accessor!.min[1]).toBeLessThan(0);
  });

  it('idle animation uses LINEAR interpolation', () => {
    const gltf = generateAnimationStub('idle') as Record<string, unknown>;
    const animations = gltf.animations as Array<{
      samplers: Array<{ interpolation: string }>;
    }>;
    expect(animations[0].samplers[0].interpolation).toBe('LINEAR');
  });
});
