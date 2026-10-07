/**
 * Unit tests for the v2 additions that the vector files do not already pin:
 * codec edge behavior, schedule validation ordering and status lines,
 * partialDataHash padding, and the §10.4 D-vector sourcing order.
 */

import { describe, expect, it } from 'vitest';
import { authenticateCompressed, compressPoint, decompressPoint, CodecError } from '../src/codec.js';
import { G, IDENTITY, mulBase } from '../src/curve.js';
import { P, Phase, PhaseMode } from '../src/constants.js';
import { partialDataHash } from '../src/partial.js';
import {
  partialVectorCacheKey,
  sourcePartialVectors,
  type PartialVectorSource,
} from '../src/combine.js';
import {
  ScheduleError,
  scheduleStatus,
  validateCreateBounds,
  validateSchedule,
  type ScheduleState,
} from '../src/schedule.js';
import type { Hex, PartialCommitment, Point } from '../src/types.js';

describe('codec units', () => {
  it('compressPoint rejects off-curve and non-canonical points', () => {
    expect(() => compressPoint({ x: 1n, y: 2n })).toThrow(CodecError);
    expect(() => compressPoint({ x: G.x + P, y: G.y })).toThrow(/canonical/);
  });

  it('decompress(compress) round-trips the order-two point to (0, p-1)', () => {
    expect(decompressPoint(compressPoint({ x: 0n, y: P - 1n }))).toEqual({ x: 0n, y: P - 1n });
  });

  it('authenticateCompressed checks canonicality before the curve and the word last', () => {
    const stored = compressPoint(G);
    // Non-canonical AND off-curve: NonCanonical wins.
    expect(authenticateCompressed(stored, { x: P, y: 2n })).toBe('NonCanonical');
    // Canonical but off-curve: InvalidPoint, even though the word would mismatch too.
    expect(authenticateCompressed(stored, { x: 1n, y: 2n })).toBe('InvalidPoint');
    // Valid point, wrong word.
    expect(authenticateCompressed(stored, mulBase(2n))).toBe('CompressedPointMismatch');
    expect(authenticateCompressed(stored, G)).toBe('ok');
  });
});

describe('schedule units', () => {
  const manual = {
    registrationMode: PhaseMode.Manual,
    decryptionMode: PhaseMode.Manual,
    registrationDeadline: 0n,
    dealingDuration: 3600n,
    decryptionOpenAt: 0n,
    manualDecryptionFallbackAt: 0n,
  };

  it('BadDuration wins over BadSchedule (contract check order)', () => {
    try {
      validateSchedule({ ...manual, dealingDuration: 599n, registrationMode: 7 }, 1000n);
      expect.unreachable();
    } catch (err) {
      expect((err as ScheduleError).code).toBe('BadDuration');
    }
  });

  it('validateCreateBounds mirrors threshold/invite errors', () => {
    expect(() => validateCreateBounds(0, ['0xaa'])).toThrow(/BadThreshold/);
    expect(() => validateCreateBounds(17, ['0xaa'])).toThrow(/BadThreshold/);
    expect(() => validateCreateBounds(2, [])).toThrow(/NoInvites/);
    expect(() => validateCreateBounds(2, Array.from({ length: 65 }, (_, i) => `0x${i}`))).toThrow(/TooManyInvites/);
    expect(() => validateCreateBounds(2, ['0xAA', '0xaa'])).toThrow(/duplicate/);
    expect(() => validateCreateBounds(2, ['0xaa', '0xbb'])).not.toThrow();
  });

  it('scheduleStatus yields one honest line per phase', () => {
    const base: ScheduleState = {
      ...manual,
      phase: Phase.Registration,
      manualOpenedAt: 0n,
      dealingDeadline: 0n,
      joinedCount: 1,
      threshold: 2,
      n: 3,
      qualCount: 0,
    };
    expect(scheduleStatus(base, 1000n)).toMatch(/registration open until the organizer closes it/);
    expect(scheduleStatus({ ...base, phase: Phase.Dealing, dealingDeadline: 2000n }, 1000n)).toMatch(/dealing in progress/);
    expect(scheduleStatus({ ...base, phase: Phase.Live }, 1000n)).toMatch(/only when the organizer opens it/);
    expect(scheduleStatus({ ...base, phase: Phase.Live, manualOpenedAt: 1n }, 1000n)).toBe('live: decryption is open');
    expect(
      scheduleStatus(
        { ...base, phase: Phase.Live, decryptionMode: PhaseMode.Scheduled, decryptionOpenAt: 2000n },
        1000n,
      ),
    ).toMatch(/policy, not a cryptographic time lock/);
    expect(scheduleStatus({ ...base, phase: Phase.Aborted }, 1000n)).toBe('aborted');
  });
});

describe('partialDataHash units', () => {
  it('refuses an unpadded D vector', () => {
    expect(() =>
      partialDataHash({
        chainId: 1n,
        manager: '0x1111111111111111111111111111111111111111',
        ceremonyId: '0x111111111111111111111111',
        requestId: `0x${'22'.repeat(32)}`,
        participantIndex: 1,
        fieldCount: 1,
        D: [G],
      }),
    ).toThrow(/padded to 16/);
  });
});

describe('sourcePartialVectors (§10.4 sourcing order)', () => {
  const chainId = 31337n;
  const manager: Hex = '0x1111111111111111111111111111111111111111';
  const ceremonyId: Hex = '0x111111111111111111111111';
  const requestId: Hex = `0x${'22'.repeat(32)}`;
  const fieldCount = 1;
  const dOf = (i: number): Point[] => [mulBase(BigInt(i + 10)), ...Array.from({ length: 15 }, () => IDENTITY)];
  const hashOf = (i: number, D = dOf(i)): Hex =>
    partialDataHash({ chainId, manager, ceremonyId, requestId, participantIndex: i, fieldCount, D });

  const world = (over: {
    commitments?: Record<number, PartialCommitment>;
    published?: Record<number, Point[] | undefined>;
    fetches?: number[];
  }): PartialVectorSource => ({
    getPartialCommitment: (_rid, i) =>
      Promise.resolve(
        over.commitments?.[i] ?? { accepted: true, dataHash: hashOf(i), publishedBlock: 100n },
      ),
    fetchPublishedVector: (_rid, i, _block) => {
      over.fetches?.push(i);
      return Promise.resolve(over.published && i in over.published ? over.published[i] : dOf(i));
    },
  });

  const run = (source: PartialVectorSource, memberSet: number[], cache?: Map<string, Point[]>) =>
    sourcePartialVectors({ chainId, manager, ceremonyId, requestId, fieldCount, memberSet, source, cache });

  it('uses a verified cache hit without fetching, and caches a verified fetch', async () => {
    const cache = new Map<string, Point[]>();
    cache.set(partialVectorCacheKey(chainId, manager, requestId, 1, hashOf(1)), dOf(1));
    const fetches: number[] = [];
    const { vectors, missing } = await run(world({ fetches }), [1, 2], cache);
    expect(missing).toEqual([]);
    expect(vectors.get(1)).toEqual(dOf(1));
    expect(vectors.get(2)).toEqual(dOf(2));
    expect(fetches).toEqual([2]); // 1 came from the cache
    expect(cache.get(partialVectorCacheKey(chainId, manager, requestId, 2, hashOf(2)))).toEqual(dOf(2));
  });

  it('ignores a poisoned cache entry and re-fetches', async () => {
    const cache = new Map<string, Point[]>();
    cache.set(partialVectorCacheKey(chainId, manager, requestId, 1, hashOf(1)), dOf(9)); // wrong vector
    const fetches: number[] = [];
    const { vectors, missing } = await run(world({ fetches }), [1], cache);
    expect(missing).toEqual([]);
    expect(vectors.get(1)).toEqual(dOf(1));
    expect(fetches).toEqual([1]);
  });

  it('a fetched vector whose hash mismatches the stored commitment lands in missing', async () => {
    const { vectors, missing } = await run(world({ published: { 1: dOf(9) } }), [1]);
    expect(vectors.size).toBe(0);
    expect(missing).toEqual([1]);
  });

  it('an unavailable log (undefined fetch) lands in missing', async () => {
    const { missing } = await run(world({ published: { 1: undefined } }), [1]);
    expect(missing).toEqual([1]);
  });

  it('a rejected historical read (history pruned) is a missing vector, not an error (M-01)', async () => {
    const source: PartialVectorSource = {
      ...world({}),
      fetchPublishedVector: () => Promise.reject(new Error('history pruned')),
    };
    const cache = new Map<string, Point[]>();
    cache.set(partialVectorCacheKey(chainId, manager, requestId, 2, hashOf(2)), dOf(2));
    const { vectors, missing, unavailable } = await run(source, [1, 2, 3], cache);
    expect(missing).toEqual([1, 3]);
    expect(unavailable).toEqual([1, 3]);
    expect([...vectors.keys()]).toEqual([2]); // the cache still serves
  });

  it('an authenticated commitment read that fails still propagates', async () => {
    const source: PartialVectorSource = {
      ...world({}),
      getPartialCommitment: () => Promise.reject(new Error('RPC providers disagree')),
    };
    await expect(run(source, [1])).rejects.toThrow(/disagree/);
  });

  it('a member without an admitted partial is a hard error', async () => {
    const commitments = { 1: { accepted: false, dataHash: hashOf(1), publishedBlock: 0n } };
    await expect(run(world({ commitments }), [1])).rejects.toThrow(/member 1 has no admitted partial/);
  });
});
