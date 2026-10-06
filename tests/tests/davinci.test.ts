/**
 * DAVINCI round-trip: a davinci-contracts ProcessRegistry (COUNCIL key mode, MockZiskVerifier)
 * on the suite's Council manager, a real n = 5, t = 3 ceremony, and DAVINCI processes keyed by
 * it, created and read back through davinci-test (davinci-sdk). The state transitions are
 * skipped: the final accumulator (known tallies encrypted under the process key) is settled by
 * writing `latestStateRoot` to a single-leaf SMT root with `anvil_setStorageAt`. From there it
 * is the production path: `requestResultsDecryption` proves the accumulator against the root
 * and submits it through the CouncilAdapter, members post proven partials through the relayer
 * after the §9.3 checks, the relayer's worker combines, and `finalizeResultsFromDKG` stores the
 * tally in the registry.
 */

import { beforeAll, describe, expect, inject, it } from 'vitest';
import { COUNCIL_MANAGER_ABI, requestId as computeRequestId, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { decodeErrorResult, zeroAddress, zeroHash, type Abi, type TransactionReceipt } from 'viem';
import { ACCOUNT, anvilAccount, anvilKey, walletFor } from '../src/accounts.js';
import { Member, Organizer } from '../src/actors.js';
import {
  accumulator,
  buildDavinciContracts,
  buildDavinciTest,
  davinciArtifact,
  deployDavinciRegistry,
  expectedResult,
  latestStateRootSlot,
  resultsOnlyRoot,
  runCli,
  type Field,
} from '../src/davinci.js';
import { recordGas } from '../src/gas.js';
import { Harness } from '../src/harness.js';

const PHASE_LIVE = 3;
const STATUS = { ENDED: 1, RESULTS: 4 } as const;
const KEY_MODE_COUNCIL = 3;
/** Anvil account that no ceremony authorizes as a process creator. */
const STRANGER = 5;
const CAP = 10n ** 12n; // the registry's maxValue * maxVoters cap

interface OnchainProcess {
  status: number;
  latestStateRoot: Hex;
  result: readonly bigint[];
  keyMode: number;
  dkgEpochId: Hex;
  dkgAid: Hex;
  dkgCount: number;
  dkgZeroSkipped: number;
  dkgResultsRequested: boolean;
  organizationId: Hex;
}

interface Created {
  processId: Hex;
  transactionHash: Hex;
  ceremonyId: Hex;
  requestId: Hex;
  adapter: Hex;
  encryptionKey: { x: string; y: string };
}

interface Results {
  state: string;
  values?: string[];
  zeroSkipped?: number;
  error?: string;
  revertName?: string;
}

describe('DAVINCI round-trip: processes keyed by a Council ceremony (n=5, t=3)', () => {
  const h = new Harness(inject('council'));
  const org = new Organizer(h);
  const members: Member[] = [];
  const requester = h.direct; // requestResultsDecryption and finalizeResultsFromDKG are permissionless
  let cid: Hex;
  let registry: Hex;
  let adapter: Hex;
  let registryArtifact: ReturnType<typeof davinciArtifact>;
  let registryAbi: Abi;
  let errorsAbi: Abi;

  const cli = <T = Created>(args: string[], account: number = ACCOUNT.creator) =>
    runCli<T>(args, {
      DAVINCI_RPC_URL: h.ctx.rpcUrl,
      DAVINCI_REGISTRY: registry,
      COUNCIL_MANAGER: h.manager,
      DAVINCI_ORGANIZER_KEY: anvilKey(account),
      DAVINCI_VERIFY: 'off', // MockZiskVerifier: there is no verifier code or vadcop root to pin
    });

  const readRegistry = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    h.client.readContract({ address: registry, abi: registryAbi, functionName, args } as never) as Promise<T>;

  const readManager = <T>(functionName: string, args: readonly unknown[]): Promise<T> =>
    h.client.readContract({ address: h.manager, abi: COUNCIL_MANAGER_ABI, functionName, args } as never) as Promise<T>;

  const getProcess = (pid: Hex) => readRegistry<OnchainProcess>('getProcess', [pid]);

  /** The custom error in a viem error's cause chain, decoded against registry, adapter and manager. */
  const revertName = (err: unknown): string | undefined => {
    const seen = new Set<unknown>();
    let cur: unknown = err;
    while (cur && typeof cur === 'object' && !seen.has(cur)) {
      seen.add(cur);
      const o = cur as { raw?: unknown; data?: unknown };
      for (const raw of [o.raw, o.data]) {
        if (typeof raw === 'string' && /^0x[0-9a-fA-F]{8}/.test(raw)) {
          try {
            return decodeErrorResult({ abi: errorsAbi, data: raw as Hex }).errorName;
          } catch {
            // not ours
          }
        }
      }
      const decoded = (o.data as { errorName?: unknown } | undefined)?.errorName;
      if (typeof decoded === 'string') return decoded;
      cur = (cur as { cause?: unknown }).cause;
    }
    return undefined;
  };

  /** Simulate, then send a registry call from the requester; the receipt. */
  const registryTx = async (functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> => {
    const { request } = await h.client.simulateContract({
      address: registry,
      abi: registryAbi,
      functionName,
      args,
      account: requester.account ?? null,
    } as never);
    const hash = await requester.writeContract(request as never);
    const receipt = await h.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
    return receipt;
  };

  /** The registry call must revert with `name` (simulated, nothing sent). */
  const expectRegistryRevert = async (functionName: string, args: readonly unknown[], name: string) => {
    const err = await h.client
      .simulateContract({ address: registry, abi: registryAbi, functionName, args, account: requester.account ?? null } as never)
      .then(() => undefined, (e: unknown) => e);
    expect(err, `${functionName} should revert ${name}`).toBeDefined();
    expect(revertName(err)).toBe(name);
  };

  beforeAll(async () => {
    buildDavinciContracts();
    buildDavinciTest();
    registryArtifact = davinciArtifact('ProcessRegistry.sol', 'ProcessRegistry');
    registryAbi = registryArtifact.abi;
    const adapterAbi = davinciArtifact('CouncilAdapter.sol', 'CouncilAdapter').abi;
    errorsAbi = [...registryAbi, ...adapterAbi, ...(COUNCIL_MANAGER_ABI as Abi)].filter((e) => e.type === 'error');

    ({ registry, adapter } = await deployDavinciRegistry(
      walletFor(h.ctx.rpcUrl, ACCOUNT.deployer),
      h.client,
      Number(h.chainId),
      h.manager,
    ));
    expect(adapter).not.toBe(zeroAddress);
  });

  it('runs a 5-member, threshold-3 ceremony to Live with real proofs', async () => {
    const created = await org.create({ threshold: 3, invites: 5 });
    cid = created.cid;
    await h.submit(created.action, 'relayer', { action: 'createCeremony', params: 'invites=5' });
    for (let i = 0; i < 5; i++) {
      const m = new Member(h, cid);
      members.push(m);
      await h.submit(await m.join(org.inviteLink(cid, i)), 'relayer', { action: 'join' });
    }
    await h.submit(await org.close(cid, 5), 'relayer', { action: 'closeRegistration', params: 'n=5' });
    for (const m of members) await h.submit(await m.deal(), 'relayer', { action: 'deal', params: 'n=5, t=3' });
    await h.submit({ kind: 'finalize', ceremonyId: cid }, 'relayer', { action: 'finalize', params: 'n=5, t=3, |QUAL|=5' });
    const view = await h.reader.getCeremony(cid);
    expect(view.phase).toBe(PHASE_LIVE);
    expect(view.qualBitmap).toBe(0b11111);
    expect(members.map((m) => m.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses a process until the organizer allows the registry adapter; then allows it and the creator', async () => {
    const before = await cli<Results>(['create', '--ceremony', cid]);
    expect(before.code).toBe(1);
    expect(before.out.revertName).toBe('NotAllowedAdapter');

    await h.submit(await org.allowAdapter(cid, adapter), 'relayer', { action: 'allowAdapter' });
    await h.submit(await org.authorizeCreator(cid, h.creator), 'relayer', { action: 'authorizeCreator' });
    expect(await readManager<boolean>('isAdapterAllowed', [cid, adapter])).toBe(true);
    expect(await readManager<boolean>('isCreatorAuthorized', [cid, h.creator])).toBe(true);
  });

  it('refuses a process created by an account the ceremony does not authorize', async () => {
    const stranger = anvilAccount(STRANGER).address;
    const sent = await h.client.getTransactionCount({ address: stranger });
    const refused = await cli<Results>(['create', '--ceremony', cid], STRANGER);
    expect(refused.code).toBe(1);
    expect(refused.out.revertName).toBe('NotAuthorizedCreator');
    // Refused at simulation: nothing sent, no process, no binding.
    expect(await h.client.getTransactionCount({ address: stranger })).toBe(sent);
    expect(await readRegistry<bigint>('processNonce', [stranger])).toBe(0n);
    expect(await readManager<readonly Hex[]>('getRequestIds', [cid])).toEqual([]);
  });

  /**
   * One process from creation to stored results: `fields` are the final tally per ballot field
   * (identity fields were never written: the registry records them as zero without the
   * committee), decrypted by `decryptors` (1-based member indexes).
   */
  const roundTrip = async (o: { title: string; fields: Field[]; decryptors: number[]; finalizeVia: 'registry' | 'davinci-sdk' }) => {
    const numFields = o.fields.length;
    const active = o.fields.flatMap((f) => ('identity' in f ? [] : [f.value]));
    const zeroSkipped = o.fields.reduce((mask, f, i) => ('identity' in f ? mask | (1 << i) : mask), 0);

    // Created through the test app (davinci-sdk facade, keyMode 'council').
    const created = await cli(['create', '--ceremony', cid, '--fields', String(numFields), '--title', o.title]);
    expect(created.code, created.stderr).toBe(0);
    const { processId: pid, requestId: rid } = created.out;
    const key = await h.reader.getPublicKey(cid);
    expect({ x: BigInt(created.out.encryptionKey.x), y: BigInt(created.out.encryptionKey.y) }).toEqual(key);
    expect(created.out.adapter.toLowerCase()).toBe(adapter);
    expect(rid).toBe(computeRequestId(h.chainId, h.manager, cid, adapter, pid));
    const p0 = await getProcess(pid);
    expect(p0.keyMode).toBe(KEY_MODE_COUNCIL);
    expect(p0.dkgEpochId).toBe(cid);
    expect(p0.dkgAid).toBe(rid);
    expect(p0.organizationId.toLowerCase()).toBe(h.creator);
    const createdReceipt = await h.client.getTransactionReceipt({ hash: created.out.transactionHash });
    recordGas('newProcess (council)', `fields=${numFields}`, 'davinci-sdk', createdReceipt.gasUsed);

    // The final tally, encrypted under the process key, settled as the only leaf of the state.
    const acc = accumulator(o.fields, key);
    const root = resultsOnlyRoot(acc);
    const ended = await cli<{ ended: boolean }>(['end', '--process', pid]);
    expect(ended.code, ended.stderr).toBe(0);
    await h.test.setStorageAt({ address: registry, index: latestStateRootSlot(registryArtifact, pid), value: root });
    const p1 = await getProcess(pid);
    expect(p1.latestStateRoot).toBe(root);
    expect(p1.status).toBe(STATUS.ENDED);

    const request = [pid, acc, [zeroHash]] as const;
    await expectRegistryRevert('requestResultsDecryption', request, 'GraceOpen');
    const graceEnd = await readRegistry<bigint>('getProcessGraceEnd', [pid]);
    await h.warp(graceEnd - (await h.now()) + 1n);
    const swapped = [...acc.slice(4, 8), ...acc.slice(0, 4), ...acc.slice(8)]; // fields 0 and 1 exchanged
    await expectRegistryRevert('requestResultsDecryption', [pid, swapped, [zeroHash]], 'InvalidInclusionProof');

    const requested = await registryTx('requestResultsDecryption', request);
    recordGas('requestResultsDecryption', `fields=${numFields}, active=${active.length}`, 'direct', requested.gasUsed);
    const p2 = await getProcess(pid);
    expect(p2.dkgResultsRequested).toBe(true);
    expect(p2.dkgCount).toBe(active.length);
    expect(p2.dkgZeroSkipped).toBe(zeroSkipped);
    const req = await h.reader.getRequest(rid);
    expect(req.ceremonyId).toBe(cid);
    expect(req.fieldCount).toBe(active.length);
    const activeCts = o.fields.flatMap((f, i) => ('identity' in f ? [] : [acc.slice(4 * i, 4 * i + 4)]));
    expect(req.cts).toEqual(activeCts);
    await expectRegistryRevert('finalizeResultsFromDKG', [pid], 'ResultsNotReady');
    expect((await cli<Results>(['results', '--process', pid])).out.state).toBe('decrypting');

    // §9.3 item 3: the request was bound by an adapter the ceremony allows, for this process;
    // Member.partial runs the rest (authenticated snapshot, subgroup checks, share against PK_i).
    const [originAdapter, originPid, originCreator] = await readManager<readonly [Hex, Hex, Hex]>('getRequestOrigin', [rid]);
    expect([originAdapter.toLowerCase(), originPid, originCreator.toLowerCase()]).toEqual([adapter, pid, h.creator]);
    expect(await readManager<boolean>('isAdapterAllowed', [cid, originAdapter])).toBe(true);
    for (const index of o.decryptors) {
      const m = members[index - 1] as Member;
      await h.submit(await m.partial(rid), 'relayer', { action: 'submitPartial', params: `fields=${active.length}` });
    }

    expect(await h.waitPlaintexts(rid)).toEqual(active);
    for (const c of await h.recordCombineGas(rid, 3)) {
      expect(c.memberSet).toEqual(o.decryptors);
      expect(c.sender).toBe(h.relayerAddress);
    }
    expect((await cli<Results>(['results', '--process', pid])).out.state).toBe('finalizable');

    let results: Results;
    if (o.finalizeVia === 'registry') {
      const finalized = await registryTx('finalizeResultsFromDKG', [pid]);
      recordGas('finalizeResultsFromDKG', `fields=${numFields}`, 'direct', finalized.gasUsed);
      results = (await cli<Results>(['results', '--process', pid])).out;
    } else {
      const from = await h.client.getBlockNumber();
      const r = await cli<Results>(['results', '--process', pid, '--finalize']);
      expect(r.code, r.stderr).toBe(0);
      results = r.out;
      const [log] = await h.client.getContractEvents({
        address: registry,
        abi: registryAbi,
        eventName: 'ProcessResultsSet',
        args: { processId: pid },
        fromBlock: from,
      } as never);
      const receipt = await h.client.getTransactionReceipt({ hash: (log as { transactionHash: Hex }).transactionHash });
      recordGas('finalizeResultsFromDKG', `fields=${numFields}`, 'davinci-sdk', receipt.gasUsed);
    }

    // Read back through davinci-sdk: every field, the identity ones as zero.
    const want = expectedResult(o.fields);
    expect(results.state).toBe('results');
    expect(results.values).toEqual(want.map(String));
    expect(results.zeroSkipped).toBe(zeroSkipped);
    const p3 = await getProcess(pid);
    expect(p3.status).toBe(STATUS.RESULTS);
    expect([...p3.result]).toEqual(want);
    return { pid, rid };
  };

  let first: Hex;

  it('process A: eight fields (an encrypted zero, two never-written, the 1e12 cap) decrypted by members 1, 3, 5', async () => {
    const { rid } = await roundTrip({
      title: 'Council round-trip A',
      fields: [
        { value: 3n },
        { value: 0n },
        { identity: true },
        { value: 123_456_789n },
        { value: CAP },
        { value: 1n },
        { identity: true },
        { value: 999_999n },
      ],
      decryptors: [1, 3, 5],
      finalizeVia: 'registry',
    });
    first = rid;
  });

  it('process B on the same ceremony: decrypted by members 2, 4, 5 and finalized through davinci-sdk', async () => {
    const { rid } = await roundTrip({
      title: 'Council round-trip B',
      fields: [{ identity: true }, { value: 42n }, { value: 0n }, { value: CAP - 1n }],
      decryptors: [2, 4, 5],
      finalizeVia: 'davinci-sdk',
    });
    expect(rid).not.toBe(first);
    expect(await readManager<readonly Hex[]>('getRequestIds', [cid])).toEqual([first, rid]);
  });
});
