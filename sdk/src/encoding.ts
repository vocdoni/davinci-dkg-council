/**
 * Hashing and encoding primitives (protocol §1, §3, §4).
 *
 * Every hash input goes through a real ABI encoder (viem `encodeAbiParameters`)
 * with the exact Solidity type list — ad-hoc concatenation is forbidden by the
 * protocol. Pure computation: no I/O, no logging.
 */

import { encodeAbiParameters, keccak256, parseAbiParameters, toBytes } from 'viem';
import {
  LIMIT_R,
  P,
  R,
  TAG_CEREMONY,
  TAG_CIRCUIT_RELEASE,
  TAG_DEAL_CONTEXT,
  TAG_REQUEST,
  TAG_ROSTER,
} from './constants.js';
import type { Hex, Point, Roster } from './types.js';

/** keccak256 of the UTF-8 bytes of a domain tag string. */
export function tagHash(tag: string): Hex {
  return keccak256(toBytes(tag));
}

/**
 * ABI-encode typed fields. `types` is a Solidity parameter list string, e.g.
 * `'uint256, address, bytes12'`; values follow viem's encoding conventions.
 */
export function abiEncode(types: string, values: unknown[]): Hex {
  return encodeAbiParameters(parseAbiParameters(types), values as never);
}

/**
 * Tagged hash `K(tag, f1..fk) = keccak256(abi.encode(keccak256(utf8(tag)), f1, .., fk))`
 * (protocol §1). `types` lists the field types WITHOUT the leading bytes32 tag hash.
 */
export function taggedHash(tag: string, types: string, values: unknown[]): Hex {
  const full = types.length > 0 ? `bytes32, ${types}` : 'bytes32';
  return keccak256(abiEncode(full, [tagHash(tag), ...values]));
}

/**
 * `HashToScalar(tag, f1..fk)`: uniform scalar in F_r by rejection sampling
 * (protocol §3.1). Counters 0..255; exhaustion throws (never wraps).
 */
export function hashToScalar(tag: string, types: string, values: unknown[]): bigint {
  const th = tagHash(tag);
  const fullTypes = types.length > 0 ? `bytes32, ${types}, uint32` : 'bytes32, uint32';
  for (let counter = 0; counter < 256; counter++) {
    const u = BigInt(keccak256(abiEncode(fullTypes, [th, ...values, counter])));
    if (u < LIMIT_R) return u % R;
  }
  throw new Error(`hashToScalar: rejection counter exhausted for tag ${tag}`);
}

// --- bytes32 <-> 128-bit limbs (protocol §1) ---

export interface Limbs {
  hi: bigint;
  lo: bigint;
}

/** Split a bytes32 into 128-bit limbs: hi = bytes 0..15, lo = bytes 16..31, big-endian. */
export function bytes32ToLimbs(value: Hex): Limbs {
  const v = hexToBigInt32(value);
  return { hi: v >> 128n, lo: v & ((1n << 128n) - 1n) };
}

export function limbsToBytes32(limbs: Limbs): Hex {
  if (limbs.hi < 0n || limbs.hi >= 1n << 128n || limbs.lo < 0n || limbs.lo >= 1n << 128n) {
    throw new Error('limbsToBytes32: limb out of range');
  }
  return bigIntToHex32((limbs.hi << 128n) | limbs.lo);
}

// --- hex helpers ---

export function bigIntToHex32(v: bigint): Hex {
  if (v < 0n || v >= 1n << 256n) throw new Error('bigIntToHex32: out of range');
  return `0x${v.toString(16).padStart(64, '0')}`;
}

export function hexToBigInt32(h: Hex): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error(`hexToBigInt32: not 32 bytes: ${h}`);
  return BigInt(h);
}

/** Validate and normalize a bytes12 ceremony id (24 hex chars). */
export function normalizeCeremonyId(h: string): Hex {
  if (!/^0x[0-9a-fA-F]{24}$/.test(h)) throw new Error(`ceremony id must be 12 bytes: ${h}`);
  return h.toLowerCase() as Hex;
}

/** Validate and normalize a bytes31 process id (62 hex chars). */
export function normalizeProcessId(h: string): Hex {
  if (!/^0x[0-9a-fA-F]{62}$/.test(h)) throw new Error(`process id must be 31 bytes: ${h}`);
  return h.toLowerCase() as Hex;
}

// --- scalar / coordinate canonicality ---

export function isCanonicalScalar(v: bigint): boolean {
  return v >= 0n && v < R;
}

export function isCanonicalCoordinate(v: bigint): boolean {
  return v >= 0n && v < P;
}

export function assertCanonicalScalar(v: bigint, label: string): void {
  if (!isCanonicalScalar(v)) throw new Error(`${label}: scalar not canonical (must be < r)`);
}

// --- decimal-string codecs (witness JSON, relayer wire format) ---

export function toDecimal(v: bigint | number): string {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error('toDecimal: not a safe unsigned integer');
    return v.toString(10);
  }
  if (v < 0n) throw new Error('toDecimal: negative');
  return v.toString(10);
}

export function fromDecimal(s: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new Error(`fromDecimal: not a canonical decimal string: ${s}`);
  return BigInt(s);
}

export function pointToDecimal(p: Point): [string, string] {
  return [toDecimal(p.x), toDecimal(p.y)];
}

// --- identifiers (protocol §4) ---

/** Ceremony id = bytes12(K("davinci-dkg-council/v1/ceremony", chainId, manager, organizer, nonce)) (§4.1). */
export function ceremonyId(chainId: bigint, manager: Hex, organizer: Hex, nonce: bigint): Hex {
  const full = taggedHash(TAG_CEREMONY, 'uint256, address, address, uint64', [
    chainId,
    manager,
    organizer,
    nonce,
  ]);
  return full.slice(0, 2 + 24) as Hex; // 12 most significant bytes
}

/** Roster hash over the frozen roster (§4.3). */
export function rosterHash(chainId: bigint, manager: Hex, cid: Hex, roster: Roster): Hex {
  if (roster.authAddresses.length !== roster.n || roster.memberKeys.length !== roster.n) {
    throw new Error('rosterHash: roster arrays must have length n');
  }
  return taggedHash(
    TAG_ROSTER,
    'uint256, address, bytes12, uint8, uint8, address[], uint256[], uint256[]',
    [
      chainId,
      manager,
      normalizeCeremonyId(cid),
      roster.t,
      roster.n,
      roster.authAddresses,
      roster.memberKeys.map((p) => p.x),
      roster.memberKeys.map((p) => p.y),
    ],
  );
}

/** Dealing context (§4.3). */
export function dealContext(
  chainId: bigint,
  manager: Hex,
  cid: Hex,
  rosterHashValue: Hex,
  circuitReleaseId: Hex,
): Hex {
  return taggedHash(TAG_DEAL_CONTEXT, 'uint256, address, bytes12, bytes32, bytes32', [
    chainId,
    manager,
    normalizeCeremonyId(cid),
    rosterHashValue,
    circuitReleaseId,
  ]);
}

/** Circuit release id from the byte-exact released vkey file digests (§4.4). */
export function circuitReleaseId(dealVkeySha256: Hex, partialVkeySha256: Hex): Hex {
  return taggedHash(TAG_CIRCUIT_RELEASE, 'bytes32, bytes32', [dealVkeySha256, partialVkeySha256]);
}

/** Request id (§4.5). */
export function requestId(
  chainId: bigint,
  manager: Hex,
  cid: Hex,
  adapter: Hex,
  processId: Hex,
): Hex {
  return taggedHash(TAG_REQUEST, 'uint256, address, bytes12, address, bytes31', [
    chainId,
    manager,
    normalizeCeremonyId(cid),
    adapter,
    normalizeProcessId(processId),
  ]);
}
