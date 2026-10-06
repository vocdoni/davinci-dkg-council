/**
 * The permissionless fallback: a complete lifecycle on a second manager deployment that no
 * relayer serves. Every action — the combine included, computed locally with the SDK BSGS — is
 * sent directly from an ordinary funded account.
 */

import { beforeAll, describe, expect, inject, it } from 'vitest';
import {
  BsgsTable,
  buildCombineArgs,
  fieldsPerCombineTx,
  RelayerError,
  solvePlaintext,
  type Hex,
  type Point,
} from '@vocdoni/davinci-dkg-council-sdk';
import { createPublicClient, http, type PublicClient } from 'viem';
import { foundry } from 'viem/chains';
import { ACCOUNT, walletFor } from '../src/accounts.js';
import { Member, Organizer } from '../src/actors.js';
import { deployCouncil } from '../src/deploy.js';
import { Harness, randomProcessId } from '../src/harness.js';

describe('every action sent directly, no relayer', () => {
  const ctx = inject('council');
  let h: Harness;
  let org: Organizer;
  let cid: Hex;
  let adapter: Hex;
  const members: Member[] = [];

  beforeAll(async () => {
    const client = createPublicClient({ chain: foundry, transport: http(ctx.rpcUrl) }) as PublicClient;
    const { manager } = await deployCouncil(walletFor(ctx.rpcUrl, ACCOUNT.deployer), client, ctx.releaseId);
    h = new Harness(ctx, { manager });
    org = new Organizer(h);
    adapter = await h.deployAdapter();
  });

  it('the relayer refuses a manager it does not serve', async () => {
    const err = await h.relayer.relay(h.chainId, h.manager, { kind: 'finalize', ceremonyId: '0x000000000000000000000001' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayerError);
    expect((err as RelayerError).code).toBe('UNSUPPORTED_MANAGER');
  });

  it('create, add invites, three joins, close, three dealings and an early finalize', async () => {
    const created = await org.create({ threshold: 2, invites: 2 });
    cid = created.cid;
    await h.submit(created.action, 'direct', { action: 'createCeremony', params: 'invites=2' });
    await h.submit(await org.addInvites(cid, 2, 1), 'direct', { action: 'addInvites', params: 'invites=1' });
    for (let i = 0; i < 3; i++) {
      const m = new Member(h, cid);
      members.push(m);
      await h.submit(await m.join(org.inviteLink(cid, i)), 'direct', { action: 'join' });
    }
    await h.submit(await org.close(cid, 3), 'direct', { action: 'closeRegistration', params: 'n=3' });
    for (const m of members) await h.submit(await m.deal(), 'direct', { action: 'deal', params: 'n=3, t=2' });
    await h.submit({ kind: 'finalize', ceremonyId: cid }, 'direct', { action: 'finalize', params: 'n=3, t=2, |QUAL|=3' });
    expect((await h.reader.getCeremony(cid)).phase).toBe(3);
  });

  it('authorize, bind, request, two partials, and a locally computed combine', async () => {
    await h.submit(await org.allowAdapter(cid, adapter), 'direct', { action: 'allowAdapter' });
    await h.submit(await org.authorizeCreator(cid, h.creator), 'direct', { action: 'authorizeCreator' });
    const rid = await h.bind(adapter, cid, randomProcessId());
    const values = [3n, 0n, (1n << 40n) - 7n, 99n, 1n << 20n, 5n];
    await h.request(adapter, cid, rid, values, await h.reader.getPublicKey(cid));

    const memberSet = [1, 3];
    for (const i of memberSet) {
      await h.submit(await members[i - 1]!.partial(rid), 'direct', { action: 'submitPartial', params: `fields=${values.length}` });
    }

    // The combiner's job, done by anyone: M_k from public data, BSGS below 2^40, exact on-chain check.
    const request = await h.reader.getRequest(rid);
    const partials = new Map<number, Point[]>();
    for (const i of memberSet) partials.set(i, await h.reader.getPartial(rid, i));
    const table = BsgsTable.build();
    const solved = request.cts.map(([, , x2, y2], k) => ({
      fieldIndex: k,
      plaintext: solvePlaintext({ x: x2, y: y2 }, memberSet, new Map(memberSet.map((i) => [i, partials.get(i)![k]!])), { table }),
    }));
    const per = fieldsPerCombineTx(2);
    for (let off = 0; off < solved.length; off += per) {
      const args = buildCombineArgs(rid, memberSet, solved.slice(off, off + per));
      await h.submit({ kind: 'combine', ...args }, 'direct', { action: 'combine', params: `t=2, fields=${args.fieldIndexes.length}` });
    }
    expect(await h.waitPlaintexts(rid, 10_000)).toEqual(values);
    expect(await h.adapterPlaintexts(adapter, cid, rid, values.length)).toEqual({ ready: true, values });
  });
});
