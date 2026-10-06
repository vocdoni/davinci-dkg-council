/** Unit tests for the relayer wire format, artifact pinning, action encoding and the chain client. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type PublicClient } from 'viem';
import { sha256 } from '@noble/hashes/sha2';
import { RelayerClient, RelayerError, relayRequestBody } from '../src/relayer.js';
import { fetchArtifact, verifyArtifactBytes, artifactUrl, type ArtifactFile } from '../src/artifacts.js';
import { CouncilClient, encodeAction } from '../src/client.js';
import { COUNCIL_MANAGER_ABI } from '../src/abi.js';
import { FakeProver, proofFromSnarkjs } from '../src/prover.js';
import { dealPublicSignals } from '../src/dealing.js';
import { G, IDENTITY } from '../src/curve.js';
import type { Action, DealPayload, Hex } from '../src/types.js';

const MANAGER: Hex = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const CID: Hex = '0xba92d83fa5be494b998b1667';
const SIG: Hex = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;

const dealPayload: DealPayload = {
  C: Array.from({ length: 16 }, (_, k) => (k < 2 ? G : IDENTITY)),
  E: G,
  masked: Array.from({ length: 16 }, (_, i) => (i < 3 ? BigInt(i + 100) : 0n)),
  proof: { pA: [1n, 2n], pB: [[3n, 4n], [5n, 6n]], pC: [7n, 8n] },
};

describe('relayer wire format (§5.1)', () => {
  it('join carries nested message and both signatures', () => {
    const body = relayRequestBody(31337n, MANAGER, {
      kind: 'join',
      message: { ceremonyId: CID, participant: MANAGER, inviteId: 3, pkX: 10n, pkY: 11n, popAx: 1n, popAy: 2n, popZ: 3n, validUntil: 2000000000n },
      signature: SIG,
      invite: { ceremonyId: CID, inviteId: 3, participant: MANAGER, pkX: 10n, pkY: 11n, validUntil: 2000000000n },
      inviteSignature: `0x${'33'.repeat(64)}1c`,
    });
    expect(body).toEqual({
      action: 'join',
      chainId: '31337',
      manager: MANAGER,
      message: {
        join: {
          ceremonyId: CID,
          participant: MANAGER,
          inviteId: '3',
          pkX: '10',
          pkY: '11',
          popAx: '1',
          popAy: '2',
          popZ: '3',
          validUntil: '2000000000',
        },
        invite: { ceremonyId: CID, inviteId: '3', participant: MANAGER, pkX: '10', pkY: '11', validUntil: '2000000000' },
      },
      signatures: [SIG, `0x${'33'.repeat(64)}1c`],
    });
  });

  it('deal carries decimal-string payload with nested proof', () => {
    const body = relayRequestBody(31337n, MANAGER, {
      kind: 'deal',
      message: { ceremonyId: CID, dealerIndex: 1, payloadHash: `0x${'aa'.repeat(32)}`, validUntil: 2000000000n },
      signature: SIG,
      payload: dealPayload,
    }) as { payload: { C: string[][]; E: string[]; masked: string[]; proof: { pB: string[][] } } };
    expect(body.payload.C[0]).toEqual([G.x.toString(), G.y.toString()]);
    expect(body.payload.C[15]).toEqual(['0', '1']);
    expect(body.payload.E).toEqual([G.x.toString(), G.y.toString()]);
    expect(body.payload.masked[0]).toBe('100');
    expect(body.payload.proof.pB).toEqual([['3', '4'], ['5', '6']]);
  });

  it('finalize and combine shapes', () => {
    expect(relayRequestBody(31337n, MANAGER, { kind: 'finalize', ceremonyId: CID })).toEqual({
      action: 'finalize',
      chainId: '31337',
      manager: MANAGER,
      payload: { ceremonyId: CID },
    });
    const body = relayRequestBody(31337n, MANAGER, {
      kind: 'combine',
      requestId: `0x${'bb'.repeat(32)}`,
      memberSet: [1, 3],
      fieldIndexes: [0, 2],
      plaintexts: [7n, (1n << 40n) - 1n],
    });
    expect(body).toEqual({
      action: 'combine',
      chainId: '31337',
      manager: MANAGER,
      payload: {
        requestId: `0x${'bb'.repeat(32)}`,
        memberSet: [1, 3],
        fieldIndexes: [0, 2],
        plaintexts: ['7', '1099511627775'],
      },
    });
  });
});

describe('relayer client', () => {
  const fetchJson = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('relay returns the tx hash on success', async () => {
    const client = new RelayerClient('http://relayer.local/', { fetchFn: fetchJson(200, { txHash: '0xabc' }) });
    const tx = await client.relay(31337n, MANAGER, { kind: 'abort', ceremonyId: CID });
    expect(tx).toBe('0xabc');
  });

  it('relay surfaces the pinned error shape', async () => {
    const client = new RelayerClient('http://relayer.local', {
      fetchFn: fetchJson(409, { error: 'WRONG_PHASE', detail: 'ceremony is not in Dealing', revertData: '0x1234' }),
    });
    const err = await client.relay(31337n, MANAGER, { kind: 'abort', ceremonyId: CID }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayerError);
    const re = err as RelayerError;
    expect(re.code).toBe('WRONG_PHASE');
    expect(re.revertData).toBe('0x1234');
    expect(re.httpStatus).toBe(409);
  });

  it('status and health round trip', async () => {
    const statusClient = new RelayerClient('http://r', { fetchFn: fetchJson(200, { status: 'confirmed', blockNumber: '12' }) });
    expect(await statusClient.status('0xabc')).toEqual({ status: 'confirmed', blockNumber: '12' });
    const healthClient = new RelayerClient('http://r', {
      fetchFn: fetchJson(200, { ok: true, chainId: '31337', manager: MANAGER, relayer: MANAGER, balanceWei: '1' }),
    });
    expect((await healthClient.health()).ok).toBe(true);
  });

  it('calls the global fetch unbound, as browsers require (no "Illegal invocation")', async () => {
    const original = globalThis.fetch;
    // A browser's window.fetch throws a TypeError when invoked with any receiver but the global.
    globalThis.fetch = function (this: unknown) {
      if (this !== undefined && this !== globalThis) {
        return Promise.reject(new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation"));
      }
      return Promise.resolve(new Response(JSON.stringify({ txHash: '0xabc' }), { status: 200 }));
    } as typeof fetch;
    try {
      const client = new RelayerClient('http://relayer.local');
      expect(await client.relay(31337n, MANAGER, { kind: 'abort', ceremonyId: CID })).toBe('0xabc');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('artifact pinning', () => {
  const bytes = new TextEncoder().encode('artifact-bytes');
  const digest: Hex = `0x${Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const file: ArtifactFile = { url: 'https://cdn.example/release/deal.wasm', sha256: digest };
  const serve =
    (body: Uint8Array): typeof fetch =>
    (async () => new Response(body.slice())) as unknown as typeof fetch;

  it('verifies pinned bytes and refuses mismatches', () => {
    expect(() => verifyArtifactBytes(file, bytes)).not.toThrow();
    expect(() => verifyArtifactBytes(file, bytes.slice(1))).toThrow(/sha256 mismatch/);
  });

  it('fetchArtifact returns verified bytes and rejects corrupted bodies', async () => {
    expect(await fetchArtifact(file, { fetchFn: serve(bytes) })).toEqual(bytes);
    await expect(fetchArtifact(file, { fetchFn: serve(bytes.slice(1)) })).rejects.toThrow(/sha256 mismatch/);
  });

  it('refuses unpinned entries and keeps the pin across mirrors', async () => {
    const unpinned: ArtifactFile = { url: file.url, sha256: `0x${'0'.repeat(64)}` };
    await expect(fetchArtifact(unpinned, { fetchFn: serve(bytes) })).rejects.toThrow(/not pinned/);
    expect(artifactUrl(file, 'https://mirror.example/x/')).toBe('https://mirror.example/x/deal.wasm');
    expect(artifactUrl(file)).toBe(file.url);
  });
});

describe('action calldata', () => {
  it('deal encodes and decodes against the hand-written ABI', () => {
    const action: Action = {
      kind: 'deal',
      message: { ceremonyId: CID, dealerIndex: 1, payloadHash: `0x${'aa'.repeat(32)}`, validUntil: 2000000000n },
      signature: SIG,
      payload: dealPayload,
    };
    const decoded = decodeFunctionData({ abi: COUNCIL_MANAGER_ABI, data: encodeAction(action) });
    expect(decoded.functionName).toBe('deal');
    const args = decoded.args as unknown as unknown[];
    expect((args[0] as { dealerIndex: number }).dealerIndex).toBe(1);
    expect(args[1]).toBe(SIG);
    expect((args[2] as (readonly bigint[])[])[0]).toEqual([G.x, G.y]);
    expect((args[4] as readonly bigint[])[0]).toBe(100n);
    expect(args[6]).toEqual([[3n, 4n], [5n, 6n]]);
  });

  it('combine encodes and decodes', () => {
    const action: Action = {
      kind: 'combine',
      requestId: `0x${'bb'.repeat(32)}`,
      memberSet: [1, 3],
      fieldIndexes: [0],
      plaintexts: [42n],
    };
    const decoded = decodeFunctionData({ abi: COUNCIL_MANAGER_ABI, data: encodeAction(action) });
    expect(decoded.functionName).toBe('combine');
    expect(decoded.args).toEqual([`0x${'bb'.repeat(32)}`, [1, 3], [0], [42n]]);
  });
});

describe('chain client (authenticated reads)', () => {
  const block = { hash: `0x${'cc'.repeat(32)}`, number: 100n };
  const stub = (overrides: Partial<Record<'getChainId' | 'getBlock' | 'readContract', unknown>> = {}): PublicClient =>
    ({
      getChainId: async () => 31337,
      getBlock: async () => block,
      readContract: async ({ functionName }: { functionName: string }) => `result:${functionName}`,
      ...overrides,
    }) as unknown as PublicClient;

  it('requires two RPCs unless devMode', () => {
    expect(() => new CouncilClient({ chainId: 31337n, manager: MANAGER, clients: [stub()] })).toThrow(/devMode/);
    expect(() => new CouncilClient({ chainId: 31337n, manager: MANAGER, clients: [stub()], devMode: true })).not.toThrow();
    expect(() => new CouncilClient({ chainId: 31337n, manager: MANAGER })).toThrow(/at least one/);
  });

  it('agreeing providers produce one anchored result', async () => {
    const client = new CouncilClient({ chainId: 31337n, manager: MANAGER, clients: [stub(), stub()] });
    const { results, anchor } = await client.authenticatedRead([{ functionName: 'circuitReleaseId' }]);
    expect(results).toEqual(['result:circuitReleaseId']);
    expect(anchor).toEqual({ blockNumber: 100n, blockHash: block.hash });
  });

  it('refuses when providers disagree on the finalized block', async () => {
    const other = stub({ getBlock: async () => ({ hash: `0x${'dd'.repeat(32)}`, number: 100n }) });
    const client = new CouncilClient({ chainId: 31337n, manager: MANAGER, clients: [stub(), other] });
    await expect(client.finalizedAnchor()).rejects.toThrow(/disagree on the finalized block/);
  });

  it('refuses when providers disagree on state', async () => {
    const other = stub({ readContract: async () => 'result:tampered' });
    const client = new CouncilClient({ chainId: 31337n, manager: MANAGER, clients: [stub(), other] });
    await expect(client.authenticatedRead([{ functionName: 'getCeremony', args: [CID] }])).rejects.toThrow(
      /disagree on getCeremony/,
    );
  });

  it('refuses an RPC serving the wrong chain', async () => {
    const wrong = stub({ getChainId: async () => 1 });
    const client = new CouncilClient({ chainId: 31337n, manager: MANAGER, clients: [stub(), wrong] });
    await expect(client.finalizedAnchor()).rejects.toThrow(/serves chain 1/);
  });
});

describe('provers', () => {
  it('proofFromSnarkjs swaps the G2 limbs', () => {
    const proof = proofFromSnarkjs({
      pi_a: ['1', '2', '1'],
      pi_b: [['3', '4'], ['5', '6'], ['1', '0']],
      pi_c: ['7', '8', '1'],
    });
    expect(proof).toEqual({ pA: [1n, 2n], pB: [[4n, 3n], [6n, 5n]], pC: [7n, 8n] });
  });

  it('FakeProver emits placeholder proof words and correctly ordered signals', async () => {
    const prover = new FakeProver();
    const point = (p: { x: bigint; y: bigint }) => [p.x.toString(), p.y.toString()];
    const ctx: Hex = `0x${'44'.repeat(32)}`;
    const C = Array.from({ length: 16 }, (_, k) => (k < 2 ? G : IDENTITY));
    const X = Array.from({ length: 16 }, () => G);
    const masked = Array.from({ length: 16 }, (_, i) => (i < 3 ? BigInt(i) : 0n));
    const witness = {
      ctxHi: BigInt(`0x${'44'.repeat(16)}`).toString(),
      ctxLo: BigInt(`0x${'44'.repeat(16)}`).toString(),
      dealerIndex: '1',
      n: '3',
      t: '2',
      C: C.map(point),
      E: point(G),
      X: X.map(point),
      masked: masked.map((m) => m.toString()),
      a: Array.from({ length: 16 }, () => '0'),
      e: '1',
      s: Array.from({ length: 16 }, () => '0'),
    };
    const { proof, publicSignals } = await prover.prove('deal', witness);
    expect(proof.pA).toEqual([1n, 2n]);
    expect(publicSignals).toEqual(
      dealPublicSignals({ ctx, dealerIndex: 1, n: 3, t: 2, C, E: G, X, masked }),
    );
  });
});

describe('abi-equals', () => {
  // EIP-170 split: functions and events come from the ICouncil interface
  // (views are served through the manager's fallback at the same address),
  // errors from the CouncilManager implementation.
  const interfacePath = fileURLToPath(new URL('../../solidity/out/ICouncil.sol/ICouncil.json', import.meta.url));
  const managerPath = fileURLToPath(
    new URL('../../solidity/out/CouncilManager.sol/CouncilManager.json', import.meta.url),
  );
  const present = existsSync(interfacePath) && existsSync(managerPath);

  (present ? it : it.skip)(
    'abi.ts matches compiled ICouncil (functions/events) + CouncilManager (errors)' +
      ' (skipped when solidity/out is absent — run forge build in solidity/)',
    () => {
      const load = (p: string) =>
        (JSON.parse(readFileSync(p, 'utf8')) as { abi: { type: string }[] }).abi;
      const expected = [...load(interfacePath), ...load(managerPath).filter((e) => e.type === 'error')];
      expect(JSON.parse(JSON.stringify(COUNCIL_MANAGER_ABI))).toEqual(expected);
    },
  );
});
