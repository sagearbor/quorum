/**
 * Generates a minimal glTF 2.0 JSON for a procedural placeholder avatar.
 *
 * Geometry: capsule body (approximated as cylinder + hemispheres) + sphere head.
 * Colors come from the archetype color map. The output is a valid glTF JSON
 * that can be written as a .gltf file and loaded by Three.js / R3F.
 *
 * NOTE: For simplicity, we generate a box body + sphere head using
 * primitive mesh data embedded in the glTF. This keeps the generator
 * dependency-free (no Three.js runtime needed at build time).
 */

import {
  type ArchetypeId,
  ARCHETYPE_COLORS,
  ARCHETYPE_GLB_FILENAMES,
} from './archetypeColors';

/** Convert hex color string to [r, g, b, a] float array */
export function hexToRgba(hex: string): [number, number, number, number] {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;
  return [r, g, b, 1.0];
}

/**
 * Generates a unit box mesh as a base64-encoded binary buffer for glTF.
 * Returns positions, normals, and indices as interleaved buffer data.
 */
function generateBoxBuffer(
  width: number,
  height: number,
  depth: number,
): { base64: string; byteLength: number; posAccessor: number[]; idxAccessor: number[] } {
  const hw = width / 2, hh = height / 2, hd = depth / 2;

  // 24 vertices (4 per face, 6 faces), each: 3 pos + 3 normal = 6 floats
  const verts: number[] = [];
  const indices: number[] = [];

  const faces: Array<{ corners: number[][]; normal: number[] }> = [
    { corners: [[-hw,-hh, hd],[ hw,-hh, hd],[ hw, hh, hd],[-hw, hh, hd]], normal: [0,0,1] },
    { corners: [[ hw,-hh,-hd],[-hw,-hh,-hd],[-hw, hh,-hd],[ hw, hh,-hd]], normal: [0,0,-1] },
    { corners: [[-hw, hh, hd],[ hw, hh, hd],[ hw, hh,-hd],[-hw, hh,-hd]], normal: [0,1,0] },
    { corners: [[-hw,-hh,-hd],[ hw,-hh,-hd],[ hw,-hh, hd],[-hw,-hh, hd]], normal: [0,-1,0] },
    { corners: [[ hw,-hh, hd],[ hw,-hh,-hd],[ hw, hh,-hd],[ hw, hh, hd]], normal: [1,0,0] },
    { corners: [[-hw,-hh,-hd],[-hw,-hh, hd],[-hw, hh, hd],[-hw, hh,-hd]], normal: [-1,0,0] },
  ];

  let vi = 0;
  for (const face of faces) {
    for (const c of face.corners) {
      verts.push(c[0], c[1], c[2], face.normal[0], face.normal[1], face.normal[2]);
    }
    indices.push(vi, vi+1, vi+2, vi, vi+2, vi+3);
    vi += 4;
  }

  const vertBuffer = new Float32Array(verts);
  const idxBuffer = new Uint16Array(indices);

  // Combine into single binary buffer
  const vertBytes = vertBuffer.buffer as ArrayBuffer;
  const idxBytes = idxBuffer.buffer as ArrayBuffer;

  const totalLen = vertBytes.byteLength + idxBytes.byteLength;
  const combined = new Uint8Array(totalLen);
  combined.set(new Uint8Array(vertBytes), 0);
  combined.set(new Uint8Array(idxBytes), vertBytes.byteLength);

  const base64 = uint8ToBase64(combined);

  return {
    base64,
    byteLength: totalLen,
    posAccessor: [vertBytes.byteLength, idxBytes.byteLength],
    idxAccessor: [indices.length, vertBytes.byteLength],
  };
}

/** Convert Uint8Array to base64 string */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // Works in Node.js
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  return btoa(binary);
}

/**
 * Build a minimal glTF JSON for a placeholder avatar.
 *
 * Structure:
 * - Node 0: body (box mesh, shirt color)
 * - Node 1: head (box mesh approximating sphere, skin color)
 * - Node 2: root (parent of body + head)
 */
export function generatePlaceholderGltf(archetypeId: ArchetypeId): object {
  const colors = ARCHETYPE_COLORS[archetypeId];
  const shirtColor = hexToRgba(colors.shirt);
  const skinColor = hexToRgba(colors.skin);

  // Body: 0.4 x 0.6 x 0.25
  const body = generateBoxBuffer(0.4, 0.6, 0.25);
  // Head: 0.2 x 0.2 x 0.2
  const head = generateBoxBuffer(0.2, 0.2, 0.2);

  return {
    asset: { version: '2.0', generator: 'quorum-placeholder-gen' },
    scene: 0,
    scenes: [{ nodes: [2] }],
    nodes: [
      // Body — centered at origin
      { name: 'Body', mesh: 0, translation: [0, 0.3, 0] },
      // Head — on top of body
      { name: 'Head', mesh: 1, translation: [0, 0.7, 0] },
      // Root
      { name: 'Root', children: [0, 1] },
    ],
    meshes: [
      {
        name: 'BodyMesh',
        primitives: [{
          attributes: { POSITION: 0, NORMAL: 1 },
          indices: 2,
          material: 0,
        }],
      },
      {
        name: 'HeadMesh',
        primitives: [{
          attributes: { POSITION: 3, NORMAL: 4 },
          indices: 5,
          material: 1,
        }],
      },
    ],
    materials: [
      {
        name: 'ShirtMaterial',
        pbrMetallicRoughness: {
          baseColorFactor: shirtColor,
          metallicFactor: 0.0,
          roughnessFactor: 0.8,
        },
      },
      {
        name: 'SkinMaterial',
        pbrMetallicRoughness: {
          baseColorFactor: skinColor,
          metallicFactor: 0.0,
          roughnessFactor: 0.9,
        },
      },
    ],
    accessors: [
      // Body position (accessor 0)
      {
        bufferView: 0, byteOffset: 0, componentType: 5126, count: 24,
        type: 'VEC3', max: [0.2, 0.3, 0.125], min: [-0.2, -0.3, -0.125],
      },
      // Body normal (accessor 1)
      {
        bufferView: 0, byteOffset: 12, componentType: 5126, count: 24,
        type: 'VEC3', max: [1, 1, 1], min: [-1, -1, -1],
      },
      // Body indices (accessor 2)
      {
        bufferView: 1, byteOffset: 0, componentType: 5123, count: 36,
        type: 'SCALAR', max: [23], min: [0],
      },
      // Head position (accessor 3)
      {
        bufferView: 2, byteOffset: 0, componentType: 5126, count: 24,
        type: 'VEC3', max: [0.1, 0.1, 0.1], min: [-0.1, -0.1, -0.1],
      },
      // Head normal (accessor 4)
      {
        bufferView: 2, byteOffset: 12, componentType: 5126, count: 24,
        type: 'VEC3', max: [1, 1, 1], min: [-1, -1, -1],
      },
      // Head indices (accessor 5)
      {
        bufferView: 3, byteOffset: 0, componentType: 5123, count: 36,
        type: 'SCALAR', max: [23], min: [0],
      },
    ],
    bufferViews: [
      // Body vertex data (interleaved pos+normal, stride 24 bytes)
      { buffer: 0, byteOffset: 0, byteLength: body.posAccessor[0], byteStride: 24, target: 34962 },
      // Body index data
      { buffer: 0, byteOffset: body.idxAccessor[1], byteLength: body.posAccessor[1], target: 34963 },
      // Head vertex data
      { buffer: 1, byteOffset: 0, byteLength: head.posAccessor[0], byteStride: 24, target: 34962 },
      // Head index data
      { buffer: 1, byteOffset: head.idxAccessor[1], byteLength: head.posAccessor[1], target: 34963 },
    ],
    buffers: [
      { uri: `data:application/octet-stream;base64,${body.base64}`, byteLength: body.byteLength },
      { uri: `data:application/octet-stream;base64,${head.base64}`, byteLength: head.byteLength },
    ],
  };
}

/**
 * Returns the expected GLB filename for an archetype.
 */
export function getAvatarGlbFilename(archetypeId: ArchetypeId): string {
  return ARCHETYPE_GLB_FILENAMES[archetypeId];
}

/**
 * Returns the public URL path for an archetype's avatar asset.
 */
export function getAvatarUrl(archetypeId: ArchetypeId): string {
  return `/avatars/${ARCHETYPE_GLB_FILENAMES[archetypeId]}`;
}

/**
 * Returns the public URL path for an animation.
 */
export function getAnimationUrl(animationName: 'idle' | 'walk' | 'jog' | 'sit'): string {
  return `/animations/${animationName}.gltf`;
}
