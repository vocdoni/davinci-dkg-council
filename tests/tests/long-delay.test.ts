/**
 * Decrypting six months after the ceremony through public-provider RPC limits.
 *
 * An n = 3, t = 2 ceremony goes live and approves the test adapter; then 700,000 blocks and about
 * six months pass (anvil_mine, 22 s per block). Every member's device is gone: two members come
 * back with nothing but their twelve words and the committee link, through two RPC proxies that
 * behave like public providers (eth_getLogs refused above 10,000 blocks, answers capped), rebuild
 * their keys, authenticate them against chain state, find a vote created after the gap from state
 * alone (request ids paged, the vote's binding from the request record), recover their shares and
 * unlock it; the relayer combines. The proxies prove no step of that path asked for a single
 * event log. The paged scanner left for labels then finds every join through the same limits,
 * halving its range when an answer is too large, where one unpaged scan is refused.
 */

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  accountFromSecret,
  buildPartialDecryption,
  CouncilClient,
  dealContext,
  kitEntryIdentity,
  normalizeCeremonyId,
  participantAuthKey,
  partialPayloadHash,
  Phase,
  recoverShare,
  recoveryDealingsFromSlice,
  rootFromMnemonic,
  rosterHash as computeRosterHash,
  shareEncryptionKey,
  signAction,
  toDecimal,
  type Action,
  type Hex,
} from '@vocdoni/davinci-dkg-council-sdk';
import { createTestClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { Member, Organizer } from '../src/actors.js';
import { Harness, randomProcessId } from '../src/harness.js';
import { startRpcProxy, type RpcProxy } from '../src/rpc-proxy.js';

const GAP_BLOCKS = 700_000;
/** Seconds per mined block: 700,000 × 22 s ≈ 178 days. */
const GAP_BLOCK_TIME = 22;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}` as Hex;

describe('a vote unlocked six months after the ceremony, through public-provider RPC limits', () => {
  const h = new Harness(inject('council'));
  const org = new Organizer(h);
  /** What each member keeps once their device is gone: the twelve words and the committee link. */
  const kept: { words: string; link: string }[] = [];
  const proxies: RpcProxy[] = [];
  let cid: Hex;
  let adapter: Hex;
  let createdAt: bigint;

  beforeAll(async () => {
    adapter = await h.deployAdapter();
    proxies.push(await startRpcProxy(h.ctx.rpcUrl), await startRpcProxy(h.ctx.rpcUrl));
  });

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
  });

  /** A fresh device's reads: two "independent providers", both behind public-provider limits. */
  const freshReader = () =>
    new CouncilClient({ chainId: h.chainId, manager: h.manager, rpcUrls: proxies.map((p) => p.url) });

  it('runs an n = 3, t = 2 ceremony to Live and approves the voting connection', async () => {
    createdAt = await h.client.getBlockNumber();
    const created = await org.create({ threshold: 2, invites: 3, dealingDuration: 3600n });
    cid = created.cid;
    await h.submit(created.action, 'relayer', { action: 'createCeremony', params: 'invites=3' });
    const members: Member[] = [];
    for (let i = 0; i < 3; i++) {
      const m = new Member(h, cid);
      const link = org.inviteLink(cid, i);
      await h.submit(await m.join(link), 'relayer', { action: 'join' });
      members.push(m);
      kept.push({ words: m.mnemonic, link: link.replace(/#.*$/, '') }); // the committee link, no invite secret
    }
    await h.submit(await org.close(cid, 3), 'relayer', { action: 'closeRegistration', params: 'n=3' });
    for (const m of members) await h.submit(await m.deal(), 'relayer', { action: 'deal', params: 'n=3, t=2' });
    await h.submit({ kind: 'finalize', ceremonyId: cid }, 'relayer', { action: 'finalize', params: 'n=3, t=2, |QUAL|=3' });
    await h.submit(await org.allowAdapter(cid, adapter), 'relayer', { action: 'allowAdapter' });
    await h.submit(await org.authorizeCreator(cid, h.creator), 'relayer', { action: 'authorizeCreator' });
    // Manual mode: the organizer opens decryption once, right away; the gate stays open forever.
    await h.submit(await org.openDecryption(cid), 'relayer', { action: 'openDecryption' });
    expect((await h.reader.getCeremony(cid)).phase).toBe(Phase.Live);
  });

  it(`six months pass: ${GAP_BLOCKS.toLocaleString('en-US')} blocks`, async () => {
    const [block, time] = [await h.client.getBlockNumber(), await h.now()];
    // anvil_mine of 700,000 blocks takes about 20 s: past viem's default request timeout.
    const miner = createTestClient({ chain: foundry, mode: 'anvil', transport: http(h.ctx.rpcUrl, { timeout: 170_000 }) });
    await miner.mine({ blocks: GAP_BLOCKS, interval: GAP_BLOCK_TIME });
    expect((await h.client.getBlockNumber()) - block).toBeGreaterThanOrEqual(BigInt(GAP_BLOCKS));
    expect((await h.now()) - time).toBeGreaterThanOrEqual(BigInt(GAP_BLOCKS * GAP_BLOCK_TIME));
  }, 180_000);

  /**
   * The app's unlock path from a cleared device, SDK calls only and every read through the
   * proxies: words + link → restored identity → request ids from state → the vote's binding from
   * the request record → roster and share → §9.3 snapshot → proof → relayed partial.
   */
  async function unlockFromWords(keep: { words: string; link: string }, rid: Hex, vote: { processId: Hex }): Promise<number> {
    const reader = freshReader();
    const committee = normalizeCeremonyId((/0x[0-9a-fA-F]{24}/.exec(keep.link) ?? [''])[0]);
    const root = rootFromMnemonic(keep.words);
    const identity = kitEntryIdentity(root, {
      role: 'participant',
      chainId: toDecimal(h.chainId),
      manager: h.manager.toLowerCase() as Hex,
      ceremonyId: committee,
      accountIndex: 0,
      authAddress: ZERO_ADDRESS,
    });
    const verdict = await reader.verifyRestoredIdentity(identity);
    expect(verdict).toMatchObject({ ok: true, phase: Phase.Live });
    const index = verdict.participantIndex as number;

    const anchor = await reader.finalizedAnchor();
    expect(await reader.getRequestIds(committee, anchor)).toContain(rid);
    // The vote this request belongs to, from state: the member approves exactly this one.
    const binding = await reader.verifyRequestBinding(committee, rid, anchor);
    if (!binding.ok) throw new Error(`the vote binding was refused: ${binding.reason}`);
    expect([binding.adapter.toLowerCase(), binding.processId.toLowerCase()]).toEqual([adapter.toLowerCase(), vote.processId.toLowerCase()]);

    const { roster, view } = await reader.getRoster(committee, anchor);
    const releaseId = await reader.getCircuitReleaseId(anchor);
    const rh = computeRosterHash(h.chainId, h.manager, committee, roster);
    expect(rh).toBe(view.rosterHash);
    expect(dealContext(h.chainId, h.manager, committee, rh, releaseId)).toBe(view.ctx);
    const ctx = { chainId: h.chainId, manager: h.manager, ceremonyId: committee };
    const auth = participantAuthKey(root, ctx);
    const shareKey = shareEncryptionKey(root, ctx);
    expect(roster.authAddresses[index - 1]?.toLowerCase()).toBe(auth.address.toLowerCase());

    const { qual, dealings } = recoveryDealingsFromSlice(await reader.getRecoverySlice(committee, index, anchor));
    expect(qual).toEqual(Array.from({ length: view.n }, (_, i) => i + 1).filter((j) => (view.qualBitmap >> (j - 1)) & 1));
    const { share } = recoverShare({
      ctx: view.ctx,
      memberIndex: index,
      shareSecret: shareKey.secret,
      qual,
      dealings,
      aggregates: await reader.getAggregates(committee, anchor),
      expectedMemberKey: await reader.getMemberKey(committee, index, anchor),
    });
    const snapshot = await reader.getPartialRequestSnapshot(rid, index, { expectedCeremonyId: committee });
    const built = buildPartialDecryption(snapshot, share, { chainId: h.chainId, manager: h.manager });
    const { proof, publicSignals } = await h.prover.prove('partial', built.witnessInput);
    expect(publicSignals).toEqual(built.publicSignals);
    const payload = { D: built.D, proof };
    const message = {
      ceremonyId: committee,
      requestId: rid,
      participantIndex: index,
      payloadHash: partialPayloadHash(rid, payload),
      validUntil: await h.validUntil(),
    };
    const signature = await signAction(accountFromSecret(auth.secret), h.chainId, h.manager, 'Partial', message);
    const action: Action = { kind: 'submitPartial', message, signature, payload };
    await h.submit(action, 'relayer', { action: 'submitPartial', params: `fields=${snapshot.fieldCount}` });
    return index;
  }

  it('two members restore from their twelve words alone and unlock a vote created after the gap; no step reads logs', async () => {
    // The voting system binds and submits a new vote (its own transactions, not the members' reads).
    const vote = { processId: randomProcessId() };
    const values = [3n, 0n, 1_234_567n];
    const rid = await h.bind(adapter, cid, vote.processId);
    await h.request(adapter, cid, rid, values, await h.reader.getPublicKey(cid));

    for (const p of proxies) p.reset();
    const indexes: number[] = [];
    for (const keep of [kept[2], kept[0]]) indexes.push(await unlockFromWords(keep as (typeof kept)[number], rid, vote));
    expect(indexes).toEqual([3, 1]);
    expect(await h.waitPlaintexts(rid)).toEqual(values);

    const calls = proxies.flatMap((p) => p.calls);
    expect(calls.length).toBeGreaterThan(20); // every read went through the limited providers
    expect(proxies.every((p) => p.calls.length > 0)).toBe(true);
    expect(calls.filter((c) => c.method === 'eth_getLogs')).toEqual([]);
    expect(calls.filter((c) => c.refused)).toEqual([]);
  }, 300_000);

  it('labels still load through the same limits: the paged scan finds every join, one unpaged scan is refused', async () => {
    const reader = freshReader();
    const head = await h.client.getBlockNumber();
    expect(head - createdAt).toBeGreaterThan(BigInt(GAP_BLOCKS));

    // What the app did before: one eth_getLogs from the deployment block to the head.
    for (const p of proxies) p.reset();
    const unpaged = await fetch(proxies[0]?.url as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [{ address: h.manager, fromBlock: '0x0', toBlock: 'latest' }],
      }),
    }).then((r) => r.json() as Promise<{ error?: { message: string } }>);
    expect(unpaged.error?.message).toMatch(/limited to a 10,000 range/);

    // Join events of this committee, from the deployment block (block 0 here): 10,000-block pages.
    for (const p of proxies) p.reset();
    const joins = await reader.scanEvents({ fromBlock: 0n, eventName: 'ParticipantJoined', args: { cid } });
    expect(joins.complete).toBe(true);
    expect(joins.events.map((e) => Number((e.args as { index: number }).index))).toEqual([1, 2, 3]);
    const ranges = proxies.flatMap((p) => p.logCalls()).map((c) => c.range as [bigint, bigint]);
    expect(ranges.every(([a, b]) => b - a + 1n <= 10_000n)).toBe(true);
    expect(ranges.length).toBe(Math.ceil(Number(joins.toBlock + 1n) / 10_000));

    // Every manager event of this ceremony's busy blocks under a tight result cap: the scanner
    // halves its range until the answers fit, and still finds exactly what an uncapped node has.
    const from = createdAt;
    const to = createdAt + 200n;
    const all = await h.client.getLogs({ address: h.manager, fromBlock: from, toBlock: to });
    expect(all.length).toBeGreaterThan(8);
    for (const p of proxies) {
      p.reset();
      p.limits.maxLogResults = 4;
    }
    try {
      const capped = await reader.scanEvents({ fromBlock: from, toBlock: to });
      expect(capped.complete).toBe(true);
      expect(capped.logs.map((l) => `${l.blockNumber}:${l.logIndex}`)).toEqual(all.map((l) => `${l.blockNumber}:${l.logIndex}`));
      expect(proxies.flatMap((p) => p.logCalls()).some((c) => c.refused)).toBe(true);
    } finally {
      for (const p of proxies) p.limits.maxLogResults = 10_000;
    }
  }, 120_000);
});
