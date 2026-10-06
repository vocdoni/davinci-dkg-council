import { describe, expect, it } from 'vitest';
import { ceremonyId, G, IDENTITY, type Action, type Groth16Proof, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { RelayError } from '../src/errors.js';
import { ceremonyIdOf, encryptAll, MANAGER, partialOf, requestIdOf, rpcError, testKey } from './mockchain.js';
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
    registrationDeadline: 2_000_000_000n,
    dealingDuration: 600n,
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

const errorOf = async (p: Promise<unknown>): Promise<RelayError> => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RelayError);
  return err as RelayError;
};

describe('sponsorship quotas (protocol bounds)', () => {
  it('sponsors at most 16 joins and 16 deals per ceremony', async () => {
    const { chain, sponsor } = stack();
    for (let i = 0; i < 16; i++) await sponsor.sponsor(join(CID, i), HTTP);
    const err = await errorOf(sponsor.sponsor(join(CID, 16), HTTP));
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.status).toBe(429);
    for (let j = 1; j <= 16; j++) await sponsor.sponsor(deal(CID, j), HTTP);
    expect((await errorOf(sponsor.sponsor(deal(CID, 17), HTTP))).code).toBe('QUOTA_EXCEEDED');
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
    chain.addCeremony(CID, { phase: 2, threshold: 2, n: 3 });
    await sponsor.sponsor(close(CID, 9n), HTTP);
    await sender.tick();
    expect((await errorOf(sponsor.sponsor(close(CID, 10n), HTTP))).code).toBe('QUOTA_EXCEEDED');
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
    const { chain, sponsor } = stack();
    chain.addCeremony(CID, { phase: 3, threshold: 2, n: 3 });
    const rid = requestIdOf(1);
    for (let i = 1; i <= 3; i++) await sponsor.sponsor(partial(CID, rid, i), HTTP);
    expect((await errorOf(sponsor.sponsor(partial(CID, rid, 4), HTTP))).code).toBe('QUOTA_EXCEEDED');
  });

  it('bounds combined fields per request by its fieldCount (one retry each)', async () => {
    const { chain, sponsor, sender } = stack();
    chain.addCeremony(CID, { phase: 3, threshold: 2, n: 2 });
    const key = testKey(2, 2);
    const { cts, c1s } = encryptAll(key.P, [9n]);
    const rid = requestIdOf(2);
    chain.addRequest(rid, CID, cts);
    for (const i of [1, 2]) chain.addPartial(rid, i, partialOf(key.shares.get(i) as bigint, c1s));
    chain.holdFinalized();
    const combine: Action = { kind: 'combine', requestId: rid, memberSet: [1, 2], fieldIndexes: [0], plaintexts: [9n] };
    for (let round = 0; round < 2; round++) {
      await sponsor.sponsor(combine, HTTP);
      await sender.tick();
      chain.rollback(); // a reorg undoes the combine
    }
    expect((await errorOf(sponsor.sponsor(combine, HTTP))).code).toBe('QUOTA_EXCEEDED');
  });

  it('charges nothing for an action that fails simulation or broadcast', async () => {
    const { chain, sponsor } = stack({ policy: { ceremonyRatePerMinute: 1 } });
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
    chain.addPartial(requestIdOf(3), 1, partialOf(key.shares.get(1) as bigint, c1s));
    const combine: Action = { kind: 'combine', requestId: requestIdOf(3), memberSet: [1], fieldIndexes: [0], plaintexts: [4n] };
    expect((await errorOf(sponsor.sponsor(combine, { source: 'combiner' }))).code).toBe('NOT_SPONSORED');
  });
});
