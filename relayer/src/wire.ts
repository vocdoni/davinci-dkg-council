/**
 * The §5.1 relay request: shape validation and conversion into an SDK
 * `Action`. Shapes only — the contract is the validator, reached through
 * simulation. `chainId`, field elements and every other unsigned integer are
 * canonical decimal strings (small uint8/uint32 struct fields also accept
 * JSON integers); ids, addresses and signatures are 0x-hex; `memberSet` and
 * `fieldIndexes` are JSON integers.
 */

import {
  assertCanonicalSignature,
  ceremonyId as computeCeremonyId,
  EIP712_TYPES,
  MAX_INVITES,
  type Action,
  type Groth16Proof,
  type Hex,
  type Point,
} from '@vocdoni/davinci-dkg-council-sdk';
import { RelayError } from './errors.js';

export const ACTION_NAMES = [
  'createCeremony',
  'addInvites',
  'closeRegistration',
  'join',
  'deal',
  'allowAdapter',
  'authorizeCreator',
  'submitPartial',
  'finalize',
  'abort',
  'combine',
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

type StructName = keyof typeof EIP712_TYPES;

/** Organizer-signed actions whose whole message is one struct. */
const SIMPLE_SIGNED: Partial<Record<ActionName, StructName>> = {
  createCeremony: 'CreateCeremony',
  addInvites: 'AddInvites',
  closeRegistration: 'CloseRegistration',
  allowAdapter: 'AllowAdapter',
  authorizeCreator: 'AuthorizeCreator',
};

export interface ParsedRelay {
  chainId: bigint;
  manager: Hex;
  action: Action;
  /** Rate-limit scope: `ceremony:0x…` or `request:0x…`. */
  scope: string;
}

type Json = Record<string, unknown>;

function invalid(detail: string): never {
  throw new RelayError('INVALID_ACTION', detail);
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function object(v: unknown, label: string, keys: readonly string[]): Json {
  if (!isObject(v)) invalid(`${label}: expected an object`);
  for (const k of Object.keys(v)) {
    if (!keys.includes(k)) invalid(`${label}.${k}: unknown field`);
  }
  for (const k of keys) {
    if (v[k] === undefined) invalid(`${label}.${k}: missing`);
  }
  return v;
}

function array(v: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(v)) invalid(`${label}: expected an array`);
  if (v.length < min || v.length > max) {
    invalid(min === max ? `${label}: expected ${min} entries` : `${label}: expected ${min}..${max} entries`);
  }
  return v;
}

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

/** An unsigned integer of `bits` bits from a canonical decimal string (or a small JSON integer). */
function uint(v: unknown, bits: number, label: string): bigint {
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' && bits <= 32 && Number.isSafeInteger(v) && v >= 0) s = v.toString(10);
  else invalid(`${label}: expected a decimal string`);
  if (!DECIMAL.test(s)) invalid(`${label}: not a canonical decimal string`);
  const value = BigInt(s);
  if (value >= 1n << BigInt(bits)) invalid(`${label}: exceeds uint${bits}`);
  return value;
}

/** A JSON integer in [min, max] (memberSet / fieldIndexes entries). */
function smallInt(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    invalid(`${label}: expected an integer in ${min}..${max}`);
  }
  return v;
}

function hexBytes(v: unknown, bytes: number, label: string): Hex {
  if (typeof v !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)) {
    invalid(`${label}: expected 0x-hex of ${bytes} bytes`);
  }
  return v.toLowerCase() as Hex;
}

const field = (v: unknown, label: string): bigint => uint(v, 256, label);

function point(v: unknown, label: string): Point {
  const xy = array(v, label, 2, 2);
  return { x: field(xy[0], `${label}[0]`), y: field(xy[1], `${label}[1]`) };
}

function points(v: unknown, count: number, label: string): Point[] {
  return array(v, label, count, count).map((p, i) => point(p, `${label}[${i}]`));
}

function pair(v: unknown, label: string): [bigint, bigint] {
  const p = array(v, label, 2, 2);
  return [field(p[0], `${label}[0]`), field(p[1], `${label}[1]`)];
}

function proof(v: unknown, label: string): Groth16Proof {
  const o = object(v, label, ['pA', 'pB', 'pC']);
  const pB = array(o.pB, `${label}.pB`, 2, 2);
  return {
    pA: pair(o.pA, `${label}.pA`),
    pB: [pair(pB[0], `${label}.pB[0]`), pair(pB[1], `${label}.pB[1]`)],
    pC: pair(o.pC, `${label}.pC`),
  };
}

function typed(type: string, v: unknown, label: string): unknown {
  if (type === 'address') return hexBytes(v, 20, label);
  if (type === 'address[]') {
    return array(v, label, 0, MAX_INVITES).map((a, i) => hexBytes(a, 20, `${label}[${i}]`));
  }
  const u = /^uint(\d+)$/.exec(type);
  if (u) {
    const bits = Number(u[1]);
    const value = uint(v, bits, label);
    return bits <= 32 ? Number(value) : value;
  }
  const b = /^bytes(\d+)$/.exec(type);
  if (b) return hexBytes(v, Number(b[1]), label);
  throw new RelayError('INTERNAL', `unsupported struct field type ${type}`);
}

/** Parse one EIP-712 struct exactly as the SDK types it (uint8/uint32 -> number, wider -> bigint). */
function struct<T>(name: StructName, v: unknown, label: string): T {
  const fields = EIP712_TYPES[name];
  const o = object(
    v,
    label,
    fields.map((f) => f.name),
  );
  const out: Json = {};
  for (const f of fields) out[f.name] = typed(f.type, o[f.name], `${label}.${f.name}`);
  return out as T;
}

function signatures(v: unknown, count: number): Hex[] {
  const sigs = array(v, 'signatures', count, count).map((s, i) => hexBytes(s, 65, `signatures[${i}]`));
  sigs.forEach((s, i) => {
    try {
      assertCanonicalSignature(s);
    } catch (err) {
      throw new RelayError('BAD_SIGNATURE', `signatures[${i}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return sigs;
}

function absent(body: Json, keys: string[], action: string): void {
  for (const k of keys) {
    if (body[k] !== undefined) invalid(`${k} must be absent for ${action}`);
  }
}

/** A canonical decimal string: a JSON number could silently lose precision above 2^53. */
function chainIdOf(v: unknown): bigint {
  if (typeof v === 'string' && DECIMAL.test(v) && v !== '0') return BigInt(v);
  invalid('chainId: expected a positive canonical decimal string');
}

/** Validate a §5.1 relay body and convert it into an SDK action. */
export function parseRelayRequest(body: unknown): ParsedRelay {
  if (!isObject(body)) invalid('body: expected a JSON object');
  for (const k of Object.keys(body)) {
    if (!['action', 'chainId', 'manager', 'message', 'signatures', 'payload'].includes(k)) {
      invalid(`${k}: unknown field`);
    }
  }
  const name = body.action;
  if (typeof name !== 'string' || !(ACTION_NAMES as readonly string[]).includes(name)) {
    invalid(`action: expected one of ${ACTION_NAMES.join(', ')}`);
  }
  const chainId = chainIdOf(body.chainId);
  const manager = hexBytes(body.manager, 20, 'manager');
  const kind = name as ActionName;

  const simple = SIMPLE_SIGNED[kind];
  if (simple) {
    absent(body, ['payload'], kind);
    const message = struct<Json>(simple, body.message, 'message');
    const [signature] = signatures(body.signatures, 1);
    const action = { kind, message, signature } as unknown as Action;
    const cid =
      kind === 'createCeremony'
        ? computeCeremonyId(chainId, manager, message.organizer as Hex, message.nonce as bigint)
        : (message.ceremonyId as Hex);
    return { chainId, manager, action, scope: `ceremony:${cid}` };
  }

  switch (kind) {
    case 'join': {
      absent(body, ['payload'], kind);
      const m = object(body.message, 'message', ['join', 'invite']);
      const join = struct<Extract<Action, { kind: 'join' }>['message']>('Join', m.join, 'message.join');
      const invite = struct<Extract<Action, { kind: 'join' }>['invite']>('Invite', m.invite, 'message.invite');
      const [signature, inviteSignature] = signatures(body.signatures, 2) as [Hex, Hex];
      return {
        chainId,
        manager,
        action: { kind, message: join, signature, invite, inviteSignature },
        scope: `ceremony:${join.ceremonyId}`,
      };
    }
    case 'deal': {
      const message = struct<Extract<Action, { kind: 'deal' }>['message']>('Deal', body.message, 'message');
      const [signature] = signatures(body.signatures, 1) as [Hex];
      const p = object(body.payload, 'payload', ['C', 'E', 'masked', 'proof']);
      const payload = {
        C: points(p.C, 16, 'payload.C'),
        E: point(p.E, 'payload.E'),
        masked: array(p.masked, 'payload.masked', 16, 16).map((w, i) => field(w, `payload.masked[${i}]`)),
        proof: proof(p.proof, 'payload.proof'),
      };
      return {
        chainId,
        manager,
        action: { kind, message, signature, payload },
        scope: `ceremony:${message.ceremonyId}`,
      };
    }
    case 'submitPartial': {
      const message = struct<Extract<Action, { kind: 'submitPartial' }>['message']>('Partial', body.message, 'message');
      const [signature] = signatures(body.signatures, 1) as [Hex];
      const p = object(body.payload, 'payload', ['D', 'proof']);
      const payload = { D: points(p.D, 16, 'payload.D'), proof: proof(p.proof, 'payload.proof') };
      return {
        chainId,
        manager,
        action: { kind, message, signature, payload },
        scope: `ceremony:${message.ceremonyId}`,
      };
    }
    case 'finalize':
    case 'abort': {
      absent(body, ['message', 'signatures'], kind);
      const p = object(body.payload, 'payload', ['ceremonyId']);
      const ceremonyId = hexBytes(p.ceremonyId, 12, 'payload.ceremonyId');
      return { chainId, manager, action: { kind, ceremonyId }, scope: `ceremony:${ceremonyId}` };
    }
    case 'combine': {
      absent(body, ['message', 'signatures'], kind);
      const p = object(body.payload, 'payload', ['requestId', 'memberSet', 'fieldIndexes', 'plaintexts']);
      const requestId = hexBytes(p.requestId, 32, 'payload.requestId');
      const memberSet = array(p.memberSet, 'payload.memberSet', 1, 16).map((v, i) =>
        smallInt(v, `payload.memberSet[${i}]`, 0, 255),
      );
      const fieldIndexes = array(p.fieldIndexes, 'payload.fieldIndexes', 1, 16).map((v, i) =>
        smallInt(v, `payload.fieldIndexes[${i}]`, 0, 255),
      );
      const plaintexts = array(p.plaintexts, 'payload.plaintexts', 1, 16).map((v, i) =>
        uint(v, 64, `payload.plaintexts[${i}]`),
      );
      if (plaintexts.length !== fieldIndexes.length) invalid('payload.plaintexts: one plaintext per field index');
      return {
        chainId,
        manager,
        action: { kind, requestId, memberSet, fieldIndexes, plaintexts },
        scope: `request:${requestId}`,
      };
    }
    default:
      invalid(`action: ${kind} is not relayable`);
  }
}
