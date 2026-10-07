import { describe, expect, it } from 'vitest';
import {
  ceremonyId,
  COUNCIL_MANAGER_ABI,
  G,
  IDENTITY,
  type Action,
  type Groth16Proof,
  type Hex,
} from '@vocdoni/davinci-dkg-council-sdk';
import { decodeFunctionData, parseTransaction, toFunctionSelector } from 'viem';
import { RelayError } from '../src/errors.js';
import {
  ceremonyIdOf,
  encryptAll,
  MANAGER,
  MEMBER_KEYS,
  pad,
  partialOf,
  requestIdOf,
  rpcError,
  testKey,
  type MockChain,
} from './mockchain.js';
import { stack } from './stack.js';

const SIG: Hex = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
const PROOF: Groth16Proof = { pA: [1n, 2n], pB: [[3n, 4n], [5n, 6n]], pC: [7n, 8n] };
const ORG_A: Hex = '0x00000000000000000000000000000000000000a1';
const ORG_B: Hex = '0x00000000000000000000000000000000000000b2';
const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;
const CID = ceremonyIdOf(1);
const HTTP = { source: 'http' } as const;

const create = (organizer: Hex, nonce: bigint, invites = 2): Action => ({
  kind: 'createCeremony',
  message: {
    organizer,
    nonce,
    threshold: 2,
    registrationMode: 1,
    registrationDeadline: 2_000_000_000n,
    dealingDuration: 600n,
    decryptionMode: 0,
    decryptionOpenAt: 0n,
    manualDecryptionFallbackAt: 2_100_000_000n,
    inviteKeys: Array.from({ length: invites }, (_, i) => addr(0x1000 + i)),
    validUntil: 2_000_000_000n,
  },
  signature: SIG,
});

/** A join with its own participant and (by default) its own key; the fake manager does not check keys. */
const join = (cid: Hex, inviteId: number, pkX: bigint = G.x + BigInt(inviteId)): Action => ({
  kind: 'join',
  message: { ceremonyId: cid, participant: addr(0x2000 + inviteId), inviteId, pkX, pkY: G.y, popAx: 1n, popAy: 2n, popZ: 3n, validUntil: 9n },
  signature: SIG,
  invite: { ceremonyId: cid, inviteId, participant: addr(0x2000 + inviteId), pkX, pkY: G.y, validUntil: 9n },
  inviteSignature: SIG,
});

const close = (cid: Hex, validUntil: bigint): Action => ({
  kind: 'closeRegistration',
  message: { ceremonyId: cid, participantCount: 3, validUntil },
  signature: SIG,
});

const deal = (cid: Hex, dealerIndex: number): Action => ({
  kind: 'deal',
  message: { ceremonyId: cid, dealerIndex, payloadHash: `0x${'aa'.repeat(32)}`, validUntil: 9n },
  signature: SIG,
  payload: { C: Array(16).fill(IDENTITY), E: G, masked: Array(16).fill(0n), proof: PROOF },
});

const partial = (cid: Hex, rid: Hex, participantIndex: number): Action => ({
  kind: 'submitPartial',
  message: { ceremonyId: cid, requestId: rid, participantIndex, payloadHash: `0x${'cc'.repeat(32)}`, validUntil: 9n },
  signature: SIG,
  payload: { D: Array(16).fill(IDENTITY), proof: PROOF },
});

const grant = (kind: 'allowAdapter' | 'authorizeCreator', cid: Hex, who: Hex): Action =>
  kind === 'allowAdapter'
    ? { kind, message: { ceremonyId: cid, adapter: who, validUntil: 9n }, signature: SIG }
    : { kind, message: { ceremonyId: cid, creator: who, validUntil: 9n }, signature: SIG };

/** Far ahead of the mock chain's clock. */
const FAR = 2_000_000_000n;

/** A ceremony whose joined members can be closed (Manual registration, no expiry). */
const registration = (chain: MockChain, cid: Hex, joined = 3) =>
  chain.addCeremony(cid, { phase: 1, threshold: 2, n: 0, joined, qual: 0 });

/** A Live ceremony with one request of `values` and accepted partials from `members`. */
function liveRequest(chain: MockChain, cid: Hex, rid: Hex, values: bigint[], members: number[], t = 2, n = 3) {
  chain.addCeremony(cid, { phase: 3, threshold: t, n });
  const key = testKey(t, n);
  const { cts, c1s } = encryptAll(key.P, values);
  chain.addRequest(rid, cid, cts);
  const vectors = new Map<number, ReturnType<typeof pad>>();
  for (const i of members) {
    const D = pad(partialOf(key.shares.get(i) as bigint, c1s));
    chain.addPartial(rid, i, D);
    vectors.set(i, D);
  }
  return { key, cts, c1s, vectors };
}

/** Calldata of every transaction sent, decoded. */
const sentCalls = (chain: MockChain) =>
  chain.sentRaw.map((raw) => decodeFunctionData({ abi: COUNCIL_MANAGER_ABI, data: parseTransaction(raw).data as Hex }));

const errorOf = async (p: Promise<unknown>): Promise<RelayError> => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RelayError);
  return err as RelayError;
};

describe('sponsorship quotas (protocol bounds)', () => {
  it('sponsors at most 16 joins and 16 deals per ceremony', async () => {
    const { chain, sponsor, sender } = stack();
    for (let i = 0; i < 16; i++) await sponsor.sponsor(join(CID, i), HTTP);
    const err = await errorOf(sponsor.sponsor(join(CID, 16), HTTP));
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.status).toBe(429);
    const dealing = { phase: 2, threshold: 2, n: 16, qual: 0, dealingDeadline: FAR };
    chain.addCeremony(CID, dealing);
    for (let j = 1; j <= 16; j++) await sponsor.sponsor(deal(CID, j), HTTP);
    await sender.tick(); // settled: an identical action no longer resolves to its pending transaction
    chain.addCeremony(CID, dealing); // even if the chain would accept a dealing again
    expect((await errorOf(sponsor.sponsor(deal(CID, 1), HTTP))).code).toBe('QUOTA_EXCEEDED');
    expect(chain.sentRaw).toHaveLength(32);
  });

  it('reserves every piece of one-shot join state: invite, participant and key', async () => {
    const { sponsor, sender } = stack({ automine: false });
    await sponsor.sponsor(join(CID, 0, 777n), HTTP);
    // Another invite and participant, the same key: only one join can ever land.
    const err = await errorOf(sponsor.sponsor(join(CID, 1, 777n), HTTP));
    expect(err.code).toBe('CONFLICT');
    expect(err.detail).toContain(`cer:${CID}:key:777:`);
    await sponsor.sponsor(join(CID, 2), HTTP);
    expect(sender.pendingCount).toBe(2);
  });

  it('sponsors close, finalize and abort once each, whatever variant is signed', async () => {
    const { chain, sponsor, sender } = stack();
    registration(chain, CID);
    await sponsor.sponsor(close(CID, 9n), HTTP);
    await sender.tick();
    expect(chain.manager.ceremonies.get(CID)?.phase).toBe(2);
    registration(chain, CID); // even if the chain would accept a close again
    expect((await errorOf(sponsor.sponsor(close(CID, 10n), HTTP))).code).toBe('QUOTA_EXCEEDED');
    chain.addCeremony(CID, { phase: 2, threshold: 2, n: 3 });
    await sponsor.sponsor({ kind: 'finalize', ceremonyId: CID }, HTTP);
    await sender.tick();
    chain.addCeremony(CID, { phase: 2, threshold: 2, n: 3 }); // even if the chain would accept it again
    expect((await errorOf(sponsor.sponsor({ kind: 'finalize', ceremonyId: CID }, HTTP))).code).toBe('QUOTA_EXCEEDED');
  });

  it('bounds invites at 64 across createCeremony and addInvites', async () => {
    const { sponsor } = stack();
    const c = create(ORG_A, 7n, 60);
    const cid = ceremonyId(31337n, MANAGER, ORG_A, 7n);
    await sponsor.sponsor(c, HTTP);
    const add = (first: number, n: number): Action => ({
      kind: 'addInvites',
      message: { ceremonyId: cid, firstInviteId: first, inviteKeys: Array.from({ length: n }, (_, i) => addr(0x3000 + first + i)), validUntil: 9n },
      signature: SIG,
    });
    expect((await errorOf(sponsor.sponsor(add(60, 5), HTTP))).code).toBe('QUOTA_EXCEEDED');
    await sponsor.sponsor(add(60, 4), HTTP);
  });

  it('bounds grants (allowAdapter + authorizeCreator) per ceremony by COUNCIL_MAX_GRANTS', async () => {
    const { sponsor } = stack({ policy: { maxGrantsPerCeremony: 2 } });
    await sponsor.sponsor(grant('allowAdapter', CID, addr(1)), HTTP);
    await sponsor.sponsor(grant('authorizeCreator', CID, addr(2)), HTTP);
    expect((await errorOf(sponsor.sponsor(grant('allowAdapter', CID, addr(3)), HTTP))).code).toBe('QUOTA_EXCEEDED');
  });

  it('sponsors at most n partials per request', async () => {
    const { chain, sponsor, sender } = stack();
    const rid = requestIdOf(1);
    liveRequest(chain, CID, rid, [5n], []);
    for (let i = 1; i <= 3; i++) await sponsor.sponsor(partial(CID, rid, i), HTTP);
    await sender.tick();
    chain.manager.requests.get(rid)?.hashes.clear(); // even if the chain would accept them again
    expect((await errorOf(sponsor.sponsor(partial(CID, rid, 1), HTTP))).code).toBe('QUOTA_EXCEEDED');
  });

  it('bounds combined fields per request by its fieldCount (one retry each)', async () => {
    const { chain, sponsor, sender } = stack();
    const rid = requestIdOf(2);
    const { vectors } = liveRequest(chain, CID, rid, [9n], [1, 2], 2, 2);
    chain.holdFinalized();
    const combine: Action = {
      kind: 'combine',
      requestId: rid,
      memberSet: [1, 2],
      fieldIndexes: [0],
      plaintexts: [9n],
      partialVectors: [vectors.get(1), vectors.get(2)] as ReturnType<typeof pad>[],
    };
    for (let round = 0; round < 2; round++) {
      await sponsor.sponsor(combine, HTTP);
      await sender.tick();
      chain.rollback(); // a reorg undoes the combine
    }
    expect((await errorOf(sponsor.sponsor(combine, HTTP))).code).toBe('QUOTA_EXCEEDED');
  });

  it('charges nothing for an action that fails simulation or broadcast', async () => {
    const { chain, sponsor } = stack({ policy: { ceremonyRatePerMinute: 1 } });
    registration(chain, CID);
    chain.manager.forced.set('closeRegistration', 'Expired');
    expect((await errorOf(sponsor.sponsor(close(CID, 9n), HTTP))).code).toBe('SIMULATION_REVERTED');
    chain.manager.forced.delete('closeRegistration');
    chain.failNextSend = rpcError(-32000, 'insufficient funds for gas * price + value');
    expect((await errorOf(sponsor.sponsor(close(CID, 9n), HTTP))).code).toBe('TX_FAILED');
    // Neither the quota nor the per-ceremony rate was consumed.
    await sponsor.sponsor(close(CID, 9n), HTTP);
    expect((await errorOf(sponsor.sponsor(join(CID, 0), HTTP))).code).toBe('RATE_LIMITED');
  });
});

describe('createCeremony admission', () => {
  it('open mode: anyone, capped per organizer per rolling 24 h', async () => {
    const { sponsor, advance } = stack({ policy: { organizerDailyCeremonies: 2 } });
    await sponsor.sponsor(create(ORG_B, 1n), HTTP);
    await sponsor.sponsor(create(ORG_B, 2n), HTTP);
    expect((await errorOf(sponsor.sponsor(create(ORG_B, 3n), HTTP))).code).toBe('QUOTA_EXCEEDED');
    await sponsor.sponsor(create(ORG_A, 3n), HTTP);
    advance(24 * 3_600_000 + 1);
    await sponsor.sponsor(create(ORG_B, 3n), HTTP);
  });

  it('allow-list: only listed organizers create; other ceremonies are not sponsored', async () => {
    const { chain, sponsor } = stack({ policy: { organizerAllowlist: [ORG_A] } });
    const denied = await errorOf(sponsor.sponsor(create(ORG_B, 1n), HTTP));
    expect(denied.code).toBe('UNAUTHORIZED');
    expect(denied.status).toBe(401);
    await sponsor.sponsor(create(ORG_A, 1n), HTTP);
    await sponsor.sponsor(join(ceremonyId(31337n, MANAGER, ORG_A, 1n), 0), HTTP);
    // Created elsewhere: sponsored only when its on-chain organizer is listed.
    chain.addCeremony(ceremonyIdOf(5), { phase: 1, threshold: 2, n: 0, organizer: ORG_B });
    chain.addCeremony(ceremonyIdOf(6), { phase: 1, threshold: 2, n: 0, organizer: ORG_A });
    expect((await errorOf(sponsor.sponsor(join(ceremonyIdOf(5), 0), HTTP))).code).toBe('NOT_SPONSORED');
    await sponsor.sponsor(join(ceremonyIdOf(6), 0), HTTP);
    expect((await errorOf(sponsor.sponsor(join(ceremonyIdOf(7), 0), HTTP))).code).toBe('NOT_SPONSORED');
  });

  it('API token: a bearer token admits a createCeremony and its ceremony', async () => {
    const token = 'council-test-token-0123456789';
    const { chain, sponsor } = stack({ policy: { apiTokens: [token] } });
    expect((await errorOf(sponsor.sponsor(create(ORG_B, 1n), HTTP))).code).toBe('UNAUTHORIZED');
    expect((await errorOf(sponsor.sponsor(create(ORG_B, 1n), { source: 'http', token: 'wrong-token-0123456789' }))).code).toBe(
      'UNAUTHORIZED',
    );
    expect(chain.sentRaw).toHaveLength(0);
    await sponsor.sponsor(create(ORG_B, 1n), { source: 'http', token });
    await sponsor.sponsor(join(ceremonyId(31337n, MANAGER, ORG_B, 1n), 0), HTTP);
  });

  it('a failed chain read is a retryable INTERNAL error, never a NOT_SPONSORED denial', async () => {
    const { chain, sponsor } = stack({ policy: { organizerAllowlist: [ORG_A] } });
    chain.addCeremony(ceremonyIdOf(6), { phase: 1, threshold: 2, n: 0, organizer: ORG_A });
    chain.failNextCall = new Error('fetch failed: socket hang up');
    const err = await errorOf(sponsor.sponsor(join(ceremonyIdOf(6), 0), HTTP));
    expect(err.code).toBe('INTERNAL');
    expect(chain.sentRaw).toHaveLength(0);
    await sponsor.sponsor(join(ceremonyIdOf(6), 0), HTTP);
    chain.failNextCall = new Error('fetch failed: socket hang up');
    await expect(sponsor.admits(ceremonyIdOf(5))).rejects.toThrow(/could not verify/);
    // A bare JSON-RPC internal error (no revert data) is not an answer either.
    chain.failNextCall = rpcError(-32603, 'Internal error');
    await expect(sponsor.admits(ceremonyIdOf(5))).rejects.toThrow(/could not verify/);
    expect(await sponsor.admits(ceremonyIdOf(5))).toBe(false); // UnknownCeremony: a verified denial
  });

  it('restricted mode applies to the combine worker too', async () => {
    const { chain, sponsor } = stack({ policy: { organizerAllowlist: [ORG_A] } });
    chain.addCeremony(CID, { phase: 3, threshold: 1, n: 1, organizer: ORG_B });
    const key = testKey(1, 1);
    const { cts, c1s } = encryptAll(key.P, [4n]);
    chain.addRequest(requestIdOf(3), CID, cts);
    const D = pad(partialOf(key.shares.get(1) as bigint, c1s));
    chain.addPartial(requestIdOf(3), 1, D);
    const combine: Action = {
      kind: 'combine',
      requestId: requestIdOf(3),
      memberSet: [1],
      fieldIndexes: [0],
      plaintexts: [4n],
      partialVectors: [D],
    };
    expect((await errorOf(sponsor.sponsor(combine, { source: 'combiner' }))).code).toBe('NOT_SPONSORED');
  });
});

describe('v2 actions: points rebuilt from state, one-shot slots and quotas', () => {
  it('rebuilds the roster for both closes and deal from the stored compressed keys', async () => {
    const { chain, sponsor, sender } = stack();
    registration(chain, CID, 3);
    await sponsor.sponsor(close(CID, 9n), HTTP);
    const [closed] = sentCalls(chain);
    expect(closed?.functionName).toBe('closeRegistration');
    // The mock authenticates every key against its compressed word, like the contract.
    expect((closed?.args as readonly unknown[])[2]).toEqual(MEMBER_KEYS.slice(0, 3).map((k) => [k.x, k.y]));
    expect(chain.manager.ceremonies.get(CID)?.phase).toBe(2);
    await sender.tick();
    chain.addCeremony(CID, { phase: 2, threshold: 2, n: 3, qual: 0, dealingDeadline: FAR });
    await sponsor.sponsor(deal(CID, 2), HTTP);
    const dealt = sentCalls(chain)[1];
    expect((dealt?.args as readonly unknown[])[8]).toEqual(MEMBER_KEYS.slice(0, 3).map((k) => [k.x, k.y]));
    expect(chain.manager.ceremonies.get(CID)?.qual).toBe(0b010);
  });

  it('reads a replaced roster afresh (a reorg that re-closes the ceremony with other members)', async () => {
    const { chain, sponsor } = stack();
    const dealing = { phase: 2, threshold: 2, n: 3, qual: 0, dealingDeadline: FAR };
    chain.addCeremony(CID, dealing);
    await sponsor.sponsor(deal(CID, 1), HTTP);
    const other = [MEMBER_KEYS[5], MEMBER_KEYS[6], MEMBER_KEYS[7]] as typeof MEMBER_KEYS;
    chain.addCeremony(CID, { ...dealing, keys: other });
    await sponsor.sponsor(deal(CID, 2), HTTP);
    const roster = (sentCalls(chain)[1]?.args as readonly unknown[])[8];
    expect(roster).toEqual(other.map((k) => [k.x, k.y]));
  });

  it('closeRegistrationScheduled: roster from state, and one close per ceremony whichever path', async () => {
    const { chain, sponsor, sender } = stack();
    const cid = ceremonyIdOf(2);
    chain.addCeremony(cid, { phase: 1, threshold: 2, n: 0, joined: 4, qual: 0, registrationMode: 1, registrationDeadline: chain.now - 10n });
    await sponsor.sponsor({ kind: 'closeRegistrationScheduled', ceremonyId: cid }, HTTP);
    const c = chain.manager.ceremonies.get(cid);
    expect(c?.phase).toBe(2);
    expect(c?.n).toBe(4);
    // The schedule, not the caller, sets the dealing deadline (protocol §8.3).
    expect(c?.dealingDeadline).toBe((c?.registrationDeadline ?? 0n) + 600n);
    await sender.tick();
    chain.addCeremony(cid, { phase: 1, threshold: 2, n: 0, joined: 4, qual: 0, registrationMode: 0, registrationDeadline: 0n });
    const manual = { ...close(cid, 9n), message: { ceremonyId: cid, participantCount: 4, validUntil: 9n } } as Action;
    expect((await errorOf(sponsor.sponsor(manual, HTTP))).code).toBe('QUOTA_EXCEEDED');
  });

  it('a reverting rebuild read is the simulation answer, a transport failure is retryable', async () => {
    const { chain, sponsor } = stack();
    const unknown = await errorOf(sponsor.sponsor({ kind: 'closeRegistrationScheduled', ceremonyId: ceremonyIdOf(9) }, HTTP));
    expect(unknown.code).toBe('SIMULATION_REVERTED');
    expect(unknown.detail).toBe('UnknownCeremony()');
    registration(chain, CID);
    const orig = chain.request.bind(chain);
    // getParticipantCompressed fails in transit: INTERNAL, nothing charged or sent.
    const sel = toFunctionSelector('getParticipantCompressed(bytes12,uint8)');
    chain.request = async (method, params) => {
      if (method === 'eth_call' && JSON.stringify(params).includes(sel.slice(2))) throw new Error('fetch failed: socket hang up');
      return orig(method, params);
    };
    const err = await errorOf(sponsor.sponsor(close(CID, 9n), HTTP));
    expect(err.code).toBe('INTERNAL');
    expect(chain.sentRaw).toHaveLength(0);
    chain.request = orig;
    await sponsor.sponsor(close(CID, 9n), HTTP);
  });

  it('submitPartial: C1 rebuilt from the stored ciphertexts, D cached under its partial-data hash', async () => {
    const { chain, sponsor, policy } = stack();
    const rid = requestIdOf(4);
    const { key, c1s } = liveRequest(chain, CID, rid, [3n, 4n], []);
    const D = pad(partialOf(key.shares.get(2) as bigint, c1s));
    await sponsor.sponsor({ ...partial(CID, rid, 2), payload: { D, proof: PROOF } } as Action, HTTP);
    const [sent] = sentCalls(chain);
    expect((sent?.args as readonly unknown[])[6]).toEqual(c1s.map((p) => [p.x, p.y]));
    const [, dataHash] = [...(chain.manager.requests.get(rid)?.hashes ?? [])][0] ?? [];
    expect(policy.partials.has(rid, 2, dataHash as Hex)).toBe(true);
  });

  it('openDecryption once per ceremony; the chain refuses a second opening anyway', async () => {
    const { chain, sponsor, sender } = stack();
    chain.addCeremony(CID, { phase: 3, threshold: 2, n: 3, decryptionMode: 0, manualDecryptionFallbackAt: FAR });
    const open = (validUntil: bigint): Action => ({
      kind: 'openDecryption',
      message: { ceremonyId: CID, validUntil },
      signature: SIG,
    });
    await sponsor.sponsor(open(9n), HTTP);
    expect(chain.manager.ceremonies.get(CID)?.manualOpenedAt).toBe(chain.now);
    await sender.tick();
    const again = await errorOf(sponsor.sponsor(open(10n), HTTP));
    expect(again.code).toBe('SIMULATION_REVERTED');
    expect(again.detail).toBe('AlreadyOpen()');
    chain.addCeremony(CID, { phase: 3, threshold: 2, n: 3, decryptionMode: 0 }); // even if it would pass
    expect((await errorOf(sponsor.sponsor(open(11n), HTTP))).code).toBe('QUOTA_EXCEEDED');
  });

  it('records every ceremony it sponsors for the scheduler, and forgets one whose broadcast failed', async () => {
    const { chain, sponsor, store } = stack();
    registration(chain, CID);
    await sponsor.sponsor(join(CID, 0), HTTP);
    await sponsor.sponsor(create(ORG_A, 1n), HTTP);
    expect(store.state.watched).toEqual([CID, ceremonyId(31337n, MANAGER, ORG_A, 1n)]);
    chain.failNextSend = rpcError(-32000, 'insufficient funds for gas * price + value');
    await errorOf(sponsor.sponsor(join(ceremonyIdOf(7), 0), HTTP));
    expect(store.state.watched).not.toContain(ceremonyIdOf(7));
    // The workers' own transitions are not new ceremonies to watch.
    chain.addCeremony(ceremonyIdOf(8), { phase: 2, threshold: 2, n: 3 });
    await sponsor.sponsor({ kind: 'finalize', ceremonyId: ceremonyIdOf(8) }, { source: 'combiner' });
    expect(chain.manager.ceremonies.get(ceremonyIdOf(8))?.phase).toBe(3);
    expect(store.state.watched).toHaveLength(2);
  });

  it('combine through HTTP: C2 rebuilt from state, the supplied vectors cached once sent', async () => {
    const { chain, sponsor, policy } = stack();
    const rid = requestIdOf(5);
    const { vectors } = liveRequest(chain, CID, rid, [7n, 8n], [1, 3]);
    await sponsor.sponsor(
      {
        kind: 'combine',
        requestId: rid,
        memberSet: [1, 3],
        fieldIndexes: [0, 1],
        plaintexts: [7n, 8n],
        partialVectors: [vectors.get(1), vectors.get(3)] as ReturnType<typeof pad>[],
      },
      HTTP,
    );
    expect(chain.manager.requests.get(rid)?.plaintexts).toEqual([7n, 8n]);
    const hashes = chain.manager.requests.get(rid)?.hashes;
    expect(policy.partials.has(rid, 1, hashes?.get(1) as Hex)).toBe(true);
    expect(policy.partials.has(rid, 3, hashes?.get(3) as Hex)).toBe(true);
  });
});

describe('publishPartialData sponsorship (protocol §10.4)', () => {
  const publish = (rid: Hex, index: number, D: ReturnType<typeof pad>): Action => ({
    kind: 'publishPartialData',
    requestId: rid,
    participantIndex: index,
    D,
  });

  it('is not sponsored while the relayer can source the vector itself (cache, or the log it then caches)', async () => {
    const { chain, sponsor, policy } = stack();
    const rid = requestIdOf(6);
    const { vectors } = liveRequest(chain, CID, rid, [1n], [1, 2]);
    const fromLog = await errorOf(sponsor.sponsor(publish(rid, 1, vectors.get(1) as ReturnType<typeof pad>), HTTP));
    expect(fromLog.code).toBe('NOT_SPONSORED');
    expect(fromLog.detail).toMatch(/still published/);
    expect(policy.partials.has(rid, 1, chain.manager.requests.get(rid)?.hashes.get(1) as Hex)).toBe(true);
    chain.dropPublishedLogs();
    const cached = await errorOf(sponsor.sponsor(publish(rid, 1, vectors.get(1) as ReturnType<typeof pad>), HTTP));
    expect(cached.detail).toMatch(/holds member 1/);
    expect(chain.sentRaw).toHaveLength(0);
  });

  it('is sponsored when the data is missing, with a doubling per-member backoff and 2·n per request', async () => {
    const { chain, sponsor, policy, sender, advance } = stack();
    const rid = requestIdOf(7);
    const { vectors } = liveRequest(chain, CID, rid, [1n, 2n], [1, 2, 3]);
    chain.dropPublishedLogs();
    const D = vectors.get(2) as ReturnType<typeof pad>;
    const forget = async () => {
      await sender.tick();
      policy.partials.drop(rid);
      chain.dropPublishedLogs();
    };
    await sponsor.sponsor(publish(rid, 2, D), HTTP);
    expect(sentCalls(chain).map((c) => c.functionName)).toEqual(['publishPartialData']);
    // Relayed, so cached: the next request for the same member is not needed at all.
    expect((await errorOf(sponsor.sponsor(publish(rid, 2, D), HTTP))).code).toBe('NOT_SPONSORED');
    await forget();
    const soon = await errorOf(sponsor.sponsor(publish(rid, 2, D), HTTP));
    expect(soon.code).toBe('RATE_LIMITED');
    advance(10 * 60_000);
    await sponsor.sponsor(publish(rid, 2, D), HTTP);
    await forget();
    advance(10 * 60_000); // the third waits 20 min
    expect((await errorOf(sponsor.sponsor(publish(rid, 2, D), HTTP))).code).toBe('RATE_LIMITED');
    advance(10 * 60_000);
    await sponsor.sponsor(publish(rid, 2, D), HTTP);
    // Other members have their own backoff, under the request's 2·n = 6.
    for (const i of [1, 3]) {
      await forget();
      await sponsor.sponsor(publish(rid, i, vectors.get(i) as ReturnType<typeof pad>), HTTP);
    }
    await forget();
    advance(24 * 3_600_000);
    await sponsor.sponsor(publish(rid, 1, vectors.get(1) as ReturnType<typeof pad>), HTTP);
    await forget();
    advance(24 * 3_600_000);
    expect((await errorOf(sponsor.sponsor(publish(rid, 3, vectors.get(3) as ReturnType<typeof pad>), HTTP))).code).toBe(
      'QUOTA_EXCEEDED',
    );
  });

  it('is not sponsored behind this relayer\'s pending combine of the request, which may complete it', async () => {
    const { chain, sponsor } = stack({ automine: false });
    const rid = requestIdOf(9);
    const { vectors } = liveRequest(chain, CID, rid, [1n], [1, 2, 3]);
    await sponsor.sponsor(
      {
        kind: 'combine',
        requestId: rid,
        memberSet: [1, 2],
        fieldIndexes: [0],
        plaintexts: [1n],
        partialVectors: [vectors.get(1), vectors.get(2)] as ReturnType<typeof pad>[],
      },
      HTTP,
    );
    chain.dropPublishedLogs();
    const err = await errorOf(sponsor.sponsor(publish(rid, 3, vectors.get(3) as ReturnType<typeof pad>), HTTP));
    expect(err.code).toBe('CONFLICT');
    expect(chain.sentRaw).toHaveLength(1);
  });

  it('a transient log refusal is retryable, never a reason to pay; a block the provider dropped is', async () => {
    const { chain, sponsor } = stack();
    const rid = requestIdOf(10);
    const { vectors } = liveRequest(chain, CID, rid, [1n], [1, 2]);
    const D = vectors.get(1) as ReturnType<typeof pad>;
    chain.failRequests = (m) => (m === 'eth_getLogs' ? rpcError(-32005, 'rate limit exceeded') : undefined);
    const err = await errorOf(sponsor.sponsor(publish(rid, 1, D), HTTP));
    expect(err.code).toBe('INTERNAL');
    chain.logsHeadLag = 10n; // a backend behind the head
    chain.failRequests = undefined;
    expect((await errorOf(sponsor.sponsor(publish(rid, 1, D), HTTP))).code).toBe('INTERNAL');
    expect(chain.sentRaw).toHaveLength(0);
    chain.logsHeadLag = 0n;
    chain.failRequests = (m) => (m === 'eth_getLogs' ? rpcError(-32000, 'missing trie node') : undefined);
    await sponsor.sponsor(publish(rid, 1, D), HTTP);
    expect(sentCalls(chain).map((c) => c.functionName)).toEqual(['publishPartialData']);
  });

  it('a corrupted cache entry does not block a needed re-publication', async () => {
    const { chain, sponsor, policy } = stack();
    const rid = requestIdOf(11);
    const { vectors } = liveRequest(chain, CID, rid, [1n], [1, 2]);
    const hash = chain.manager.requests.get(rid)?.hashes.get(2) as Hex;
    policy.partials.put(rid, 2, hash, vectors.get(1) as ReturnType<typeof pad>); // member 1's vector under 2's key
    chain.dropPublishedLogs();
    await sponsor.sponsor(publish(rid, 2, vectors.get(2) as ReturnType<typeof pad>), HTTP);
    expect(sentCalls(chain).map((c) => c.functionName)).toEqual(['publishPartialData']);
    expect(policy.partials.vector(rid, 2, hash)).toEqual(vectors.get(2)); // the relayed, authentic copy
  });

  it('is not sponsored for a complete request; a wrong vector fails simulation and costs nothing', async () => {
    const { chain, sponsor } = stack();
    const rid = requestIdOf(8);
    const { vectors } = liveRequest(chain, CID, rid, [1n], [1, 2]);
    chain.dropPublishedLogs();
    const wrong = vectors.get(2) as ReturnType<typeof pad>;
    const err = await errorOf(sponsor.sponsor(publish(rid, 1, wrong), HTTP));
    expect(err.code).toBe('SIMULATION_REVERTED');
    expect(err.detail).toBe('PartialDataMismatch()');
    (chain.manager.requests.get(rid) as { completed: number }).completed = 1;
    const done = await errorOf(sponsor.sponsor(publish(rid, 1, vectors.get(1) as ReturnType<typeof pad>), HTTP));
    expect(done.code).toBe('NOT_SPONSORED');
    expect(done.detail).toMatch(/complete/);
    expect(chain.sentRaw).toHaveLength(0);
  });
});

describe('state garbage collection (audit: bounded bookkeeping)', () => {
  const DAY = 24 * 3_600_000;

  it('a rolled-back sponsorship leaves no zero counters or empty organizer records behind', async () => {
    const { chain, sponsor, store } = stack({ policy: { organizerDailyCeremonies: 2 } });
    chain.failNextSend = rpcError(-32000, 'insufficient funds for gas * price + value');
    expect((await errorOf(sponsor.sponsor(create(ORG_A, 1n), HTTP))).code).toBe('TX_FAILED');
    expect(store.state.quotas).toEqual({});
    expect(store.state.organizerCreates).toEqual({});
    expect(store.state.watched).toEqual([]);
  });

  it('prunes terminal counters at the finalized block: an aborted ceremony, the phase counters of a live one, a complete request', async () => {
    const { chain, policy, store, clock } = stack();
    const aborted = ceremonyIdOf(60);
    const live = ceremonyIdOf(61);
    const done = requestIdOf(62);
    const open = requestIdOf(63);
    chain.addCeremony(aborted, { phase: 1, threshold: 2, n: 0, joined: 1, qual: 0 });
    liveRequest(chain, live, done, [1n], [1, 2]);
    chain.addRequest(open, live, encryptAll(testKey(2, 3).P, [2n]).cts);
    const s = store.state;
    s.quotas = {
      [`cer:${aborted}:join`]: 1,
      [`cer:${aborted}:grant`]: 2,
      [`cer:${live}:create`]: 1,
      [`cer:${live}:join`]: 3,
      [`cer:${live}:deal`]: 3,
      [`cer:${live}:close`]: 1,
      [`cer:${live}:open`]: 1,
      [`cer:${live}:grant`]: 1,
      [`req:${done}:partial`]: 2,
      [`req:${done}:combine-fields`]: 1,
      [`req:${open}:partial`]: 1,
    };
    s.admitted = [aborted, live];
    s.tracked = [aborted, live];
    s.organizerCreates = { [ORG_A]: [clock.t - 2 * DAY], [ORG_B]: [clock.t - 1000] };
    s.republished = { [`${done}:1`]: { count: 1, at: clock.t }, [`${open}:2`]: { count: 1, at: clock.t - 31 * DAY } };

    // At the finalized block the abort and the completion have not happened yet: only the
    // time-based records go.
    chain.holdFinalized();
    chain.addCeremony(aborted, { phase: 4, threshold: 2, n: 0, joined: 1, qual: 0 });
    const req = chain.manager.requests.get(done);
    if (req) req.completed = 1;
    expect(await policy.gc()).toBe(true);
    expect(s.organizerCreates).toEqual({ [ORG_B]: [clock.t - 1000] });
    expect(s.republished).toEqual({ [`${done}:1`]: { count: 1, at: clock.t } });
    // The live ceremony's phase counters (create, join, deal, close) go; nothing else yet.
    expect(Object.keys(s.quotas).sort()).toEqual(
      [
        `cer:${aborted}:join`,
        `cer:${aborted}:grant`,
        `cer:${live}:open`,
        `cer:${live}:grant`,
        `req:${done}:partial`,
        `req:${done}:combine-fields`,
        `req:${open}:partial`,
      ].sort(),
    );

    chain.releaseFinalized();
    await policy.gc();
    expect(s.quotas).toEqual({ [`cer:${live}:open`]: 1, [`cer:${live}:grant`]: 1, [`req:${open}:partial`]: 1 });
    expect(s.admitted).toEqual([live]);
    expect(s.tracked).toEqual([live]);
    expect(s.republished).toEqual({});
  });

  it('never prunes on a failed read, and forgets an id unknown at the finalized block only after a day', async () => {
    const { chain, policy, store, advance } = stack();
    const ghost = ceremonyIdOf(70); // a create that reverted: never on chain
    store.state.quotas = { [`cer:${ghost}:create`]: 1 };
    chain.failRequests = (m) => (m === 'eth_call' ? rpcError(-32005, 'rate limit exceeded') : undefined);
    expect(await policy.gc()).toBe(false);
    chain.failRequests = undefined;
    await policy.gc();
    expect(store.state.quotas).toEqual({ [`cer:${ghost}:create`]: 1 });
    advance(DAY);
    await policy.gc();
    expect(store.state.quotas).toEqual({});
  });

  it('a relayed decryption action marks its ceremony for the combine worker; the worker\'s own do not', async () => {
    const { chain, sponsor, store } = stack();
    const cid = ceremonyIdOf(80);
    const rid = requestIdOf(80);
    liveRequest(chain, cid, rid, [1n], []);
    await sponsor.sponsor(partial(cid, rid, 1), HTTP);
    expect(store.state.tracked).toEqual([cid]);
    chain.addCeremony(ceremonyIdOf(81), { phase: 2, threshold: 2, n: 3 });
    await sponsor.sponsor({ kind: 'finalize', ceremonyId: ceremonyIdOf(81) }, HTTP);
    expect(store.state.tracked).toEqual([cid]); // not a decryption action
  });
});
