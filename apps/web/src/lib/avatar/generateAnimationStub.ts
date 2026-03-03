/**
 * Generates minimal glTF 2.0 animation stubs.
 *
 * These are valid glTF files with a single animation channel targeting
 * a node's translation or rotation. They serve as placeholders until
 * real CC0 animations (Quaternius, Mixamo, etc.) are downloaded.
 *
 * Each animation loops at the specified duration and provides minimal
 * visual motion so the idle scene doesn't appear frozen.
 */

/** Supported animation types for placeholder stubs. */
export type AnimationType = 'idle' | 'walk' | 'jog' | 'sit';

interface AnimationConfig {
  /** Animation duration in seconds */
  duration: number;
  /** Keyframe times (normalized to duration) */
  times: number[];
  /** Y translation values at each keyframe */
  values: number[];
  /** Description for the stub */
  description: string;
}

const ANIMATION_CONFIGS: Record<AnimationType, AnimationConfig> = {
  idle: {
    duration: 3.0,
    times: [0, 1.5, 3.0],
    values: [0, 0.02, 0],  // subtle breathing bob
    description: 'Subtle vertical bob simulating breathing',
  },
  walk: {
    duration: 1.0,
    times: [0, 0.25, 0.5, 0.75, 1.0],
    values: [0, 0.03, 0, 0.03, 0],  // step bounce
    description: 'Step-bounce walking cycle',
  },
  jog: {
    duration: 0.6,
    times: [0, 0.15, 0.3, 0.45, 0.6],
    values: [0, 0.05, 0, 0.05, 0],  // faster, higher bounce
    description: 'Faster step-bounce jogging cycle',
  },
  sit: {
    duration: 1.5,
    times: [0, 0.75, 1.5],
    values: [0, -0.3, -0.3],  // move down and stay
    description: 'Downward translation to seated position',
  },
};

/** Encode a Float32Array as base64 data URI */
function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Generate a minimal glTF 2.0 animation file for the given type.
 * Contains a single animation channel that moves a root node on the Y axis.
 */
export function generateAnimationStub(type: AnimationType): object {
  const config = ANIMATION_CONFIGS[type];

  const timesArr = new Float32Array(config.times);
  const valuesArr = new Float32Array(config.values.flatMap(y => [0, y, 0])); // vec3 translation

  const timesBase64 = float32ToBase64(timesArr);
  const valuesBase64 = float32ToBase64(valuesArr);

  const timesBytes = timesArr.byteLength;
  const valuesBytes = valuesArr.byteLength;

  return {
    asset: {
      version: '2.0',
      generator: 'quorum-animation-stub',
      extras: { description: config.description, placeholder: true },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'AnimRoot' }],
    animations: [
      {
        name: type,
        channels: [
          {
            sampler: 0,
            target: { node: 0, path: 'translation' },
          },
        ],
        samplers: [
          {
            input: 0,    // times accessor
            output: 1,   // values accessor
            interpolation: 'LINEAR',
          },
        ],
      },
    ],
    accessors: [
      // Times
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: config.times.length,
        type: 'SCALAR',
        min: [config.times[0]],
        max: [config.times[config.times.length - 1]],
      },
      // Values (vec3 translations)
      {
        bufferView: 1,
        byteOffset: 0,
        componentType: 5126,
        count: config.values.length,
        type: 'VEC3',
        min: [0, Math.min(...config.values), 0],
        max: [0, Math.max(...config.values), 0],
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: timesBytes },
      { buffer: 1, byteOffset: 0, byteLength: valuesBytes },
    ],
    buffers: [
      { uri: `data:application/octet-stream;base64,${timesBase64}`, byteLength: timesBytes },
      { uri: `data:application/octet-stream;base64,${valuesBase64}`, byteLength: valuesBytes },
    ],
  };
}

/** All supported animation types */
export const ANIMATION_TYPES: AnimationType[] = ['idle', 'walk', 'jog', 'sit'];
