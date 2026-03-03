/**
 * Three.js utility: traverses a loaded GLTF scene and overrides
 * shirt/torso materials to Duke blue (#003087) for non-patient archetypes.
 */

import type { ArchetypeId } from './archetypes';
import { DUKE_BLUE, isDukeBlueArchetype } from './archetypes';

/** Material names commonly used for shirt/torso in RPM avatars */
const SHIRT_MATERIAL_NAMES = [
  'shirt', 'torso', 'top', 'body', 'outfit_top', 'Wolf3D_Outfit_Top',
];

function isShirtMaterial(name: string): boolean {
  const lower = name.toLowerCase();
  return SHIRT_MATERIAL_NAMES.some((s) => lower.includes(s.toLowerCase()));
}

/**
 * Traverses a Three.js Object3D (GLTF scene) and overrides shirt materials
 * to Duke blue for non-patient archetypes.
 *
 * @param scene - The root Object3D from a loaded GLTF
 * @param archetypeId - The archetype to apply branding for
 * @param THREE - The Three.js module (injected to avoid bundling issues)
 * @returns Number of materials overridden
 */
export function applyDukeBlueOverride(
  scene: { traverse: (cb: (child: unknown) => void) => void },
  archetypeId: ArchetypeId,
  THREE: {
    Color: new (hex: string) => unknown;
    MeshStandardMaterial: new (params: { color: unknown }) => unknown;
  },
): number {
  if (!isDukeBlueArchetype(archetypeId)) return 0;

  const dukeColor = new THREE.Color(DUKE_BLUE);
  let count = 0;

  scene.traverse((child: unknown) => {
    const mesh = child as {
      isMesh?: boolean;
      material?: { name?: string; color?: unknown };
    };

    if (!mesh.isMesh || !mesh.material) return;

    const matName = mesh.material.name ?? '';
    if (isShirtMaterial(matName)) {
      mesh.material = new THREE.MeshStandardMaterial({ color: dukeColor }) as typeof mesh.material;
      count++;
    }
  });

  return count;
}
