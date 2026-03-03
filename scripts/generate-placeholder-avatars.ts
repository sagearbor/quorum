#!/usr/bin/env npx tsx
/**
 * Generate placeholder .gltf avatar files for all 12 archetypes
 * and animation stubs for idle/walk/jog/sit.
 *
 * Usage: npx tsx scripts/generate-placeholder-avatars.ts
 *
 * Output:
 *   apps/web/public/avatars/<archetype>.gltf
 *   apps/web/public/animations/<type>.gltf
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import {
  ARCHETYPE_IDS,
  ARCHETYPE_GLB_FILENAMES,
} from '../apps/web/src/lib/avatar/archetypeColors';
import { generatePlaceholderGltf } from '../apps/web/src/lib/avatar/generatePlaceholderGltf';
import {
  generateAnimationStub,
  ANIMATION_TYPES,
} from '../apps/web/src/lib/avatar/generateAnimationStub';

const ROOT = join(__dirname, '..');
const AVATAR_DIR = join(ROOT, 'apps/web/public/avatars');
const ANIM_DIR = join(ROOT, 'apps/web/public/animations');

mkdirSync(AVATAR_DIR, { recursive: true });
mkdirSync(ANIM_DIR, { recursive: true });

console.log('Generating placeholder avatars...\n');

// Generate avatar placeholders
for (const id of ARCHETYPE_IDS) {
  const glbName = ARCHETYPE_GLB_FILENAMES[id];
  // Use .gltf extension (JSON) since we embed buffers as data URIs
  const gltfName = glbName.replace('.glb', '.gltf');
  const gltf = generatePlaceholderGltf(id);
  const outPath = join(AVATAR_DIR, gltfName);
  writeFileSync(outPath, JSON.stringify(gltf, null, 2));
  console.log(`  ✓ ${id} → ${gltfName}`);
}

console.log('\nGenerating animation stubs...\n');

// Generate animation stubs
for (const type of ANIMATION_TYPES) {
  const gltf = generateAnimationStub(type);
  const outPath = join(ANIM_DIR, `${type}.gltf`);
  writeFileSync(outPath, JSON.stringify(gltf, null, 2));
  console.log(`  ✓ ${type}.gltf`);
}

console.log('\nDone! Placeholder assets generated.');
console.log(`  Avatars:    ${AVATAR_DIR}`);
console.log(`  Animations: ${ANIM_DIR}`);
