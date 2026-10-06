/** Shared test helpers: vector loading and JSON codecs. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex, Point } from '../src/types.js';

const vectorsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/vectors');

/** Load a cross-implementation vector file, or undefined when not generated yet. */
export function loadVectors<T>(name: string): T | undefined {
  const file = path.join(vectorsDir, `${name}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export const skipMsg = (name: string): string =>
  `SKIPPED: cross-implementation vectors ${name}.json not found under tests/vectors — generate them with the circuits workspace (make vectors)`;

/** Vector point ["x","y"] (decimal strings) -> Point. */
export const vp = (xy: string[]): Point => ({ x: BigInt(xy[0] as string), y: BigInt(xy[1] as string) });

export interface TypedField {
  type: string;
  value: string;
}

/** Vector typed-field list -> (abi types, values). */
export function fieldList(fields: TypedField[]): { types: string; values: unknown[] } {
  return {
    types: fields.map((f) => f.type).join(', '),
    values: fields.map((f) => (f.type.startsWith('uint') ? BigInt(f.value) : f.value)),
  };
}

export const bytesToHex = (b: Uint8Array): Hex =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

/** Vector EIP-712 message JSON -> typed message (decimal strings become bigints). */
export function vectorMessage(message: Record<string, unknown>): Record<string, unknown> {
  const conv = (v: unknown): unknown => {
    if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) return BigInt(v);
    if (Array.isArray(v)) return v.map(conv);
    return v;
  };
  return Object.fromEntries(Object.entries(message).map(([k, v]) => [k, conv(v)]));
}
