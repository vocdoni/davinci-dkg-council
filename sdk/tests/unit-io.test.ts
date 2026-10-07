/** Unit tests for the relayer wire format, artifact pinning, action encoding and the chain client. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, recoverTypedDataAddress, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sha256 } from '@noble/hashes/sha2';
import {
  RelayerClient,
  RelayerError,
  RelayerPool,
  RelayersUnavailableError,
  relayRequestBody,
  signTrackCeremony,
  trackDomain,
  trackRequestBody,
  TRACK_TYPES,
} from '../src/relayer.js';
import {
  ArtifactUnavailableError,
  artifactUrl,
  artifactUrls,
  circuitReleaseById,
  circuitReleaseStatus,
  COUNCIL_ARTIFACTS,
  fetchArtifact,
  KNOWN_CIRCUIT_RELEASES,
  verifyArtifactBytes,
  type ArtifactFile,
} from '../src/artifacts.js';
import { CouncilClient, encodeAction } from '../src/client.js';
import { COUNCIL_MANAGER_ABI } from '../src/abi.js';
import { FakeProver, proofFromSnarkjs } from '../src/prover.js';
import { dealPublicSignals } from '../src/dealing.js';
import { G, IDENTITY } from '../src/curve.js';
import type { Action, DealPayload, Hex, Point } from '../src/types.js';

const MANAGER: Hex = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const CID: Hex = '0xba92d83fa5be494b998b1667';
const SIG: Hex = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;

const vec16 = (p: Point): Point[] => Array.from({ length: 16 }, () => p);

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

  it('finalize, closeRegistrationScheduled and combine shapes', () => {
    expect(relayRequestBody(31337n, MANAGER, { kind: 'finalize', ceremonyId: CID })).toEqual({
      action: 'finalize',
      chainId: '31337',
      manager: MANAGER,
      payload: { ceremonyId: CID },
    });
    // rosterKeys never travel on the wire: the relayer rebuilds them from state (§5.1).
    expect(relayRequestBody(31337n, MANAGER, { kind: 'closeRegistrationScheduled', ceremonyId: CID, rosterKeys: [G] })).toEqual({
      action: 'closeRegistrationScheduled',
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
      partialVectors: [vec16(G), vec16(IDENTITY)],
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
        partialVectors: [
          Array.from({ length: 16 }, () => [G.x.toString(), G.y.toString()]),
          Array.from({ length: 16 }, () => ['0', '1']),
        ],
      },
    });
  });

  it('openDecryption carries the bearer message, publishPartialData the D vector', () => {
    expect(
      relayRequestBody(31337n, MANAGER, {
        kind: 'openDecryption',
        message: { ceremonyId: CID, validUntil: 2000000000n },
        signature: SIG,
      }),
    ).toEqual({
      action: 'openDecryption',
      chainId: '31337',
      manager: MANAGER,
      message: { ceremonyId: CID, validUntil: '2000000000' },
      signatures: [SIG],
    });
    const body = relayRequestBody(31337n, MANAGER, {
      kind: 'publishPartialData',
      requestId: `0x${'bb'.repeat(32)}`,
      participantIndex: 3,
      D: vec16(IDENTITY),
    }) as { payload: { participantIndex: number; D: string[][] } };
    expect(body.payload.participantIndex).toBe(3);
    expect(body.payload.D).toHaveLength(16);
    expect(body.payload.D[0]).toEqual(['0', '1']);
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

describe('relayer pool (failover in order)', () => {
  type Answer = { status: number; body: unknown } | 'down';
  /** One scripted answer per relayer host; records which hosts were asked. */
  const relayers = (table: Record<string, Answer>, asked: string[]): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      asked.push(`${url.host}${url.pathname}`);
      const a = table[url.host];
      if (a === undefined || a === 'down') throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(a.body), { status: a.status });
    }) as unknown as typeof fetch;
  const action: Action = { kind: 'abort', ceremonyId: CID };

  it('moves on past a relayer that is down, overloaded or out of budget', async () => {
    const asked: string[] = [];
    const pool = new RelayerPool(['http://a', 'http://b', 'http://c', 'http://d'], {
      fetchFn: relayers(
        {
          a: 'down',
          b: { status: 503, body: { error: 'BUSY', detail: 'busy' } },
          c: { status: 429, body: { error: 'BUDGET_EXHAUSTED', detail: 'daily budget' } },
          d: { status: 200, body: { txHash: '0xd0' } },
        },
        asked,
      ),
    });
    expect(await pool.relay(31337n, MANAGER, action)).toBe('0xd0');
    expect(asked).toEqual(['a/v1/relay', 'b/v1/relay', 'c/v1/relay', 'd/v1/relay']);
  });

  it('stops at a refusal of the action itself — the next relayer is never asked', async () => {
    const asked: string[] = [];
    const pool = new RelayerPool(['http://a', 'http://b'], {
      fetchFn: relayers(
        {
          a: { status: 422, body: { error: 'SIMULATION_REVERTED', detail: 'WrongPhase()' } },
          b: { status: 200, body: { txHash: '0xb0' } },
        },
        asked,
      ),
    });
    const err = await pool.relay(31337n, MANAGER, action).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayerError);
    expect((err as RelayerError).code).toBe('SIMULATION_REVERTED');
    expect(asked).toEqual(['a/v1/relay']);
  });

  it('reports every relayer when none takes the action', async () => {
    const pool = new RelayerPool(['http://a', 'http://b'], {
      fetchFn: relayers({ a: 'down', b: { status: 500, body: {} } }, []),
    });
    const err = await pool.relay(31337n, MANAGER, action).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayersUnavailableError);
    expect((err as RelayersUnavailableError).failures.map((f) => f.url)).toEqual(['http://a', 'http://b']);
  });

  it('skips a relayer that stalls (no headers, or a body that never ends) after its timeout', async () => {
    const asked: string[] = [];
    const never = new Promise<Response>(() => undefined); // ignores the abort signal on purpose
    const pool = new RelayerPool(['http://a', 'http://b', 'http://c'], {
      timeoutMs: 50,
      fetchFn: (async (input: RequestInfo | URL) => {
        const host = new URL(String(input)).host;
        asked.push(host);
        if (host === 'a') return never;
        if (host === 'b') return new Response(new ReadableStream({ start() {} }), { status: 200 });
        return new Response(JSON.stringify({ txHash: '0xc0' }));
      }) as unknown as typeof fetch,
    });
    expect(await pool.relay(31337n, MANAGER, action)).toBe('0xc0');
    expect(asked).toEqual(['a', 'b', 'c']);
    const lone = new RelayerClient('http://a', { timeoutMs: 20, fetchFn: (async () => never) as unknown as typeof fetch });
    const err = await lone.status('0x01').catch((e: unknown) => e);
    expect((err as RelayerError).code).toBe('TIMEOUT');
  });

  it('asks the relayer that sent a transaction for its status first', async () => {
    const asked: string[] = [];
    const pool = new RelayerPool(['http://a', 'http://b'], {
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        asked.push(`${url.host}${url.pathname}`);
        if (url.host === 'a') throw new TypeError('Failed to fetch');
        if (url.pathname === '/v1/relay') return new Response(JSON.stringify({ txHash: '0xb1' }));
        return new Response(JSON.stringify({ status: 'confirmed' }));
      }) as unknown as typeof fetch,
    });
    await pool.relay(31337n, MANAGER, action);
    asked.length = 0;
    expect(await pool.status('0xb1')).toEqual({ status: 'confirmed' });
    expect(asked).toEqual(['b/v1/status/0xb1']);
    expect(() => new RelayerPool([])).toThrow(/at least one/);
  });
});

describe('POST /v1/track (§5.1: register a ceremony with the combine workers)', () => {
  const organizer = privateKeyToAccount(`0x${'42'.repeat(32)}`);

  it('signTrackCeremony signs in the relayer domain and recovers to the signer', async () => {
    const req = await signTrackCeremony(organizer, 31337n, MANAGER, CID, 1_900_000_000n);
    expect(req).toMatchObject({ ceremonyId: CID, validUntil: 1_900_000_000n });
    const signer = await recoverTypedDataAddress({
      domain: trackDomain(31337n, MANAGER),
      types: TRACK_TYPES,
      primaryType: 'TrackCeremony',
      message: { ceremonyId: CID, validUntil: 1_900_000_000n },
      signature: req.signature as Hex,
    });
    expect(signer.toLowerCase()).toBe(organizer.address.toLowerCase());
    // The relayer's own domain, never the protocol's (a track signature must not replay there).
    expect(trackDomain(31337n, MANAGER).name).toBe('DAVINCI DKG Council Relayer');
  });

  it('trackRequestBody carries decimal strings; the token path omits the signature pair', () => {
    expect(trackRequestBody(31337n, MANAGER, { ceremonyId: CID, validUntil: 7n, signature: SIG })).toEqual({
      chainId: '31337',
      manager: MANAGER,
      ceremonyId: CID,
      validUntil: '7',
      signature: SIG,
    });
    expect(trackRequestBody(31337n, MANAGER, { ceremonyId: CID })).toEqual({
      chainId: '31337',
      manager: MANAGER,
      ceremonyId: CID,
    });
  });

  it('client.track posts the body (and the bearer token), and surfaces a refusal', async () => {
    const seen: { url: string; body: unknown; auth: string | undefined }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        auth: (init?.headers as Record<string, string>).authorization,
      });
      return new Response(JSON.stringify({ ceremonyId: CID, tracked: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new RelayerClient('http://r', { fetchFn });
    await client.track(31337n, MANAGER, { ceremonyId: CID, validUntil: 7n, signature: SIG });
    await client.track(31337n, MANAGER, { ceremonyId: CID }, 'secret-token');
    expect(seen[0]).toEqual({
      url: 'http://r/v1/track',
      body: { chainId: '31337', manager: MANAGER, ceremonyId: CID, validUntil: '7', signature: SIG },
      auth: undefined,
    });
    expect(seen[1]?.auth).toBe('Bearer secret-token');
    const refused = new RelayerClient('http://r', {
      fetchFn: (async () =>
        new Response(JSON.stringify({ error: 'NOT_FOUND', detail: 'no combine worker' }), { status: 404 })) as unknown as typeof fetch,
    });
    const err = await refused.track(31337n, MANAGER, { ceremonyId: CID }, 't').catch((e: unknown) => e);
    expect((err as RelayerError).code).toBe('NOT_FOUND');
  });

  it('pool.track registers with every relayer and never throws', async () => {
    const asked: string[] = [];
    const pool = new RelayerPool(['http://a', 'http://b', 'http://c'], {
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        asked.push(`${url.host}${url.pathname}`);
        if (url.host === 'a') throw new TypeError('Failed to fetch');
        if (url.host === 'b') return new Response(JSON.stringify({ error: 'UNAUTHORIZED', detail: 'no' }), { status: 401 });
        return new Response(JSON.stringify({ ceremonyId: CID, tracked: true }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const outcomes = await pool.track(31337n, MANAGER, { ceremonyId: CID, validUntil: 7n, signature: SIG });
    expect(asked.sort()).toEqual(['a/v1/track', 'b/v1/track', 'c/v1/track']);
    expect(outcomes.map((o) => ({ url: o.url, tracked: o.tracked }))).toEqual([
      { url: 'http://a', tracked: false },
      { url: 'http://b', tracked: false },
      { url: 'http://c', tracked: true },
    ]);
    expect((outcomes[1]?.error as RelayerError).code).toBe('UNAUTHORIZED');
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

describe('artifact mirrors (tried in order, pins unchanged)', () => {
  const bytes = new TextEncoder().encode('mirrored-artifact');
  const digest: Hex = `0x${Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const file: ArtifactFile = { url: 'https://canonical.example/circuits-v1/deal.wasm', sha256: digest };

  /** A fetch that answers per host: a status code, a body, or a network failure. */
  const hosts = (table: Record<string, number | Uint8Array | 'down'>, seen: string[]): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      const answer = table[new URL(url).host];
      if (answer === undefined || answer === 'down') throw new TypeError('Failed to fetch');
      if (typeof answer === 'number') return new Response('nope', { status: answer });
      return new Response(answer.slice());
    }) as unknown as typeof fetch;

  it('skips a mirror that is down, errors or serves the wrong bytes, and takes the first good copy', async () => {
    const seen: string[] = [];
    const fetchFn = hosts(
      { 'a.example': 'down', 'b.example': 503, 'c.example': bytes.slice(1), 'd.example': bytes },
      seen,
    );
    const got = await fetchArtifact(file, {
      fetchFn,
      baseUrls: ['https://a.example/x', 'https://b.example/x', 'https://c.example/x', 'https://d.example/{release}'],
      release: 'circuits-v1',
    });
    expect(got).toEqual(bytes);
    expect(seen).toEqual([
      'https://a.example/x/deal.wasm',
      'https://b.example/x/deal.wasm',
      'https://c.example/x/deal.wasm',
      'https://d.example/circuits-v1/deal.wasm',
    ]);
  });

  it('skips a mirror that stalls before headers or mid-body', async () => {
    const seen: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(new URL(url).host);
      if (url.includes('a.example')) return new Promise<Response>(() => undefined);
      if (url.includes('b.example')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(bytes.slice(0, 3)); // then nothing, forever
            },
          }),
        );
      }
      return new Response(bytes.slice());
    }) as unknown as typeof fetch;
    const got = await fetchArtifact(file, {
      fetchFn,
      stallTimeoutMs: 50,
      baseUrls: ['https://a.example', 'https://b.example', 'https://c.example'],
    });
    expect(got).toEqual(bytes);
    expect(seen).toEqual(['a.example', 'b.example', 'c.example']);
  });

  it('never cuts a slow but steady download (the stall timer restarts on every chunk)', async () => {
    const fetchFn = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(c) {
            for (const b of bytes) {
              await new Promise((r) => setTimeout(r, 15)); // each gap below the timeout, the total far above
              c.enqueue(Uint8Array.of(b));
            }
            c.close();
          },
        }),
      )) as unknown as typeof fetch;
    const got = await fetchArtifact(file, { fetchFn, stallTimeoutMs: 40, baseUrls: ['https://slow.example'] });
    expect(got).toEqual(bytes);
  });

  it('reports every mirror when none serves the pinned file', async () => {
    const fetchFn = hosts({ 'a.example': 404, 'b.example': bytes.slice(2) }, []);
    const err = await fetchArtifact(file, { fetchFn, baseUrls: ['https://a.example', 'https://b.example'] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ArtifactUnavailableError);
    const failures = (err as ArtifactUnavailableError).failures;
    expect(failures.map((f) => f.url)).toEqual(['https://a.example/deal.wasm', 'https://b.example/deal.wasm']);
    expect(failures[0]?.reason).toMatch(/HTTP 404/);
    expect(failures[1]?.reason).toMatch(/sha256 mismatch/);
  });

  it('uses the canonical URL without mirrors; baseUrl stays first; duplicates collapse', () => {
    expect(artifactUrls(file)).toEqual([file.url]);
    expect(artifactUrls(file, { baseUrl: 'https://m.example/', baseUrls: ['https://m.example', 'https://n.example'] })).toEqual([
      'https://m.example/deal.wasm',
      'https://n.example/deal.wasm',
    ]);
    expect(artifactUrl(file, 'https://m.example/{release}/', 'circuits-v9')).toBe('https://m.example/circuits-v9/deal.wasm');
  });
});

describe('circuit release status (development setup disclosure)', () => {
  const releaseJson = JSON.parse(
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../circuits/release/release.json'), 'utf8'),
  ) as { tag: string; setup: string; circuitReleaseId: Hex; developmentSetup?: boolean };

  it('the pinned release matches circuits/release/release.json, development flag included', () => {
    const current = KNOWN_CIRCUIT_RELEASES[0];
    expect(current?.id).toBe(releaseJson.circuitReleaseId);
    expect(current?.release).toBe(releaseJson.tag);
    const dev = releaseJson.developmentSetup ?? /^DEVELOPMENT/.test(releaseJson.setup);
    expect(COUNCIL_ARTIFACTS.developmentSetup).toBe(dev);
  });

  it('maps an on-chain id to its status; an unknown release is never production', () => {
    const id = KNOWN_CIRCUIT_RELEASES[0]?.id as Hex;
    expect(circuitReleaseById(id.toUpperCase().replace('0X', '0x') as Hex)?.id).toBe(id);
    expect(circuitReleaseStatus(id)).toEqual({
      id,
      known: true,
      tag: COUNCIL_ARTIFACTS.release,
      developmentSetup: COUNCIL_ARTIFACTS.developmentSetup,
      production: !COUNCIL_ARTIFACTS.developmentSetup,
    });
    const unknown = `0x${'12'.repeat(32)}` as Hex;
    expect(circuitReleaseStatus(unknown)).toEqual({ id: unknown, known: false, production: false });
  });
});

describe('action calldata', () => {
  it('deal encodes and decodes against the hand-written ABI', () => {
    const action: Action = {
      kind: 'deal',
      message: { ceremonyId: CID, dealerIndex: 1, payloadHash: `0x${'aa'.repeat(32)}`, validUntil: 2000000000n },
      signature: SIG,
      payload: dealPayload,
      rosterKeys: [G, G, G],
    };
    const decoded = decodeFunctionData({ abi: COUNCIL_MANAGER_ABI, data: encodeAction(action) });
    expect(decoded.functionName).toBe('deal');
    const args = decoded.args as unknown as unknown[];
    expect((args[0] as { dealerIndex: number }).dealerIndex).toBe(1);
    expect(args[1]).toBe(SIG);
    expect((args[2] as (readonly bigint[])[])[0]).toEqual([G.x, G.y]);
    expect((args[4] as readonly bigint[])[0]).toBe(100n);
    expect(args[6]).toEqual([[3n, 4n], [5n, 6n]]);
    expect(args[8]).toEqual([[G.x, G.y], [G.x, G.y], [G.x, G.y]]);
  });

  it('combine encodes and decodes', () => {
    const action: Action = {
      kind: 'combine',
      requestId: `0x${'bb'.repeat(32)}`,
      memberSet: [1, 3],
      fieldIndexes: [0],
      plaintexts: [42n],
      partialVectors: [vec16(G), vec16(IDENTITY)],
      C2: [G],
    };
    const decoded = decodeFunctionData({ abi: COUNCIL_MANAGER_ABI, data: encodeAction(action) });
    expect(decoded.functionName).toBe('combine');
    expect(decoded.args).toEqual([
      `0x${'bb'.repeat(32)}`,
      [1, 3],
      [0],
      [42n],
      [vec16(G).map((p) => [p.x, p.y]), vec16(IDENTITY).map((p) => [p.x, p.y])],
      [[G.x, G.y]],
    ]);
  });

  it('new v2 arms encode and decode', () => {
    const scheduled = decodeFunctionData({
      abi: COUNCIL_MANAGER_ABI,
      data: encodeAction({ kind: 'closeRegistrationScheduled', ceremonyId: CID, rosterKeys: [G] }),
    });
    expect(scheduled.functionName).toBe('closeRegistrationScheduled');
    expect(scheduled.args).toEqual([CID, [[G.x, G.y]]]);

    const open = decodeFunctionData({
      abi: COUNCIL_MANAGER_ABI,
      data: encodeAction({ kind: 'openDecryption', message: { ceremonyId: CID, validUntil: 2000000000n }, signature: SIG }),
    });
    expect(open.functionName).toBe('openDecryption');
    expect(open.args).toEqual([{ ceremonyId: CID, validUntil: 2000000000n }, SIG]);

    const publish = decodeFunctionData({
      abi: COUNCIL_MANAGER_ABI,
      data: encodeAction({ kind: 'publishPartialData', requestId: `0x${'bb'.repeat(32)}`, participantIndex: 2, D: vec16(IDENTITY) }),
    });
    expect(publish.functionName).toBe('publishPartialData');
    expect(publish.args).toEqual([`0x${'bb'.repeat(32)}`, 2, vec16(IDENTITY).map((p) => [p.x, p.y])]);
  });

  it('refuses direct calldata without the relayer-rebuilt fields', () => {
    expect(() => encodeAction({ kind: 'closeRegistrationScheduled', ceremonyId: CID })).toThrow(/rosterKeys/);
    expect(() =>
      encodeAction({
        kind: 'combine',
        requestId: `0x${'bb'.repeat(32)}`,
        memberSet: [1, 3],
        fieldIndexes: [0],
        plaintexts: [42n],
        partialVectors: [vec16(G), vec16(IDENTITY)],
      }),
    ).toThrow(/C2/);
    expect(() =>
      encodeAction({
        kind: 'submitPartial',
        message: {
          ceremonyId: CID,
          requestId: `0x${'bb'.repeat(32)}`,
          participantIndex: 1,
          payloadHash: `0x${'aa'.repeat(32)}`,
          validUntil: 1n,
        },
        signature: SIG,
        payload: { D: vec16(IDENTITY), proof: dealPayload.proof },
      }),
    ).toThrow(/C1/);
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
  // EIP-170 split: functions and events come from the ICouncil interface; the
  // whole surface is reached at the manager address (views via the fallback,
  // CouncilOps via delegatecall), so errors are the union of the manager, ops
  // and views implementations.
  const outPath = (rel: string) => fileURLToPath(new URL(`../../solidity/out/${rel}`, import.meta.url));
  const interfacePath = outPath('ICouncil.sol/ICouncil.json');
  const implPaths = [
    outPath('CouncilManager.sol/CouncilManager.json'),
    outPath('CouncilOps.sol/CouncilOps.json'),
    outPath('CouncilViews.sol/CouncilViews.json'),
  ];
  const present = [interfacePath, ...implPaths].every(existsSync);

  (present ? it : it.skip)(
    'abi.ts matches compiled ICouncil (functions/events) + manager/ops/views (errors)' +
      ' (skipped when solidity/out is absent — run forge build in solidity/)',
    () => {
      const load = (p: string) =>
        (JSON.parse(readFileSync(p, 'utf8')) as { abi: { type: string; name?: string }[] }).abi;
      const errors = new Map<string, { type: string; name?: string }>();
      for (const p of implPaths) {
        for (const e of load(p)) if (e.type === 'error') errors.set(JSON.stringify(e), e);
      }
      const expected = [...load(interfacePath), ...errors.values()];
      const key = (e: { type: string; name?: string }) => `${e.type}:${e.name ?? ''}:${JSON.stringify(e)}`;
      const sort = (abi: { type: string; name?: string }[]) => [...abi].sort((a, b) => key(a).localeCompare(key(b)));
      expect(sort(JSON.parse(JSON.stringify(COUNCIL_MANAGER_ABI)) as { type: string }[])).toEqual(sort(expected));
    },
  );
});
