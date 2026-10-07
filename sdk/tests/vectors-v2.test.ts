/**
 * Cross-implementation vector tests for the v2 surfaces: the compressed point
 * codec (§2.5, codec.json), the partial-data commitment (§10.2,
 * partialdata.json) and the phase-policy schedule (§8, schedule.json). Each
 * suite skips with a clear message when the vectors have not been generated.
 */

import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import {
  authenticateCompressed,
  CodecError,
  compressPoint,
  decompressPoint,
  sqrtModP,
  type DecodeRejection,
} from '../src/codec.js';
import { invMod, isIdentity, isInPrimeSubgroup, isOnCurve } from '../src/curve.js';
import { partialDataHash } from '../src/partial.js';
import {
  dealOpen,
  decryptionOpenAt,
  abortDue,
  finalizeDue,
  joinOpen,
  manualCloseAllowed,
  scheduledCloseDue,
  ScheduleError,
  validateSchedule,
  type ScheduleState,
} from '../src/schedule.js';
import {
  MIN_DEALING_DURATION,
  MAX_DEALING_DURATION,
  P,
  Phase,
  PhaseMode,
  TAG_HASHES,
  TAG_PARTIAL_DATA,
  TE_A,
} from '../src/constants.js';
import { loadVectors, skipMsg, vp } from './helpers.js';
import type { Hex } from '../src/types.js';

// --- codec.json (§2.5) ---

interface CodecVectors {
  points: { name: string; point: string[]; compressed: Hex; onCurve: boolean; inPrimeSubgroup: boolean; identity: boolean }[];
  decodeRejections: { name: string; word: Hex; reason: DecodeRejection }[];
  authentication: {
    name: string;
    stored: Hex;
    supplied: string[];
    expect: 'ok' | 'NonCanonical' | 'InvalidPoint' | 'CompressedPointMismatch';
  }[];
  v2OfPMinus1: number;
}

const codec = loadVectors<CodecVectors>('codec');

describe.skipIf(!codec)(codec ? 'vectors: codec' : skipMsg('codec'), () => {
  const v = codec as CodecVectors;

  it('2-adicity of p − 1 (why Tonelli–Shanks, not (p+1)/4)', () => {
    let s = 0;
    let q = P - 1n;
    while ((q & 1n) === 0n) {
      q >>= 1n;
      s++;
    }
    expect(s).toBe(v.v2OfPMinus1);
  });

  it('every point compresses to its pinned word and round-trips', () => {
    for (const c of v.points) {
      const p = vp(c.point);
      expect(compressPoint(p), c.name).toBe(BigInt(c.compressed));
      expect(decompressPoint(BigInt(c.compressed)), c.name).toEqual(p);
      expect(isOnCurve(p), c.name).toBe(c.onCurve);
      expect(isInPrimeSubgroup(p), c.name).toBe(c.inPrimeSubgroup);
      expect(isIdentity(p), c.name).toBe(c.identity);
    }
  });

  it('every rejection word is refused for its stated reason', () => {
    const reasonPattern: Record<CodecVectors['decodeRejections'][number]['reason'], RegExp> = {
      bit254: /reserved bit 254/,
      xNotCanonical: /not canonical/,
      nonResidue: /non-residue/,
      zeroRootOddParity: /odd parity bit is not canonical/,
    };
    for (const c of v.decodeRejections) {
      expect(() => decompressPoint(BigInt(c.word)), c.name).toThrow(CodecError);
      expect(() => decompressPoint(BigInt(c.word)), c.name).toThrow(reasonPattern[c.reason]);
      try {
        decompressPoint(BigInt(c.word));
      } catch (err) {
        expect((err as CodecError).reason, c.name).toBe(c.reason);
      }
    }
    // Both roots of 1/168700 (the order-4 points) are pinned with their odd parity.
    expect(v.decodeRejections.filter((c) => c.reason === 'zeroRootOddParity')).toHaveLength(2);
  });

  it('authentication of a supplied full point against a stored word, in check order', () => {
    for (const c of v.authentication) {
      expect(authenticateCompressed(BigInt(c.stored), vp(c.supplied)), c.name).toBe(c.expect);
    }
  });
});

// Not vector-driven: the audit's zero-root case (L-01), both roots of 1/168700 and both parities.
describe('codec: y² = 0 (order-4 points, protocol §2.5)', () => {
  const x4 = sqrtModP(invMod(TE_A, P)) as bigint;
  const AUDIT_X = 18930368022820495955728484915491405972470733850014661777449844430438130630919n;

  it('the audit x is one of the two roots', () => {
    expect([x4, P - x4]).toContain(AUDIT_X);
  });

  it.each([
    ['x4', () => x4],
    ['p − x4', () => P - x4],
  ])('%s: even parity decodes to (x, 0), odd parity is refused, never y = p', (_name, xOf) => {
    const x = xOf();
    expect(isOnCurve({ x, y: 0n })).toBe(true);
    expect(decompressPoint(x)).toEqual({ x, y: 0n });
    expect(compressPoint({ x, y: 0n })).toBe(x);
    let caught: unknown;
    try {
      decompressPoint(x | (1n << 255n));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CodecError);
    expect((caught as CodecError).reason).toBe('zeroRootOddParity');
    // The non-canonical point the old decoder returned is not even a valid encoding input.
    expect(() => compressPoint({ x, y: P })).toThrow(/canonical/);
  });
});

// --- partialdata.json (§10.2) ---

interface PartialDataCase {
  chainId: string;
  manager: Hex;
  ceremonyId: Hex;
  requestId: Hex;
  participantIndex: number;
  fieldCount: number;
  D: string[][];
  partialDataHash: Hex;
}

interface PartialDataVectors {
  tag: string;
  tagHash: Hex;
  preimageTypes: string[];
  base: PartialDataCase;
  mutations: (PartialDataCase & { name: string })[];
  scenarios: {
    name: string;
    chainId: string;
    manager: Hex;
    ceremonyId: Hex;
    requestId: Hex;
    fieldCount: number;
    partials: { index: number; D: string[][]; partialDataHash: Hex }[];
  }[];
}

const partialdata = loadVectors<PartialDataVectors>('partialdata');

describe.skipIf(!partialdata)(partialdata ? 'vectors: partialdata' : skipMsg('partialdata'), () => {
  const v = partialdata as PartialDataVectors;

  const hashOf = (c: PartialDataCase): Hex =>
    partialDataHash({
      chainId: BigInt(c.chainId),
      manager: c.manager,
      ceremonyId: c.ceremonyId,
      requestId: c.requestId,
      participantIndex: c.participantIndex,
      fieldCount: c.fieldCount,
      D: c.D.map(vp),
    });

  it('tag, tag hash and preimage layout are pinned', () => {
    expect(v.tag).toBe(TAG_PARTIAL_DATA);
    expect(v.tagHash).toBe(TAG_HASHES[TAG_PARTIAL_DATA]);
    expect(keccak256(toBytes(v.tag))).toBe(v.tagHash);
    expect(v.preimageTypes).toEqual([
      'bytes32', // the tag hash prepended by taggedHash
      'uint256', // chainId
      'address', // manager
      'bytes12', // ceremonyId
      'bytes32', // requestId
      'uint8', // participantIndex
      'uint8', // fieldCount
      'uint256[2][16]', // D, identity padded
    ]);
  });

  it('the base commitment reproduces bit-for-bit', () => {
    expect(hashOf(v.base)).toBe(v.base.partialDataHash);
  });

  it('every mutation reproduces its own hash and differs from the base', () => {
    for (const m of v.mutations) {
      expect(hashOf(m), m.name).toBe(m.partialDataHash);
      expect(m.partialDataHash, m.name).not.toBe(v.base.partialDataHash);
    }
  });

  it('every scenario partial reproduces bit-for-bit', () => {
    for (const sc of v.scenarios) {
      for (const p of sc.partials) {
        expect(
          hashOf({
            chainId: sc.chainId,
            manager: sc.manager,
            ceremonyId: sc.ceremonyId,
            requestId: sc.requestId,
            participantIndex: p.index,
            fieldCount: sc.fieldCount,
            D: p.D,
            partialDataHash: p.partialDataHash,
          }),
          `${sc.name}#${p.index}`,
        ).toBe(p.partialDataHash);
      }
    }
  });
});

// --- schedule.json (§8.1–§8.4, §8.7) ---

interface CreateCase {
  name: string;
  now: string;
  threshold: number;
  registrationMode: number;
  registrationDeadline: string;
  dealingDuration: string;
  decryptionMode: number;
  decryptionOpenAt: string;
  manualDecryptionFallbackAt: string;
  expect: string;
}

interface RegistrationCase {
  name: string;
  registrationMode: number;
  registrationDeadline: string;
  dealingDuration: string;
  threshold: number;
  joined: number;
  now: string;
  expect: {
    join: string;
    closeRegistration: string;
    closeRegistrationScheduled: string;
    abort: string;
    scheduledRegistrationCloseDue: boolean;
    dealingDeadline: { closeRegistration: string | null; closeRegistrationScheduled: string | null };
  };
}

interface DealingCase {
  name: string;
  dealingDeadline: string;
  threshold: number;
  n: number;
  dealt: number;
  now: string;
  expect: { deal: string; finalize: string; abort: string };
}

interface DecryptionCase {
  name: string;
  decryptionMode: number;
  decryptionOpenAt: string;
  manualDecryptionFallbackAt: string;
  manualOpenedAt: string;
  now: string;
  expect: { isDecryptionOpen: boolean; openDecryption: string };
}

interface ScheduleVectors {
  phaseModes: { Manual: number; Scheduled: number };
  minDealingDuration: number;
  maxDealingDuration: number;
  create: CreateCase[];
  registration: RegistrationCase[];
  dealing: DealingCase[];
  decryption: DecryptionCase[];
}

const schedule = loadVectors<ScheduleVectors>('schedule');

const baseState: ScheduleState = {
  phase: Phase.Registration,
  registrationMode: PhaseMode.Manual,
  decryptionMode: PhaseMode.Manual,
  registrationDeadline: 0n,
  dealingDuration: 0n,
  decryptionOpenAt: 0n,
  manualDecryptionFallbackAt: 0n,
  manualOpenedAt: 0n,
  dealingDeadline: 0n,
  joinedCount: 0,
  threshold: 0,
  n: 0,
  qualCount: 0,
};

describe.skipIf(!schedule)(schedule ? 'vectors: schedule' : skipMsg('schedule'), () => {
  const v = schedule as ScheduleVectors;

  it('mode encoding and the duration floor are pinned', () => {
    expect(v.phaseModes).toEqual({ Manual: PhaseMode.Manual, Scheduled: PhaseMode.Scheduled });
    expect(BigInt(v.minDealingDuration)).toBe(MIN_DEALING_DURATION);
    expect(BigInt(v.maxDealingDuration)).toBe(MAX_DEALING_DURATION);
  });

  it('creation rules: validateSchedule mirrors the contract error selection', () => {
    for (const c of v.create) {
      let got = 'ok';
      try {
        validateSchedule(
          {
            registrationMode: c.registrationMode,
            decryptionMode: c.decryptionMode,
            registrationDeadline: BigInt(c.registrationDeadline),
            dealingDuration: BigInt(c.dealingDuration),
            decryptionOpenAt: BigInt(c.decryptionOpenAt),
            manualDecryptionFallbackAt: BigInt(c.manualDecryptionFallbackAt),
          },
          BigInt(c.now),
        );
      } catch (err) {
        if (!(err instanceof ScheduleError)) throw err;
        got = err.code;
      }
      expect(got, c.name).toBe(c.expect);
    }
  });

  it('registration predicates: join, manual close, scheduled close, abort, deadlines', () => {
    for (const c of v.registration) {
      const s: ScheduleState = {
        ...baseState,
        phase: Phase.Registration,
        registrationMode: c.registrationMode,
        registrationDeadline: BigInt(c.registrationDeadline),
        dealingDuration: BigInt(c.dealingDuration),
        joinedCount: c.joined,
        threshold: c.threshold,
      };
      const now = BigInt(c.now);
      expect(joinOpen(s, now), `${c.name}: join`).toBe(c.expect.join === 'ok');
      expect(manualCloseAllowed(s, now), `${c.name}: closeRegistration`).toBe(c.expect.closeRegistration === 'ok');
      expect(scheduledCloseDue(s, now), `${c.name}: due`).toBe(c.expect.scheduledRegistrationCloseDue);
      expect(scheduledCloseDue(s, now), `${c.name}: closeRegistrationScheduled`).toBe(
        c.expect.closeRegistrationScheduled === 'ok',
      );
      expect(abortDue(s, now), `${c.name}: abort`).toBe(c.expect.abort === 'ok');
      const dl = c.expect.dealingDeadline;
      if (dl.closeRegistration !== null) {
        expect(now + s.dealingDuration, `${c.name}: manual close deadline`).toBe(BigInt(dl.closeRegistration));
      }
      if (dl.closeRegistrationScheduled !== null) {
        expect(s.registrationDeadline + s.dealingDuration, `${c.name}: scheduled close deadline`).toBe(
          BigInt(dl.closeRegistrationScheduled),
        );
      }
      expect(dl.closeRegistration !== null, `${c.name}: deadline iff ok`).toBe(c.expect.closeRegistration === 'ok');
      expect(dl.closeRegistrationScheduled !== null, `${c.name}: deadline iff ok`).toBe(
        c.expect.closeRegistrationScheduled === 'ok',
      );
    }
  });

  it('dealing predicates: deal, finalize, abort', () => {
    for (const c of v.dealing) {
      const s: ScheduleState = {
        ...baseState,
        phase: Phase.Dealing,
        dealingDeadline: BigInt(c.dealingDeadline),
        threshold: c.threshold,
        n: c.n,
        qualCount: c.dealt,
      };
      const now = BigInt(c.now);
      expect(dealOpen(s, now), `${c.name}: deal`).toBe(c.expect.deal === 'ok');
      expect(finalizeDue(s, now), `${c.name}: finalize`).toBe(c.expect.finalize === 'ok');
      expect(abortDue(s, now), `${c.name}: abort`).toBe(c.expect.abort === 'ok');
    }
  });

  it('decryption gate: isDecryptionOpen and openDecryption', () => {
    for (const c of v.decryption) {
      const s: ScheduleState = {
        ...baseState,
        phase: Phase.Live,
        decryptionMode: c.decryptionMode,
        decryptionOpenAt: BigInt(c.decryptionOpenAt),
        manualDecryptionFallbackAt: BigInt(c.manualDecryptionFallbackAt),
        manualOpenedAt: BigInt(c.manualOpenedAt),
      };
      const now = BigInt(c.now);
      const open = decryptionOpenAt(s, now);
      expect(open, `${c.name}: isDecryptionOpen`).toBe(c.expect.isDecryptionOpen);
      const openAllowed = s.decryptionMode === PhaseMode.Manual && !open;
      expect(openAllowed, `${c.name}: openDecryption`).toBe(c.expect.openDecryption === 'ok');
      if (c.expect.openDecryption === 'WrongMode') expect(s.decryptionMode).toBe(PhaseMode.Scheduled);
      if (c.expect.openDecryption === 'AlreadyOpen') expect(open).toBe(true);
    }
  });
});
