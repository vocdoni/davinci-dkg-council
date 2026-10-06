/**
 * Regression tests for the 2026-10 security review findings:
 * 1. gated partial decryption (snapshot + §9.3 checks)
 * 2. anchor authentication in authenticatedRead
 * 3. devMode restricted to local chains, duplicate endpoints rejected
 * 4. chain-authenticated restore and rehearsal against retained keys
 * 5. WorkerProver lifecycle (terminate/error/decode failures)
 * 6. relayer chainId as canonical decimal string
 * 7. JCS lone-surrogate rejection
 */

import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { CouncilClient, NotFinalizedYetError } from '../src/client.js';
import { buildPartialDecryption } from '../src/partial.js';
import { addPoints, G, mulBase, mulPoint, pointEq } from '../src/curve.js';
import { P, Phase } from '../src/constants.js';
import { toDecimal } from '../src/encoding.js';
import { kitEntryIdentity, rehearseEntry, type KitManifestEntry } from '../src/kit.js';
import { participantAuthKey, rootFromMnemonic, shareEncryptionKey } from '../src/keys.js';
import { WorkerProver, type WorkerLike } from '../src/prover.js';
import { relayRequestBody } from '../src/relayer.js';
import { jcsCanonicalize } from '../src/jcs.js';
import type { Hex, PartialRequestSnapshot, Point } from '../src/types.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const MANAGER: Hex = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const CID: Hex = '0xba92d83fa5be494b998b1667';
const REQ: Hex = `0x${'ab'.repeat(32)}`;

const BLOCK = { hash: `0x${'cc'.repeat(32)}`, number: 100n };

/** Order-2 torsion point: on curve, canonical, not in the prime subgroup. */
const TORSION: Point = { x: 0n, y: P - 1n };

const SHARE = 7n;
const PK = mulBase(SHARE);
const C1S: Point[] = [mulBase(5n), mulBase(9n)];

const ceremonyView = (over: Record<string, unknown> = {}) => ({
  phase: Phase.Live,
  organizer: MANAGER,
  threshold: 2,
  n: 3,
  registrationDeadline: 0n,
  dealingDeadline: 0n,
  joinedCount: 3,
  dealtCount: 3,
  rosterHash: `0x${'dd'.repeat(32)}`,
  ctx: `0x${'ee'.repeat(32)}`,
  inviteCount: 3,
  consumedInvites: 0n,
  qualBitmap: 7,
  pkX: 1n,
  pkY: 2n,
  ...over,
});

const requestRow = (c1s: Point[], fieldCount = c1s.length) => [
  CID,
  fieldCount,
  0,
  0,
  Array.from({ length: 16 }, (_, k) => {
    const c1 = c1s[k] ?? G;
    return [c1.x, c1.y, G.x, G.y];
  }),
];

type Views = Record<string, (args: readonly unknown[]) => unknown>;

const stubClient = (views: Views, over: Record<string, unknown> = {}): PublicClient =>
  ({
    getChainId: async () => 31337,
    getBlock: async () => BLOCK,
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      const fn = views[functionName];
      if (!fn) throw new Error(`stub: no view ${functionName}`);
      return fn(args);
    },
    ...over,
  }) as unknown as PublicClient;

const twoOf = (views: Views) => [stubClient(views), stubClient(views)];

const PINS = { chainId: 31337n, manager: MANAGER };

describe('fix 1: gated partial decryption (§9.3)', () => {
  const healthy: Views = {
    getRequest: () => requestRow(C1S),
    getCeremony: () => ceremonyView(),
    getMemberKey: () => [PK.x, PK.y],
  };
  const client = (views: Views = healthy) =>
    new CouncilClient({ chainId: 31337n, manager: MANAGER, clients: twoOf(views) });

  it('happy path: snapshot + checks + D_k = s·C1_k', async () => {
    const snapshot = await client().getPartialRequestSnapshot(REQ, 1);
    const built = buildPartialDecryption(snapshot, SHARE, PINS);
    expect(pointEq(built.D[0] as Point, mulPoint(C1S[0] as Point, SHARE))).toBe(true);
    expect(pointEq(built.D[1] as Point, mulPoint(C1S[1] as Point, SHARE))).toBe(true);
    expect(built.witnessInput.s).toBe(toDecimal(SHARE));
  });

  it('rejects a nonexistent request (fieldCount 0)', async () => {
    const c = client({ ...healthy, getRequest: () => requestRow([], 0) });
    await expect(c.getPartialRequestSnapshot(REQ, 1)).rejects.toThrow(/request does not exist/);
  });

  it('rejects a request bound to a different ceremony than expected', async () => {
    await expect(
      client().getPartialRequestSnapshot(REQ, 1, { expectedCeremonyId: `0x${'99'.repeat(12)}` }),
    ).rejects.toThrow(/different ceremony/);
  });

  it('rejects a non-Live ceremony', async () => {
    const c = client({ ...healthy, getCeremony: () => ceremonyView({ phase: Phase.Dealing }) });
    await expect(c.getPartialRequestSnapshot(REQ, 1)).rejects.toThrow(/not Live/);
  });

  it('rejects a participant index outside the roster', async () => {
    await expect(client().getPartialRequestSnapshot(REQ, 5)).rejects.toThrow(/outside the roster/);
    await expect(client().getPartialRequestSnapshot(REQ, 0)).rejects.toThrow(/outside the roster/);
  });

  it('rejects the order-2 torsion point (0, p-1) as C1', async () => {
    const c = client({ ...healthy, getRequest: () => requestRow([TORSION, C1S[1] as Point]) });
    const snapshot = await c.getPartialRequestSnapshot(REQ, 1);
    expect(() => buildPartialDecryption(snapshot, SHARE, PINS)).toThrow(/prime-order subgroup/);
  });

  it('rejects a point with a torsion component (G + T)', async () => {
    const mixed = addPoints(G, TORSION);
    const c = client({ ...healthy, getRequest: () => requestRow([mixed]) });
    const snapshot = await c.getPartialRequestSnapshot(REQ, 1);
    expect(() => buildPartialDecryption(snapshot, SHARE, PINS)).toThrow(/prime-order subgroup/);
  });

  it('rejects a share that does not match the on-chain PK_i', async () => {
    const snapshot = await client().getPartialRequestSnapshot(REQ, 1);
    expect(() => buildPartialDecryption(snapshot, SHARE + 1n, PINS)).toThrow(/on-chain PK_i/);
  });

  it('rejects snapshots from another deployment (chain/manager pins)', async () => {
    const snapshot = await client().getPartialRequestSnapshot(REQ, 1);
    expect(() => buildPartialDecryption(snapshot, SHARE, { ...PINS, chainId: 1n })).toThrow(/pinned chain/);
    expect(() =>
      buildPartialDecryption(snapshot, SHARE, { ...PINS, manager: `0x${'77'.repeat(20)}` }),
    ).toThrow(/pinned manager/);
  });

  it('re-checks phase and bounds even on a hand-forged snapshot', async () => {
    const good = await client().getPartialRequestSnapshot(REQ, 1);
    const forged = { ...good, phase: Phase.Dealing } as PartialRequestSnapshot;
    expect(() => buildPartialDecryption(forged, SHARE, PINS)).toThrow(/not Live/);
    const outOfRoster = { ...good, participantIndex: 9 } as PartialRequestSnapshot;
    expect(() => buildPartialDecryption(outOfRoster, SHARE, PINS)).toThrow(/outside the roster/);
  });
});

describe('fix 2: anchors are authenticated, not trusted', () => {
  const views: Views = { circuitReleaseId: () => `0x${'11'.repeat(32)}` };
  const client = (clients = twoOf(views)) => new CouncilClient({ chainId: 31337n, manager: MANAGER, clients });

  it('accepts anchors it issued itself', async () => {
    const c = client();
    const anchor = await c.finalizedAnchor();
    const { results } = await c.authenticatedRead([{ functionName: 'circuitReleaseId' }], anchor);
    expect(results[0]).toBe(`0x${'11'.repeat(32)}`);
  });

  it('rejects a forged anchor hash', async () => {
    const forged = { blockNumber: 100n, blockHash: `0x${'ee'.repeat(32)}` as Hex };
    await expect(client().authenticatedRead([{ functionName: 'circuitReleaseId' }], forged)).rejects.toThrow(
      /anchor block hash does not match/,
    );
  });

  it('rejects an anchor past the finalized head', async () => {
    const getBlock = async (args?: { blockNumber?: bigint }) =>
      args?.blockNumber !== undefined ? { hash: `0x${'ff'.repeat(32)}`, number: args.blockNumber } : BLOCK;
    const clients = [stubClient(views, { getBlock }), stubClient(views, { getBlock })];
    const unfinalized = { blockNumber: 200n, blockHash: `0x${'ff'.repeat(32)}` as Hex };
    await expect(client(clients).authenticatedRead([{ functionName: 'circuitReleaseId' }], unfinalized)).rejects.toThrow(
      /not finalized on every provider/,
    );
  });

  it('re-validates a foreign anchor and accepts it when the chain confirms it', async () => {
    const foreign = { blockNumber: 100n, blockHash: BLOCK.hash as Hex };
    const { results } = await client().authenticatedRead([{ functionName: 'circuitReleaseId' }], foreign);
    expect(results[0]).toBe(`0x${'11'.repeat(32)}`);
  });

  it('verifies the chain id before honoring a foreign anchor', async () => {
    const wrong = stubClient(views, { getChainId: async () => 1 });
    const c = client([stubClient(views), wrong]);
    const foreign = { blockNumber: 100n, blockHash: BLOCK.hash as Hex };
    await expect(c.authenticatedRead([{ functionName: 'circuitReleaseId' }], foreign)).rejects.toThrow(
      /serves chain 1/,
    );
  });
});

describe('fix 3: devMode and endpoint independence', () => {
  it('permits devMode single-RPC only on local chains (31337/1337)', () => {
    expect(
      () => new CouncilClient({ chainId: 100n, manager: MANAGER, clients: [stubClient({})], devMode: true }),
    ).toThrow(/local development chain/);
    expect(
      () => new CouncilClient({ chainId: 1337n, manager: MANAGER, clients: [stubClient({})], devMode: true }),
    ).not.toThrow();
  });

  it('rejects duplicate RPC endpoints after normalization', () => {
    expect(
      () =>
        new CouncilClient({
          chainId: 31337n,
          manager: MANAGER,
          rpcUrls: ['http://localhost:8545', 'http://LOCALHOST:8545/'],
        }),
    ).toThrow(/duplicate RPC endpoints/);
  });
});

describe('fix 4: restore authenticates against chain state', () => {
  const root = rootFromMnemonic(MNEMONIC);
  const keyCtx = { chainId: 31337n, manager: MANAGER, ceremonyId: CID };
  const auth = participantAuthKey(root, keyCtx);
  const share = shareEncryptionKey(root, keyCtx);
  const entry: KitManifestEntry = {
    role: 'participant',
    chainId: '31337',
    manager: MANAGER,
    ceremonyId: CID,
    accountIndex: 0,
    authAddress: auth.address.toLowerCase() as Hex,
    sharePublicKey: { x: toDecimal(share.publicKey.x), y: toDecimal(share.publicKey.y) },
  };
  const otherAddr: Hex = `0x${'44'.repeat(20)}`;

  const chain = (participants: [Hex, bigint, bigint, boolean][], view = ceremonyView({ n: participants.length })) =>
    new CouncilClient({
      chainId: 31337n,
      manager: MANAGER,
      clients: twoOf({
        getCeremony: () => view,
        getParticipant: (args) => participants[(args[1] as number) - 1],
      }),
    });

  it('finds the participant, cross-checks X_i and returns chain-derived index/rosterHash', async () => {
    const identity = kitEntryIdentity(root, entry);
    const client = chain([
      [otherAddr, 1n, 2n, true],
      [auth.address.toLowerCase() as Hex, share.publicKey.x, share.publicKey.y, true],
    ]);
    const res = await client.verifyRestoredIdentity(identity);
    expect(res.ok).toBe(true);
    expect(res.participantIndex).toBe(2);
    expect(res.rosterHash).toBe(ceremonyView().rosterHash);
  });

  it('flags a chain X_i that does not match the derived key', async () => {
    const identity = kitEntryIdentity(root, entry);
    const client = chain([[auth.address.toLowerCase() as Hex, 1n, 2n, true]]);
    const res = await client.verifyRestoredIdentity(identity);
    expect(res.ok).toBe(false);
    expect(res.mismatches.join()).toMatch(/sharePublicKey/);
  });

  it('flags an unregistered derived identity', async () => {
    const identity = kitEntryIdentity(root, entry);
    const client = chain([[otherAddr, 1n, 2n, true]]);
    const res = await client.verifyRestoredIdentity(identity);
    expect(res.ok).toBe(false);
    expect(res.mismatches.join()).toMatch(/not registered/);
  });

  it('authenticates an organizer against the ceremony organizer', async () => {
    const orgEntry: KitManifestEntry = {
      role: 'organizer',
      chainId: '31337',
      manager: MANAGER,
      ceremonyId: CID,
      accountIndex: 0,
      authAddress: `0x${'55'.repeat(20)}`,
    };
    const identity = kitEntryIdentity(root, orgEntry);
    const asOrganizer = new CouncilClient({
      chainId: 31337n,
      manager: MANAGER,
      clients: twoOf({ getCeremony: () => ceremonyView({ organizer: identity.authAddress }) }),
    });
    expect((await asOrganizer.verifyRestoredIdentity(identity)).ok).toBe(true);
    const asStranger = new CouncilClient({
      chainId: 31337n,
      manager: MANAGER,
      clients: twoOf({ getCeremony: () => ceremonyView() }),
    });
    const res = await asStranger.verifyRestoredIdentity(identity);
    expect(res.ok).toBe(false);
    expect(res.mismatches.join()).toMatch(/organizer/);
  });

  it('rehearses against locally retained prepared join keys, not the manifest', () => {
    // Tampered manifest self-consistent with its checksum: the kit comparison
    // alone cannot catch it, the retained expected keys do.
    const tampered: KitManifestEntry = { ...entry, authAddress: otherAddr };
    const vsKit = rehearseEntry(root, tampered);
    const vsExpected = rehearseEntry(root, tampered, {
      authAddress: auth.address.toLowerCase() as Hex,
      sharePublicKey: share.publicKey,
    });
    expect(vsKit.ok).toBe(false); // derived != tampered manifest
    expect(vsExpected.ok).toBe(true); // derived == retained keys
    const wrongExpected = rehearseEntry(root, entry, { authAddress: otherAddr });
    expect(wrongExpected.ok).toBe(false);
    expect(wrongExpected.mismatches.join()).toMatch(/expected/);
  });
});

describe('fix 5: WorkerProver lifecycle', () => {
  const ARTIFACTS = { deal: { wasm: 'w', zkey: 'z' }, partial: { wasm: 'w', zkey: 'z' } };
  const WITNESS = { PK: ['1', '2'], activeCount: '1', C1: [['1', '2']], D: [['1', '2']], s: '3' };

  const makeWorker = () => {
    const listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
    let terminated = false;
    const worker: WorkerLike = {
      postMessage: () => {},
      addEventListener: (type, listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      terminate: () => {
        terminated = true;
      },
    };
    return {
      worker,
      emit: (type: string, data?: unknown) => (listeners.get(type) ?? []).forEach((l) => l({ data })),
      wasTerminated: () => terminated,
    };
  };

  it('terminate rejects every pending proof and later proofs', async () => {
    const { worker, wasTerminated } = makeWorker();
    const prover = new WorkerProver(worker, ARTIFACTS);
    const p1 = prover.prove('partial', WITNESS);
    const p2 = prover.prove('partial', WITNESS);
    prover.terminate();
    await expect(p1).rejects.toThrow(/terminated/);
    await expect(p2).rejects.toThrow(/terminated/);
    await expect(prover.prove('partial', WITNESS)).rejects.toThrow(/terminated/);
    expect(wasTerminated()).toBe(true);
  });

  it('a worker error event rejects all pending proofs', async () => {
    const { worker, emit } = makeWorker();
    const prover = new WorkerProver(worker, ARTIFACTS);
    const p1 = prover.prove('partial', WITNESS);
    const p2 = prover.prove('deal', WITNESS as never);
    emit('error');
    await expect(p1).rejects.toThrow(/worker error/);
    await expect(p2).rejects.toThrow(/worker error/);
  });

  it('a messageerror event rejects all pending proofs', async () => {
    const { worker, emit } = makeWorker();
    const prover = new WorkerProver(worker, ARTIFACTS);
    const p = prover.prove('partial', WITNESS);
    emit('messageerror');
    await expect(p).rejects.toThrow(/deserialization/);
  });

  it('a response that fails to decode rejects its own proof', async () => {
    const { worker, emit } = makeWorker();
    const prover = new WorkerProver(worker, ARTIFACTS);
    const p = prover.prove('partial', WITNESS);
    emit('message', { id: 1, proof: { pi_a: [], pi_b: [], pi_c: [] }, publicSignals: ['1'] });
    await expect(p).rejects.toThrow(/failed to decode/);
  });

  it('a well-formed response still resolves', async () => {
    const { worker, emit } = makeWorker();
    const prover = new WorkerProver(worker, ARTIFACTS);
    const p = prover.prove('partial', WITNESS);
    emit('message', {
      id: 1,
      proof: { pi_a: ['1', '2', '1'], pi_b: [['3', '4'], ['5', '6'], ['1', '0']], pi_c: ['7', '8', '1'] },
      publicSignals: ['9'],
    });
    const res = await p;
    expect(res.proof.pB).toEqual([
      [4n, 3n],
      [6n, 5n],
    ]);
    expect(res.publicSignals).toEqual([9n]);
  });
});

describe('fix 6: relayer chainId precision', () => {
  it('serializes chain ids beyond 2^53 without rounding', () => {
    const big = (1n << 60n) + 1n;
    const body = relayRequestBody(big, MANAGER, { kind: 'abort', ceremonyId: CID });
    expect(body.chainId).toBe('1152921504606846977');
    expect(typeof body.chainId).toBe('string');
  });
});

describe('fix 7: JCS rejects lone UTF-16 surrogates', () => {
  it('rejects lone surrogates in strings and keys', () => {
    expect(() => jcsCanonicalize('\ud800')).toThrow(/lone UTF-16 surrogate/);
    expect(() => jcsCanonicalize('a\udfffb')).toThrow(/lone UTF-16 surrogate/);
    expect(() => jcsCanonicalize({ ['k\ud800']: 1 })).toThrow(/lone UTF-16 surrogate/);
    expect(() => jcsCanonicalize(['x', { ok: '\udc00' }])).toThrow(/lone UTF-16 surrogate/);
  });

  it('accepts well-formed surrogate pairs', () => {
    expect(jcsCanonicalize('😀')).toBe(JSON.stringify('😀'));
  });
});

describe('not-finalized-yet detection (post-deploy reads)', () => {
  const CODE = '0x6001';
  const failing: Views = {
    getCeremony: () => {
      throw new Error('decode boom');
    },
  };
  const CALL = [{ functionName: 'getCeremony', args: [CID] as const }];
  /** getCode stub: `latest` has code, the finalized anchor does not (yet). */
  const codeAt = (anchor: string | undefined, latest: string | undefined) =>
    async ({ blockTag }: { blockTag?: string }) => (blockTag === 'latest' ? latest : anchor);
  const probe = (anchorCode: string | undefined, latestCode: string | undefined) => ({
    getCode: codeAt(anchorCode, latestCode),
    getBlockNumber: async () => 120n,
  });
  const client = (over: Record<string, unknown>, views: Views = failing) =>
    new CouncilClient({
      chainId: 31337n,
      manager: MANAGER,
      clients: [stubClient(views, over), stubClient(views, over)],
    });

  it('read failure + no code at anchor + code at latest → NotFinalizedYetError with heights', async () => {
    const err = await client(probe('0x', CODE))
      .authenticatedRead(CALL)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(NotFinalizedYetError);
    const nfy = err as NotFinalizedYetError;
    expect(nfy.name).toBe('NotFinalizedYetError');
    expect(nfy.manager).toBe(MANAGER);
    expect(nfy.finalizedBlock).toBe(100n);
    expect(nfy.latestBlock).toBe(120n);
    expect(nfy.message).toMatch(/not finalized yet/);
  });

  it('no code anywhere → wrong-address error, not NotFinalizedYet', async () => {
    await expect(client(probe(undefined, '0x')).authenticatedRead(CALL)).rejects.toThrow(/no contract code/);
  });

  it('code present at the anchor → original error propagates', async () => {
    await expect(client(probe(CODE, CODE)).authenticatedRead(CALL)).rejects.toThrow(/decode boom/);
  });

  it('probe unavailable → original error propagates', async () => {
    await expect(client({}).authenticatedRead(CALL)).rejects.toThrow(/decode boom/);
  });

  it('waitForFinalizedDeployment resolves once every provider has code, reporting progress', async () => {
    let calls = 0;
    const over = {
      getCode: async () => (++calls <= 4 ? '0x' : CODE), // 2 providers/poll → code on poll 3
      getBlockNumber: async () => 120n,
    };
    const progress: { finalizedBlock: bigint; latestBlock: bigint }[] = [];
    const anchor = await client(over).waitForFinalizedDeployment({
      pollMs: 1,
      onProgress: (p) => progress.push(p),
    });
    expect(anchor.blockNumber).toBe(100n);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toEqual({ finalizedBlock: 100n, latestBlock: 120n });
  });

  it('waitForFinalizedDeployment times out with NotFinalizedYetError', async () => {
    const over = { getCode: async () => '0x', getBlockNumber: async () => 120n };
    await expect(client(over).waitForFinalizedDeployment({ pollMs: 1, timeoutMs: 5 })).rejects.toBeInstanceOf(
      NotFinalizedYetError,
    );
  });
});
