/**
 * n = 5, t = 3 through the relayer, with real proofs: invites (create + add), joins from invite
 * links, roster approval, four dealers (member 5 never deals), finalize after the deadline,
 * authorization, then two processes bound to the same ceremony, each decrypted by a different
 * member set — the non-dealer included — and combined by the relayer's worker; a third shows a
 * pending partial holding its slot while automining is off.
 */

import { beforeAll, describe, expect, inject, it } from 'vitest';
import { COUNCIL_MANAGER_ABI, RelayerError, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { Member, Organizer } from '../src/actors.js';
import { Harness, randomProcessId } from '../src/harness.js';

const PHASE = { Registration: 1, Dealing: 2, Live: 3, Aborted: 4 } as const;

describe('n=5, t=3 lifecycle (relayer, real proofs)', () => {
  const h = new Harness(inject('council'));
  const org = new Organizer(h);
  const members: Member[] = [];
  let cid: Hex;
  let adapter: Hex;

  beforeAll(async () => {
    adapter = await h.deployAdapter();
  });

  it('creates the ceremony with 3 invites and appends 2 more', async () => {
    const created = await org.create({ threshold: 3, invites: 3, dealingDuration: 3600n });
    cid = created.cid;
    await h.submit(created.action, 'relayer', { action: 'createCeremony', params: 'invites=3' });
    const add = await org.addInvites(cid, 3, 2);
    await h.submit(add, 'relayer', { action: 'addInvites', params: 'invites=2' });
    await h.expectRelayRevert(add, 'BadInviteIndex'); // a replayed batch cannot shift invite ids
    const view = await h.reader.getCeremony(cid);
    expect(view.phase).toBe(PHASE.Registration);
    expect(view.inviteCount).toBe(5);
    expect(view.threshold).toBe(3);
  });

  it('five members join from their invite links (one submits directly)', async () => {
    for (let i = 0; i < 5; i++) {
      const m = new Member(h, cid);
      members.push(m);
      await h.submit(await m.join(org.inviteLink(cid, i)), i === 2 ? 'direct' : 'relayer', { action: 'join' });
    }
    // A redeemed link is consumed: a second person opening it is refused, and nothing is paid.
    await h.expectRelayRevert(await new Member(h, cid).join(org.inviteLink(cid, 0)), 'InviteConsumed');
    const view = await h.reader.getCeremony(cid);
    expect(view.joinedCount).toBe(5);
    expect(view.consumedInvites).toBe(0b11111n);
  });

  it('closes registration; every member approves the frozen roster', async () => {
    await h.expectRelayRevert(await org.close(cid, 4), 'RosterMismatch');
    await h.submit(await org.close(cid, 5), 'relayer', { action: 'closeRegistration', params: 'n=5' });
    for (const m of members) await m.approveRoster();
    expect(members.map((m) => m.index)).toEqual([1, 2, 3, 4, 5]);
    const view = await h.reader.getCeremony(cid);
    expect(view.phase).toBe(PHASE.Dealing);
    expect(view.n).toBe(5);
  });

  it('members 1-4 deal with real proofs; member 5 misses the deadline; finalize after it', async () => {
    for (const m of members.slice(0, 4)) {
      await h.submit(await m.deal(), 'relayer', { action: 'deal', params: 'n=5, t=3' });
    }
    await h.expectRelayRevert(await members[0]!.deal(), 'AlreadyDealt');
    await h.expectRelayRevert({ kind: 'finalize', ceremonyId: cid }, 'FinalizeConditionNotMet');

    const late = await members[4]!.deal(); // prepared in time, submitted too late
    const { dealingDeadline } = await h.reader.getCeremony(cid);
    await h.warp(dealingDeadline - (await h.now()) + 1n);
    await h.expectRelayRevert(late, 'Expired');
    await h.expectRelayRevert({ kind: 'abort', ceremonyId: cid }, 'AbortConditionNotMet'); // |QUAL| >= t

    await h.submit({ kind: 'finalize', ceremonyId: cid }, 'relayer', { action: 'finalize', params: 'n=5, t=3, |QUAL|=4' });
    const view = await h.reader.getCeremony(cid);
    expect(view.phase).toBe(PHASE.Live);
    expect(view.qualBitmap).toBe(0b01111);
    expect(view.dealtCount).toBe(4);
  });

  it('every member, the non-dealer included, recovers a share that matches its on-chain PK_i', async () => {
    for (const m of members) await m.recoverShare();
  });

  it('the organizer allows the test adapter and a process creator', async () => {
    await h.submit(await org.allowAdapter(cid, adapter), 'relayer', { action: 'allowAdapter' });
    await h.submit(await org.authorizeCreator(cid, h.creator), 'relayer', { action: 'authorizeCreator' });
    await h.expectRelayRevert(await org.allowAdapter(cid, adapter), 'AlreadyListed');
  });

  const decrypt = async (opts: { values: bigint[]; direct: Member; relayed: Member[]; expectMemberSet: number[] }) => {
    const publicKey = await h.reader.getPublicKey(cid);
    const rid = await h.bind(adapter, cid, randomProcessId());
    await h.request(adapter, cid, rid, opts.values, publicKey);
    const params = `fields=${opts.values.length}`;
    await h.submit(await opts.direct.partial(rid), 'direct', { action: 'submitPartial', params });
    for (const m of opts.relayed) await h.submit(await m.partial(rid), 'relayer', { action: 'submitPartial', params });

    expect(await h.waitPlaintexts(rid)).toEqual(opts.values);
    expect(await h.adapterPlaintexts(adapter, cid, rid, opts.values.length)).toEqual({ ready: true, values: opts.values });
    const chunks = await h.recordCombineGas(rid, 3);
    for (const c of chunks) {
      expect(c.memberSet).toEqual(opts.expectMemberSet);
      expect(c.sender).toBe(h.relayerAddress); // combined by the relayer's worker
    }
    return { rid, chunks };
  };

  let first: Hex;

  it('process A: known ciphertexts (zero and near 2^40) decrypted by members 2, 4 and the non-dealer 5', async () => {
    const values = [0n, 1n, 7n, 123_456_789n, (1n << 40n) - 3n];
    const { rid, chunks } = await decrypt({
      values,
      direct: members[4]!,
      relayed: [members[1]!, members[3]!],
      expectMemberSet: [2, 4, 5],
    });
    first = rid;
    // fieldsPerTx = min(4, max(1, floor(32 / 3))) = 4
    expect(chunks.map((c) => c.fields)).toEqual([4, 1]);
    // A late partial is still accepted; a duplicate is refused without cost.
    await h.submit(await members[0]!.partial(rid), 'relayer', { action: 'submitPartial', params: 'fields=5' });
    await h.expectRelayRevert(await members[1]!.partial(rid), 'AlreadyPartial');
  });

  it('process B on the same ceremony decrypts independently with members 1, 3, 5', async () => {
    const values = [42n, (1n << 40n) - 1n, 0n];
    const { rid, chunks } = await decrypt({
      values,
      direct: members[0]!,
      relayed: [members[2]!, members[4]!],
      expectMemberSet: [1, 3, 5],
    });
    expect(chunks.map((c) => c.fields)).toEqual([3]);
    expect(rid).not.toBe(first);
    const ids = (await h.client.readContract({
      address: h.manager,
      abi: COUNCIL_MANAGER_ABI,
      functionName: 'getRequestIds',
      args: [cid],
    })) as readonly Hex[];
    expect(ids).toEqual([first, rid]);
  });

  it('with automining off, a pending partial holds its slot: identical resolves to it, a variant is refused', async () => {
    const values = [11n, 12n];
    const rid = await h.bind(adapter, cid, randomProcessId());
    await h.request(adapter, cid, rid, values, await h.reader.getPublicKey(cid));
    // Two valid partials of member 3 for the same request: fresh proofs, so different payload
    // hashes, signatures and calldata — only one can ever be accepted.
    const a = await members[2]!.partial(rid);
    const b = await members[2]!.partial(rid);
    const nonce = () => h.client.getTransactionCount({ address: h.relayerAddress, blockTag: 'pending' });

    await h.test.setAutomine(false);
    let hashA: Hex;
    try {
      const before = await nonce();
      hashA = await h.relayer.relay(h.chainId, h.manager, a);
      expect(await h.relayer.relay(h.chainId, h.manager, a)).toBe(hashA);
      const err = await h.relayer.relay(h.chainId, h.manager, b).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RelayerError);
      expect((err as RelayerError).code).toBe('CONFLICT');
      expect((err as RelayerError).httpStatus).toBe(409);
      expect(await nonce()).toBe(before + 1); // one transaction, nothing paid for the variant
      expect((await h.relayer.status(hashA)).status).toBe('pending');
    } finally {
      await h.test.setAutomine(true);
    }
    await h.test.mine({ blocks: 1 });
    expect((await h.waitRelayed(hashA)).status).toBe('success');
    // Settled: the slot is released and the chain decides — the variant is a free revert.
    await h.expectRelayRevert(b, 'AlreadyPartial');

    for (const m of [members[3]!, members[4]!]) await h.submit(await m.partial(rid), 'relayer', { action: 'submitPartial', params: 'fields=2' });
    expect(await h.waitPlaintexts(rid)).toEqual(values);
  });
});
