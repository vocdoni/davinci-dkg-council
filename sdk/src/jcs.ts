/**
 * RFC 8785 (JSON Canonicalization Scheme) serialization, used by the recovery
 * kit checksum (protocol §5.3).
 *
 * ECMAScript's `JSON.stringify` already matches JCS for strings (shortest
 * escapes, lowercase \u00xx for control characters) and for numbers
 * (ECMAScript Number-to-string); JCS adds lexicographic member ordering by
 * UTF-16 code units, implemented here.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * RFC 8785 requires well-formed Unicode: a lone UTF-16 surrogate has no
 * canonical UTF-8 encoding, so it is rejected rather than serialized.
 */
const assertWellFormed = (s: string, what: string): void => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`jcs: lone UTF-16 surrogate in ${what}`);
      i++; // valid pair
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new Error(`jcs: lone UTF-16 surrogate in ${what}`);
    }
  }
};

export function jcsCanonicalize(value: JsonValue): string {
  if (typeof value === 'string') {
    assertWellFormed(value, 'string');
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('jcs: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => jcsCanonicalize(v === undefined ? null : v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    // Sort keys by UTF-16 code units (JS default string comparison).
    const keys = Object.keys(value).sort();
    for (const k of keys) assertWellFormed(k, 'key');
    const members = keys
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${jcsCanonicalize(value[k] as JsonValue)}`);
    return `{${members.join(',')}}`;
  }
  throw new Error(`jcs: unsupported value type ${typeof value}`);
}
