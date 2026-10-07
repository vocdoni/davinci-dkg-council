import { describe, expect, it } from 'vitest';
import { encodeAction, G, IDENTITY, relayRequestBody, type Action, type Hex, type Point } from '@vocdoni/davinci-dkg-council-sdk';
import { RelayError } from '../src/errors.js';
import { parseRelayRequest } from '../src/wire.js';

const MANAGER: Hex = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const CID: Hex = '0xba92d83fa5be494b998b1667';
const RID: Hex = `0x${'bb'.repeat(32)}`;
const SIG: Hex = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
const SIG2: Hex = `0x${'33'.repeat(32)}${'44'.repeat(32)}1c`;
const ADDR: Hex = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const PROOF = { pA: [1n, 2n], pB: [[3n, 4n], [5n, 6n]], pC: [7n, 8n] } as Extract<Action, { kind: 'deal' }>['payload']['proof'];

const actions: Action[] = [
  {
    kind: 'createCeremony',
    message: {
      organizer: ADDR,
      nonce: 0xffff_ffff_ffff_ffffn,
      threshold: 3,
      registrationMode: 1,
      registrationDeadline: 1_900_000_000n,
      dealingDuration: 600n,
      decryptionMode: 0,
      decryptionOpenAt: 0n,
      manualDecryptionFallbackAt: 1_950_000_000n,
      inviteKeys: [ADDR, MANAGER],
      validUntil: 1_900_000_000n,
    },
    signature: SIG,
  },
  { kind: 'addInvites', message: { ceremonyId: CID, firstInviteId: 2, inviteKeys: [ADDR], validUntil: 9n }, signature: SIG },
  { kind: 'closeRegistration', message: { ceremonyId: CID, participantCount: 5, validUntil: 9n }, signature: SIG },
  { kind: 'allowAdapter', message: { ceremonyId: CID, adapter: ADDR, validUntil: 9n }, signature: SIG },
  { kind: 'authorizeCreator', message: { ceremonyId: CID, creator: ADDR, validUntil: 9n }, signature: SIG },
  {
    kind: 'join',
    message: {
      ceremonyId: CID,
      participant: ADDR,
      inviteId: 4,
      pkX: G.x,
      pkY: G.y,
      popAx: 1n,
      popAy: 2n,
      popZ: 3n,
      validUntil: 9n,
    },
    signature: SIG,
    invite: { ceremonyId: CID, inviteId: 4, participant: ADDR, pkX: G.x, pkY: G.y, validUntil: 9n },
    inviteSignature: SIG2,
  },
  {
    kind: 'deal',
    message: { ceremonyId: CID, dealerIndex: 2, payloadHash: `0x${'aa'.repeat(32)}`, validUntil: 9n },
    signature: SIG,
    payload: {
      C: Array.from({ length: 16 }, (_, k) => (k < 3 ? G : IDENTITY)),
      E: G,
      masked: Array.from({ length: 16 }, (_, i) => (i < 5 ? BigInt(i) * 10n ** 70n : 0n)),
      proof: PROOF,
    },
  },
  {
    kind: 'submitPartial',
    message: { ceremonyId: CID, requestId: RID, participantIndex: 3, payloadHash: `0x${'cc'.repeat(32)}`, validUntil: 9n },
    signature: SIG,
    payload: { D: Array.from({ length: 16 }, (_, k) => (k < 2 ? G : IDENTITY)), proof: PROOF },
  },
  { kind: 'finalize', ceremonyId: CID },
  { kind: 'abort', ceremonyId: CID },
  {
    kind: 'combine',
    requestId: RID,
    memberSet: [1, 3, 5],
    fieldIndexes: [0, 2],
    plaintexts: [0n, (1n << 40n) - 1n],
    partialVectors: [1, 3, 5].map((i) => Array.from({ length: 16 }, (_, k) => (k < 3 ? { x: G.x, y: BigInt(i) } : IDENTITY))),
  },
  { kind: 'closeRegistrationScheduled', ceremonyId: CID },
  { kind: 'openDecryption', message: { ceremonyId: CID, validUntil: 9n }, signature: SIG },
  {
    kind: 'publishPartialData',
    requestId: RID,
    participantIndex: 3,
    D: Array.from({ length: 16 }, (_, k) => (k < 2 ? G : IDENTITY)),
  },
];

/** The points the relayer rebuilds from state (never on the wire), filled in for encoding. */
function completed(action: Action): Action {
  const pts = (n: number): Point[] => Array.from({ length: n }, () => G);
  switch (action.kind) {
    case 'closeRegistration':
    case 'closeRegistrationScheduled':
    case 'deal':
      return { ...action, rosterKeys: pts(5) };
    case 'submitPartial':
      return { ...action, C1: pts(2) };
    case 'combine':
      return { ...action, C2: pts(action.fieldIndexes.length) };
    default:
      return action;
  }
}

/** A JSON round trip, as the body travels over HTTP. */
const wire = (action: Action): Record<string, unknown> =>
  JSON.parse(JSON.stringify(relayRequestBody(31337n, MANAGER, action))) as Record<string, unknown>;

const errorOf = (fn: () => unknown): RelayError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof RelayError) return err;
    throw err;
  }
  throw new Error('expected a RelayError');
};

describe('relay wire format (§5.1)', () => {
  it.each(actions.map((a) => [a.kind, a] as const))('%s: SDK body parses back to the same calldata', (_k, action) => {
    const parsed = parseRelayRequest(wire(action));
    expect(parsed.chainId).toBe(31337n);
    expect(parsed.manager).toBe(MANAGER);
    expect(parsed.action).toEqual(action);
    expect(encodeAction(completed(parsed.action))).toBe(encodeAction(completed(action)));
  });

  it('never takes the points the relayer rebuilds from state off the wire', () => {
    const roster = { ...wire(actions[2] as Action), rosterKeys: [['1', '2']] };
    expect(errorOf(() => parseRelayRequest(roster)).code).toBe('INVALID_ACTION');
    const c2 = wire(actions[10] as Action);
    (c2.payload as Record<string, unknown>).C2 = [['1', '2']];
    expect(errorOf(() => parseRelayRequest(c2)).detail).toBe('payload.C2: unknown field');
    const c1 = wire(actions[7] as Action);
    (c1.payload as Record<string, unknown>).C1 = [['1', '2']];
    expect(errorOf(() => parseRelayRequest(c1)).detail).toBe('payload.C1: unknown field');
  });

  it('scopes rate limits by ceremony (createCeremony derives the id) or request', () => {
    expect(parseRelayRequest(wire(actions[1] as Action)).scope).toBe(`ceremony:${CID}`);
    expect(parseRelayRequest(wire(actions[0] as Action)).scope).toMatch(/^ceremony:0x[0-9a-f]{24}$/);
    expect(parseRelayRequest(wire(actions[10] as Action)).scope).toBe(`request:${RID}`);
    expect(parseRelayRequest(wire(actions[5] as Action)).scope).toBe(`ceremony:${CID}`);
    expect(parseRelayRequest(wire(actions[11] as Action)).scope).toBe(`ceremony:${CID}`);
    expect(parseRelayRequest(wire(actions[12] as Action)).scope).toBe(`ceremony:${CID}`);
    expect(parseRelayRequest(wire(actions[13] as Action)).scope).toBe(`request:${RID}`);
  });

  it('carries chainId as a decimal string and accepts small struct ints as JSON numbers', () => {
    const body = wire(actions[2] as Action);
    expect(body.chainId).toBe('31337');
    (body.message as Record<string, unknown>).participantCount = 5;
    const parsed = parseRelayRequest(body);
    expect(parsed.chainId).toBe(31337n);
    expect(parsed.action).toEqual(actions[2]);
    const big = wire(actions[8] as Action);
    big.chainId = (2n ** 64n + 1n).toString();
    expect(parseRelayRequest(big).chainId).toBe(2n ** 64n + 1n);
  });

  const mutate = (index: number, fn: (b: Record<string, any>) => void): Record<string, unknown> => {
    const b = wire(actions[index] as Action);
    fn(b);
    return b;
  };

  it.each([
    ['unknown action', mutate(8, (b) => (b.action = 'drain'))],
    ['unknown top-level field', mutate(8, (b) => (b.extra = 1))],
    ['missing struct field', mutate(2, (b) => delete b.message.validUntil)],
    ['extra struct field', mutate(2, (b) => (b.message.foo = '1'))],
    ['leading zero decimal', mutate(2, (b) => (b.message.validUntil = '09'))],
    ['negative decimal', mutate(2, (b) => (b.message.validUntil = '-1'))],
    ['exponent notation', mutate(2, (b) => (b.message.validUntil = '1e9'))],
    ['uint64 overflow', mutate(2, (b) => (b.message.validUntil = (1n << 64n).toString()))],
    ['uint8 overflow', mutate(2, (b) => (b.message.participantCount = '256'))],
    ['bigint as JSON number', mutate(2, (b) => (b.message.validUntil = 9))],
    ['short ceremony id', mutate(2, (b) => (b.message.ceremonyId = '0x1234'))],
    ['field element above 2^256', mutate(6, (b) => (b.payload.masked[0] = (1n << 256n).toString()))],
    ['15 commitments', mutate(6, (b) => b.payload.C.pop())],
    ['point with 3 coordinates', mutate(7, (b) => b.payload.D[0].push('1'))],
    ['proof missing pC', mutate(7, (b) => delete b.payload.proof.pC)],
    ['join with one signature', mutate(5, (b) => b.signatures.pop())],
    ['join message without invite', mutate(5, (b) => delete b.message.invite)],
    ['finalize with a message', mutate(8, (b) => (b.message = {}))],
    ['abort with signatures', mutate(9, (b) => (b.signatures = []))],
    ['signed action with payload', mutate(2, (b) => (b.payload = {}))],
    ['combine plaintext/field mismatch', mutate(10, (b) => b.payload.plaintexts.pop())],
    ['combine fractional member', mutate(10, (b) => (b.payload.memberSet[0] = 1.5))],
    ['combine plaintext above uint64', mutate(10, (b) => (b.payload.plaintexts[0] = (1n << 64n).toString()))],
    ['combine without partial vectors', mutate(10, (b) => delete b.payload.partialVectors)],
    ['combine vector count/member mismatch', mutate(10, (b) => b.payload.partialVectors.pop())],
    ['combine vector of 15 points', mutate(10, (b) => b.payload.partialVectors[1].pop())],
    ['scheduled close with a message', mutate(11, (b) => (b.message = {}))],
    ['scheduled close with roster keys', mutate(11, (b) => (b.payload.rosterKeys = []))],
    ['openDecryption with a payload', mutate(12, (b) => (b.payload = {}))],
    ['openDecryption missing validUntil', mutate(12, (b) => delete b.message.validUntil)],
    ['publish fractional index', mutate(13, (b) => (b.payload.participantIndex = 1.5))],
    ['publish index as a string', mutate(13, (b) => (b.payload.participantIndex = '3'))],
    ['publish 17 points', mutate(13, (b) => b.payload.D.push(['0', '1']))],
    ['publish with signatures', mutate(13, (b) => (b.signatures = []))],
    ['zero chain id', mutate(8, (b) => (b.chainId = '0'))],
    ['chain id as a JSON number', mutate(8, (b) => (b.chainId = 31337))],
    ['chain id with a leading zero', mutate(8, (b) => (b.chainId = '031337'))],
    ['manager not an address', mutate(8, (b) => (b.manager = '0xdead'))],
  ])('rejects %s with INVALID_ACTION', (_name, body) => {
    const err = errorOf(() => parseRelayRequest(body));
    expect(err.code).toBe('INVALID_ACTION');
    expect(err.status).toBe(400);
  });

  it('rejects non-canonical signatures with BAD_SIGNATURE', () => {
    const N = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;
    const highS = `0x${'11'.repeat(32)}${(N - 1n).toString(16)}1b`;
    const badV = `0x${'11'.repeat(32)}${'22'.repeat(32)}02`;
    for (const sig of [highS, badV]) {
      const err = errorOf(() => parseRelayRequest(mutate(2, (b) => (b.signatures = [sig]))));
      expect(err.code).toBe('BAD_SIGNATURE');
    }
    expect(errorOf(() => parseRelayRequest(mutate(2, (b) => (b.signatures = ['0x1234'])))).code).toBe('INVALID_ACTION');
  });
});
