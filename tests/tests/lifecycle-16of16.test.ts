/**
 * Capacity: n = t = 16, sixteen real dealings, early finalize, one 16-field request decrypted by
 * all sixteen members and combined by the relayer's worker in fieldsPerTx = 2 chunks.
 */

import { beforeAll, describe, expect, inject, it } from 'vitest';
import { fieldsPerCombineTx, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { Member, Organizer } from '../src/actors.js';
import { Harness, randomProcessId } from '../src/harness.js';

describe('n=16, t=16 lifecycle (relayer, real proofs)', () => {
  const h = new Harness(inject('council'));
  const org = new Organizer(h);
  const members: Member[] = [];
  let cid: Hex;
  let adapter: Hex;

  beforeAll(async () => {
    adapter = await h.deployAdapter();
  });

  it('creates a 16-invite ceremony; sixteen members join and the roster closes', async () => {
    const created = await org.create({ threshold: 16, invites: 16 });
    cid = created.cid;
    await h.submit(created.action, 'relayer', { action: 'createCeremony', params: 'invites=16' });
    for (let i = 0; i < 16; i++) {
      const m = new Member(h, cid);
      members.push(m);
      await h.submit(await m.join(org.inviteLink(cid, i)), 'relayer', { action: 'join' });
    }
    await h.submit(await org.close(cid, 16), 'relayer', { action: 'closeRegistration', params: 'n=16' });
    const view = await h.reader.getCeremony(cid);
    expect(view.n).toBe(16);
    expect(view.threshold).toBe(16);
  });

  it('all sixteen deal; finalize is allowed early once QUAL = n', async () => {
    for (const m of members) await h.submit(await m.deal(), 'relayer', { action: 'deal', params: 'n=16, t=16' });
    await h.submit({ kind: 'finalize', ceremonyId: cid }, 'relayer', { action: 'finalize', params: 'n=16, t=16, |QUAL|=16' });
    const view = await h.reader.getCeremony(cid);
    expect(view.phase).toBe(3);
    expect(view.qualBitmap).toBe(0xffff);
  });

  it('a 16-field request is decrypted by all sixteen members and combined in chunks of 2', async () => {
    await h.submit(await org.allowAdapter(cid, adapter), 'relayer', { action: 'allowAdapter' });
    await h.submit(await org.authorizeCreator(cid, h.creator), 'relayer', { action: 'authorizeCreator' });
    await h.submit(await org.openDecryption(cid), 'direct', { action: 'openDecryption' });
    const rid = await h.bind(adapter, cid, randomProcessId());
    const values = Array.from({ length: 16 }, (_, k) => (k === 0 ? 0n : k === 15 ? (1n << 40n) - 2n : BigInt(k) * 1_000_003n));
    await h.request(adapter, cid, rid, values, await h.reader.getPublicKey(cid));

    for (const [i, m] of members.entries()) {
      await h.submit(await m.partial(rid), i === 7 ? 'direct' : 'relayer', { action: 'submitPartial', params: 'fields=16' });
    }
    expect(await h.waitPlaintexts(rid)).toEqual(values);
    const chunks = await h.recordCombineGas(rid, 16);
    expect(fieldsPerCombineTx(16)).toBe(2);
    expect(chunks.map((c) => c.fields)).toEqual(Array(8).fill(2));
    for (const c of chunks) {
      expect(c.memberSet).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
      expect(c.sender).toBe(h.relayerAddress);
    }
  });
});
