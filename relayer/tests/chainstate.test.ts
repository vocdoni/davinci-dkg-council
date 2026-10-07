import { describe, expect, it } from 'vitest';
import { addPoints, compressPoint, mulBase, P, type Action, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { ChainState, MalformedPointError } from '../src/chainstate.js';
import { RelayError } from '../src/errors.js';
import { ceremonyIdOf, encryptAll, MANAGER, MockChain, requestIdOf, testKey } from './mockchain.js';
import { stack } from './stack.js';

/** x with y² = 0 (an order-4 point): only y = 0 is canonical, so the odd parity bit would mean y = p. */
const ZERO_ROOT_X = 18930368022820495955728484915491405972470733850014661777449844430438130630919n;
const ORDER_TWO = { x: 0n, y: P - 1n };

/** Words a corrupted or hostile RPC could serve for a stored point. */
const MALFORMED: [string, bigint, RegExp][] = [
  ['an odd parity on a zero root (y = p)', ZERO_ROOT_X | (1n << 255n), /zeroRootOddParity/],
  ['bit 254 set', (1n << 254n) | 5n, /bit254/],
  ['x >= p', P + 3n, /xNotCanonical/],
  ['the order-two point', compressPoint(ORDER_TWO), /prime-order subgroup/],
  ['a torsion-shifted key', compressPoint(addPoints(mulBase(5n), ORDER_TWO)), /prime-order subgroup/],
  ['the identity', compressPoint({ x: 0n, y: 1n }), /identity/],
];

describe('stored point words: strict decoding, prime subgroup, nothing poisoned', () => {
  const CID = ceremonyIdOf(1);
  const RID = requestIdOf(1);

  function setup() {
    const chain = new MockChain();
    chain.addCeremony(CID, { phase: 3, threshold: 2, n: 2 });
    const { cts } = encryptAll(testKey(2, 2).P, [1n]);
    chain.addRequest(RID, CID, cts);
    const c1 = compressPoint({ x: cts[0]?.[0] as bigint, y: cts[0]?.[1] as bigint });
    return { chain, state: new ChainState(chain.client, MANAGER), cts, c1 };
  }

  it.each(MALFORMED)('refuses %s, then decodes the true word', async (_, word, why) => {
    const { chain, state, cts, c1 } = setup();
    chain.manager.wordOverride.request.set(RID, [[c1, word]]);
    const err = await state.requestPoints(RID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedPointError);
    expect((err as MalformedPointError).detail).toMatch(why);
    chain.manager.wordOverride.request.delete(RID);
    expect((await state.requestPoints(RID)).c2).toEqual([{ x: cts[0]?.[2], y: cts[0]?.[3] }]);
  });

  it('refuses a malformed roster key, and never caches the roster it belongs to', async () => {
    const { chain, state } = setup();
    chain.manager.wordOverride.participant.set(`${CID}:2`, ZERO_ROOT_X | (1n << 255n));
    expect(await state.rosterKeys(CID).catch((e: unknown) => e)).toBeInstanceOf(MalformedPointError);
    chain.manager.wordOverride.participant.clear();
    expect(await state.rosterKeys(CID)).toHaveLength(2);
  });

  it('a relayed action whose rebuilt point is malformed is refused, never sent', async () => {
    const s = stack();
    s.chain.addCeremony(CID, { phase: 3, threshold: 2, n: 2 });
    const { cts } = encryptAll(testKey(2, 2).P, [1n]);
    s.chain.addRequest(RID, CID, cts);
    s.chain.manager.wordOverride.request.set(RID, [[compressPoint(ORDER_TWO), 1n]]);
    const partial: Action = {
      kind: 'submitPartial',
      message: { ceremonyId: CID, requestId: RID, participantIndex: 1, payloadHash: `0x${'cc'.repeat(32)}` as Hex, validUntil: 9n },
      signature: `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`,
      payload: { D: Array(16).fill({ x: 0n, y: 1n }), proof: { pA: [1n, 2n], pB: [[3n, 4n], [5n, 6n]], pC: [7n, 8n] } },
    };
    const err = await s.sponsor.sponsor(partial, { source: 'http' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('INTERNAL');
    expect(s.chain.sentRaw).toHaveLength(0);
  });
});
