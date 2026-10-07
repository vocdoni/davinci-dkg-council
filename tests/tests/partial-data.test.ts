/**
 * Where a combiner's D vectors come from (protocol §10.4), on a dedicated deployment with its
 * own relayer whose every read goes through an RPC proxy:
 *
 *  - Request 1: both partials are sent directly, so the relayer's cache has never seen their
 *    vectors — its combiner must recover each one with the single owner-approved log read, one
 *    eth_getLogs restricted to the stored publication block. The proxy proves those
 *    single-block reads happened and that nothing ever asked for a wide range.
 *  - Request 2 (relayer stopped): a combiner whose provider lost the logs entirely. Sourcing
 *    with a provider that returns nothing reports every member missing; the members republish
 *    their vectors permissionlessly (`publishPartialData`, recomputed from their shares, moving
 *    the stored publication block), re-sourcing then authenticates every vector against the
 *    stored hash, and a direct combine completes the request.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  BsgsTable,
  buildCombineArgs,
  decompressPoint,
  fieldsPerCombineTx,
  solvePlaintext,
  sourcePartialVectors,
  type Hex,
  type Point,
} from '@vocdoni/davinci-dkg-council-sdk';
import { createPublicClient, http, type PublicClient } from 'viem';
import { foundry } from 'viem/chains';
import { ACCOUNT, anvilAccount, anvilKey, walletFor } from '../src/accounts.js';
import { Member, Organizer } from '../src/actors.js';
import { deployCouncil } from '../src/deploy.js';
import { Harness, randomProcessId } from '../src/harness.js';
import { LOG_DIR, startRelayer, type RelayerProcess } from '../src/infra.js';
import { startRpcProxy, type RpcProxy } from '../src/rpc-proxy.js';

/** A funded Anvil account no other service uses (main relayer: 1, scheduler suite: 6). */
const RELAYER_ACCOUNT = 7;

describe('partial-data sourcing: the single-block log lookup and the republish fallback', () => {
  const ctx = inject('council');
  let proxy: RpcProxy;
  let rel: RelayerProcess;
  let h: Harness;
  let adapter: Hex;
  let cid: Hex;
  const members: Member[] = [];

  beforeAll(async () => {
    // A dedicated manager: the suite's main relayer neither serves nor combines it.
    const client = createPublicClient({ chain: foundry, transport: http(ctx.rpcUrl) }) as PublicClient;
    const { manager } = await deployCouncil(walletFor(ctx.rpcUrl, ACCOUNT.deployer), client, ctx.releaseId);
    proxy = await startRpcProxy(ctx.rpcUrl);
    rel = await startRelayer(
      {
        COUNCIL_RPC_URL: proxy.url, // every relayer read is on the record, under provider limits
        COUNCIL_MANAGER_ADDRESS: manager,
        COUNCIL_PRIVATE_KEY: anvilKey(RELAYER_ACCOUNT),
        COUNCIL_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'council-e2e-partials-')),
        COUNCIL_START_BLOCK: (await client.getBlockNumber()).toString(),
        COUNCIL_COMBINER_ENABLED: 'true',
        COUNCIL_COMBINER_POLL_MS: '500',
        COUNCIL_TX_POLL_MS: '200',
        COUNCIL_DAILY_BUDGET_WEI: (100n * 10n ** 18n).toString(),
        COUNCIL_RATE_LIMIT: '1000',
        COUNCIL_CEREMONY_RATE_LIMIT: '1000',
        COUNCIL_INGRESS_RATE_LIMIT: '100000',
      },
      { logDir: path.join(LOG_DIR, 'partial-data') },
    );
    h = new Harness(
      { ...ctx, relayerUrl: rel.url, relayerAddress: anvilAccount(RELAYER_ACCOUNT).address.toLowerCase() as Hex },
      { manager },
    );
    adapter = await h.deployAdapter();
  }, 60_000);

  afterAll(async () => {
    await rel?.stop();
    await proxy?.close();
  });

  it('runs an n = 3, t = 2 ceremony to Live with decryption open', async () => {
    const org = new Organizer(h);
    const { cid: created, action } = await org.create({ threshold: 2, invites: 3 });
    cid = created;
    await h.submit(action, 'relayer', { action: 'createCeremony', params: 'invites=3' });
    for (let i = 0; i < 3; i++) {
      const m = new Member(h, cid);
      members.push(m);
      await h.submit(await m.join(org.inviteLink(cid, i)), 'relayer', { action: 'join' });
    }
    await h.submit(await org.close(cid, 3), 'relayer', { action: 'closeRegistration', params: 'n=3' });
    for (const m of members) await h.submit(await m.deal(), 'relayer', { action: 'deal', params: 'n=3, t=2' });
    await h.submit({ kind: 'finalize', ceremonyId: cid }, 'relayer', { action: 'finalize', params: 'n=3, t=2, |QUAL|=3' });
    await h.submit(await org.allowAdapter(cid, adapter), 'relayer', { action: 'allowAdapter' });
    await h.submit(await org.authorizeCreator(cid, h.creator), 'relayer', { action: 'authorizeCreator' });
    await h.submit(await org.openDecryption(cid), 'relayer', { action: 'openDecryption' });
  }, 300_000);

  it('request 1: partials the relayer never saw — its combiner recovers them with single-block log reads', async () => {
    const values = [11n, 0n, 42n];
    const rid = await h.bind(adapter, cid, randomProcessId());
    await h.request(adapter, cid, rid, values, await h.reader.getPublicKey(cid));

    // Directly submitted: the vectors never pass through the relayer, so its cache stays empty.
    for (const m of [members[0]!, members[1]!]) {
      await h.submit(await m.partial(rid), 'direct', { action: 'submitPartial', params: `fields=${values.length}` });
    }
    expect(await h.waitPlaintexts(rid)).toEqual(values);

    const chunks = await h.recordCombineGas(rid, 2);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.sender === h.relayerAddress)).toBe(true); // the relayer's combiner won

    // §10.4: one eth_getLogs per member, restricted to that member's stored publication block.
    const single = proxy.logCalls().filter((c) => c.range && c.range[0] === c.range[1]);
    for (const i of chunks[0]!.memberSet) {
      const { publishedBlock } = await h.reader.getPartialCommitment(rid, i);
      expect(single.some((c) => c.range?.[0] === publishedBlock)).toBe(true);
    }
    expect(proxy.calls.filter((c) => c.refused)).toEqual([]); // nothing ever needed a wide range
  }, 300_000);

  it('request 2: a provider that lost the logs — republish moves the publication block and sourcing recovers', async () => {
    await rel.stop(); // no combiner: request 2 is combined by hand below
    const values = [7n, 1n << 30n];
    const memberSet = [2, 3];
    const rid = await h.bind(adapter, cid, randomProcessId());
    await h.request(adapter, cid, rid, values, await h.reader.getPublicKey(cid));
    for (const i of memberSet) {
      await h.submit(await members[i - 1]!.partial(rid), 'direct', { action: 'submitPartial', params: `fields=${values.length}` });
    }

    // A combiner with no cache behind a provider whose log answers are gone: every member missing.
    const sourcing = {
      chainId: h.chainId,
      manager: h.manager,
      ceremonyId: cid,
      requestId: rid,
      fieldCount: values.length,
      memberSet,
    };
    const blind = await sourcePartialVectors({
      ...sourcing,
      source: {
        getPartialCommitment: (r: Hex, i: number) => h.reader.getPartialCommitment(r, i),
        fetchPublishedVector: async () => undefined,
      },
    });
    expect([blind.vectors.size, blind.missing]).toEqual([0, memberSet]);

    // The §10.4 fallback: each member recomputes D from its share and republishes, permissionlessly.
    const before = new Map<number, bigint>();
    for (const i of memberSet) before.set(i, (await h.reader.getPartialCommitment(rid, i)).publishedBlock);
    for (const i of memberSet) {
      await h.submit(await members[i - 1]!.republish(rid), 'direct', {
        action: 'publishPartialData',
        params: `fields=${values.length}`,
      });
      const after = await h.reader.getPartialCommitment(rid, i);
      expect(after.publishedBlock).toBeGreaterThan(before.get(i) as bigint); // the stored block moved
    }

    // Re-sourcing through a live provider authenticates every vector against the stored hash.
    const { vectors, missing } = await sourcePartialVectors({ ...sourcing, source: h.reader });
    expect(missing).toEqual([]);

    const cts = (await h.reader.getRequestCompressed(rid)).map(([w1, w2]) => ({
      c1: decompressPoint(w1),
      c2: decompressPoint(w2),
    }));
    const table = BsgsTable.build();
    const solved = cts.map(({ c2 }, k) => ({
      fieldIndex: k,
      plaintext: solvePlaintext(c2, memberSet, new Map(memberSet.map((i) => [i, vectors.get(i)![k] as Point])), { table }),
      c2,
    }));
    const per = fieldsPerCombineTx(2);
    for (let off = 0; off < solved.length; off += per) {
      const args = buildCombineArgs(rid, memberSet, solved.slice(off, off + per), vectors);
      await h.submit({ kind: 'combine', ...args }, 'direct', { action: 'combine', params: `t=2, fields=${args.fieldIndexes.length}` });
    }
    expect(await h.waitPlaintexts(rid, 10_000)).toEqual(values);
    expect(await h.adapterPlaintexts(adapter, cid, rid, values.length)).toEqual({ ready: true, values });
  }, 300_000);
});
