/**
 * The six-month delayed reveal (§8.7), in every decryption policy a ceremony can carry:
 *
 *  (a) Scheduled — the opening date is fixed at creation; nobody (not even the organizer) can
 *      open earlier, and when the date passes the gate opens by predicate alone, no transaction.
 *  (b) Manual with no fallback — time alone never opens the gate; the organizer opens it with
 *      one signed action six months later.
 *  (c) Manual with a fallback date — the organizer never shows up (key lost); the fallback
 *      passes and the gate opens with no transaction.
 *
 * Every organizer and member read goes through an RPC proxy with public-provider limits; at the
 * end the proxy proves that no step of those paths asked for a single event log.
 */

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { COUNCIL_MANAGER_ABI, PhaseMode, type Hex, type Point } from '@vocdoni/davinci-dkg-council-sdk';
import { Member, Organizer } from '../src/actors.js';
import { Harness, randomProcessId } from '../src/harness.js';
import { startRpcProxy, type RpcProxy } from '../src/rpc-proxy.js';

const SIX_MONTHS = 180n * 86_400n;
/** An all-identity padded D vector: enough calldata to reach the §8.7 gate check. */
const PAD_D: Point[] = Array.from({ length: 16 }, () => ({ x: 0n, y: 1n }));

describe('six-month delayed reveal in every decryption policy', () => {
  const ctx = inject('council');
  const h = new Harness(ctx);
  let proxy: RpcProxy;
  /** The actors' host: same deployment, every read through the limited provider. */
  let hp: Harness;
  let adapter: Hex;

  beforeAll(async () => {
    proxy = await startRpcProxy(ctx.rpcUrl);
    hp = new Harness({ ...ctx, rpcUrl: proxy.url });
    adapter = await h.deployAdapter();
  });

  afterAll(async () => {
    await proxy?.close();
  });

  /** An n = 3, t = 2 ceremony run to Live with the adapter approved, everything relayed. */
  async function liveCeremony(policy: {
    decryptionMode?: PhaseMode;
    decryptionOpenAt?: bigint;
    manualDecryptionFallbackAt?: bigint;
  }) {
    const org = new Organizer(hp);
    const { cid, action } = await org.create({ threshold: 2, invites: 3, ...policy });
    await h.submit(action, 'relayer', { action: 'createCeremony', params: 'invites=3' });
    const members: Member[] = [];
    for (let i = 0; i < 3; i++) {
      const m = new Member(hp, cid);
      await h.submit(await m.join(org.inviteLink(cid, i)), 'relayer', { action: 'join' });
      members.push(m);
    }
    await h.submit(await org.close(cid, 3), 'relayer', { action: 'closeRegistration', params: 'n=3' });
    for (const m of members) await h.submit(await m.deal(), 'relayer', { action: 'deal', params: 'n=3, t=2' });
    await h.submit({ kind: 'finalize', ceremonyId: cid }, 'relayer', { action: 'finalize', params: 'n=3, t=2, |QUAL|=3' });
    await h.submit(await org.allowAdapter(cid, adapter), 'relayer', { action: 'allowAdapter' });
    await h.submit(await org.authorizeCreator(cid, h.creator), 'relayer', { action: 'authorizeCreator' });
    return { org, cid, members };
  }

  /** The ciphertexts land now; they are decrypted six months later. */
  async function sealedRequest(cid: Hex, values: bigint[]): Promise<Hex> {
    const rid = await h.bind(adapter, cid, randomProcessId());
    await h.request(adapter, cid, rid, values, await hp.reader.getPublicKey(cid));
    return rid;
  }

  const openedEvents = (cid: Hex) =>
    h.client.getContractEvents({
      address: h.manager,
      abi: COUNCIL_MANAGER_ABI,
      eventName: 'DecryptionOpened',
      args: { cid } as never,
      fromBlock: 0n,
    });

  it('(a) scheduled: nobody can decrypt before the date, the organizer included; it opens by itself', async () => {
    const openAt = (await hp.now()) + SIX_MONTHS;
    const { org, cid, members } = await liveCeremony({ decryptionMode: PhaseMode.Scheduled, decryptionOpenAt: openAt });
    const values = [5n, 0n, 1_000_000n];
    const rid = await sealedRequest(cid, values);

    expect(await hp.reader.isDecryptionOpen(cid)).toBe(false);
    await h.expectRelayRevert(await org.openDecryption(cid), 'WrongMode'); // not even the organizer
    await expect(members[0]!.partial(rid)).rejects.toThrow(/decryption gate is closed/); // SDK refuses first
    await h.expectDirectRevert({ kind: 'publishPartialData', requestId: rid, participantIndex: 1, D: PAD_D }, 'DecryptionNotOpen');

    await h.warp(openAt - (await hp.now()) + 1n);
    expect(await hp.reader.isDecryptionOpen(cid)).toBe(true);
    expect(await openedEvents(cid)).toEqual([]); // predicate only: no transaction opened it

    for (const m of [members[0]!, members[2]!]) {
      await h.submit(await m.partial(rid), 'relayer', { action: 'submitPartial', params: `fields=${values.length}` });
    }
    expect(await h.waitPlaintexts(rid)).toEqual(values);
    expect(await h.adapterPlaintexts(adapter, cid, rid, values.length)).toEqual({ ready: true, values });
  }, 300_000);

  it('(b) manual, no fallback: six months of time alone change nothing; one organizer action opens it', async () => {
    const { org, cid, members } = await liveCeremony({});
    const values = [0n, 77n];
    const rid = await sealedRequest(cid, values);

    await h.warp(SIX_MONTHS);
    expect(await hp.reader.isDecryptionOpen(cid)).toBe(false); // no fallback: only the organizer ever opens
    await expect(members[1]!.partial(rid)).rejects.toThrow(/decryption gate is closed/);

    await h.submit(await org.openDecryption(cid), 'relayer', { action: 'openDecryption' });
    expect(await hp.reader.isDecryptionOpen(cid)).toBe(true);
    for (const m of [members[1]!, members[2]!]) {
      await h.submit(await m.partial(rid), 'relayer', { action: 'submitPartial', params: `fields=${values.length}` });
    }
    expect(await h.waitPlaintexts(rid)).toEqual(values);
  }, 300_000);

  it('(c) manual with a fallback date: the organizer never shows up, the fallback opens the gate', async () => {
    const fallback = (await hp.now()) + SIX_MONTHS;
    const { cid, members } = await liveCeremony({ manualDecryptionFallbackAt: fallback });
    const values = [123_456n, 1n];
    const rid = await sealedRequest(cid, values);

    expect(await hp.reader.isDecryptionOpen(cid)).toBe(false);
    await expect(members[0]!.partial(rid)).rejects.toThrow(/decryption gate is closed/);

    await h.warp(fallback - (await hp.now()) + 1n);
    expect(await hp.reader.isDecryptionOpen(cid)).toBe(true);
    expect(await openedEvents(cid)).toEqual([]); // the organizer's key can be lost: no action needed

    for (const m of [members[0]!, members[1]!]) {
      await h.submit(await m.partial(rid), 'relayer', { action: 'submitPartial', params: `fields=${values.length}` });
    }
    expect(await h.waitPlaintexts(rid)).toEqual(values);
  }, 300_000);

  it('no organizer or member read of any scenario asked for an event log', () => {
    expect(proxy.calls.length).toBeGreaterThan(50);
    expect(proxy.calls.filter((c) => c.method === 'eth_getLogs')).toEqual([]);
    expect(proxy.calls.filter((c) => c.refused)).toEqual([]);
  });
});
