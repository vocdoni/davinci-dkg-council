import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAction, signTrackCeremony, trackRequestBody, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { createPublicClient, custom, toHex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Endpoint } from '../src/broadcast.js';
import { Metrics, probeRpcAgreement, type AlertThresholds } from '../src/metrics.js';
import { createRelayerServer } from '../src/server.js';
import { trackCeremony, trackDomain, TRACK_TYPES } from '../src/track.js';
import { ceremonyIdOf, MANAGER, MockChain, rpcError } from './mockchain.js';
import { stack } from './stack.js';

/** Another provider onto `chain`, its answers rewritten by `edit`. */
function provider(chain: MockChain, edit?: (method: string, params: unknown[], result: unknown) => unknown): PublicClient {
  return createPublicClient({
    transport: custom(
      {
        request: async ({ method, params }) => {
          const p = (params ?? []) as unknown[];
          const result = await chain.request(method, p);
          return edit ? edit(method, p, result) : result;
        },
      },
      { retryCount: 0 },
    ),
    cacheTime: 0,
  }) as PublicClient;
}

const CID_T = ceremonyIdOf(77);

const THRESHOLDS: AlertThresholds = {
  minBalanceWei: 10n ** 17n,
  minBudgetPercent: 20,
  maxPendingMs: 600_000,
  maxStaleMs: 600_000,
  maxRpcLagBlocks: 64n,
};

describe('RPC agreement probe (protocol §9.3, from outside the app)', () => {
  it('agrees across healthy endpoints, and names a forked, failing or lagging one', async () => {
    const chain = new MockChain();
    chain.blockNumber = 500n;
    const a: Endpoint = { name: 'a.example', client: provider(chain) };
    const b: Endpoint = { name: 'b.example', client: provider(chain) };
    expect(await probeRpcAgreement([a, b])).toMatchObject({ agree: true, comparedBlock: '500', lagBlocks: '0' });

    const forked: Endpoint = {
      name: 'forked.example',
      client: provider(chain, (m, _p, r) => (m === 'eth_getBlockByNumber' ? { ...(r as object), hash: `0x${'ee'.repeat(32)}` } : r)),
    };
    expect(await probeRpcAgreement([a, forked])).toMatchObject({ agree: false });

    const lagging: Endpoint = {
      name: 'lagging.example',
      client: createPublicClient({
        transport: custom({
          request: ({ method, params }) => {
            const p = (params ?? []) as unknown[];
            // Its finalized block is 100 blocks behind everyone else's.
            if (method === 'eth_getBlockByNumber' && p[0] === 'finalized') return chain.request(method, [toHex(400n), ...p.slice(1)]);
            return chain.request(method, p);
          },
        }),
      }) as PublicClient,
    };
    const lag = await probeRpcAgreement([a, lagging]);
    expect(lag).toMatchObject({ agree: true, comparedBlock: '400', lagBlocks: '100' });

    const down: Endpoint = {
      name: 'down.example',
      client: provider(chain, (m, _p, r) => {
        if (m === 'eth_getBlockByNumber') throw rpcError(-32005, 'rate limit exceeded');
        return r;
      }),
    };
    const probe = await probeRpcAgreement([a, down]);
    expect(probe.agree).toBeNull();
    expect(probe.endpoints[1]?.error).toBeDefined();
  });
});

describe('GET /v1/metrics', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  function metricsOf(s: ReturnType<typeof stack>, endpoints: Endpoint[], extra: Partial<ConstructorParameters<typeof Metrics>[0]> = {}) {
    return new Metrics({
      chainId: s.chain.chainId,
      manager: MANAGER,
      sender: s.sender,
      endpoints,
      store: s.store,
      thresholds: THRESHOLDS,
      ttlMs: 0,
      now: () => s.clock.t,
      ...extra,
    });
  }

  it('reports balance, remaining budget, pending transactions, worker health and RPC agreement; 200 when nothing is wrong', async () => {
    const s = stack({ budgetWei: 10n ** 18n });
    const eps = [
      { name: 'a', client: provider(s.chain) },
      { name: 'b', client: provider(s.chain) },
    ];
    const at = s.clock.t;
    const m = metricsOf(s, eps, {
      scheduler: { status: () => ({ failures: 0, lastSuccessAt: at, watching: 3 }) },
      combiner: {
        status: () => ({ failures: 0, lastSuccessAt: at, open: 1, tracked: 2, discovery: { failures: 4, nextBlock: '9' } }),
      },
    });
    const { status, body } = await m.collect();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      alerts: [],
      balanceWei: (10n ** 21n).toString(),
      budget: { limitWei: (10n ** 18n).toString(), remainingWei: (10n ** 18n).toString() },
      transactions: { pending: 0, awaitingFinality: 0 },
      scheduler: { watching: 3, consecutiveFailures: 0 },
      combiner: { openRequests: 1, trackedCeremonies: 2, discovery: { consecutiveFailures: 4 } },
      rpc: { agree: true },
    });
  });

  it('alerts (503) on a low balance, a nearly spent budget, a stuck transaction, a stale worker and disagreeing RPCs', async () => {
    const s = stack({ automine: false, budgetWei: 400_000_000_000_000n });
    s.chain.addCeremony(ceremonyIdOf(1), { phase: 2, threshold: 2, n: 3 });
    await s.sender.send(MANAGER, encodeAction({ kind: 'finalize', ceremonyId: ceremonyIdOf(1) }));
    s.chain.balance = 10n ** 16n;
    const eps = [
      { name: 'a', client: provider(s.chain) },
      {
        name: 'forked',
        client: provider(s.chain, (mth, _p, r) => (mth === 'eth_getBlockByNumber' ? { ...(r as object), hash: `0x${'ee'.repeat(32)}` } : r)),
      },
    ];
    const m = metricsOf(s, eps, { scheduler: { status: () => ({ failures: 7, watching: 1 }) } });
    s.advance(11 * 60_000);
    const { status, body } = await m.collect();
    expect(status).toBe(503);
    const alerts = body.alerts as string[];
    expect(alerts.some((a) => a.startsWith('hot key balance'))).toBe(true);
    expect(alerts.some((a) => a.startsWith('daily budget nearly used'))).toBe(true);
    expect(alerts.some((a) => a.startsWith('a transaction has been pending for 11 min'))).toBe(true);
    expect(alerts.some((a) => a.startsWith('scheduler: no successful pass'))).toBe(true);
    expect(alerts.some((a) => a.startsWith('rpc endpoints disagree'))).toBe(true);
  });

  it('is served over HTTP and cached', async () => {
    const s = stack();
    let builds = 0;
    server = createRelayerServer({
      chainId: s.chain.chainId,
      manager: MANAGER,
      sponsor: s.sponsor,
      sender: s.sender,
      corsOrigins: [],
      rateLimitPerIp: 100,
      metrics: async () => {
        builds++;
        return { status: 200, body: { ok: true } };
      },
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/v1/metrics`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(builds).toBe(1);
    // Without a combine worker there is no track route.
    expect((await fetch(`${url}/v1/track`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
  });

  it('routes POST /v1/track (JSON only, with the bearer token) to the combine worker', async () => {
    const s = stack();
    const seen: { body: unknown; token?: string }[] = [];
    server = createRelayerServer({
      chainId: s.chain.chainId,
      manager: MANAGER,
      sponsor: s.sponsor,
      sender: s.sender,
      corsOrigins: [],
      rateLimitPerIp: 2,
      track: async (body, token) => {
        seen.push({ body, token });
        return { ceremonyId: CID_T, tracked: true };
      },
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/track`;
    const post = (type = 'application/json') =>
      fetch(url, { method: 'POST', headers: { 'content-type': type, authorization: 'Bearer tok-1234567890abcdef' }, body: '{"a":1}' });
    expect((await post('text/plain')).status).toBe(415);
    const ok = await post();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ceremonyId: CID_T, tracked: true });
    expect(seen).toEqual([{ body: { a: 1 }, token: 'tok-1234567890abcdef' }]);
    expect((await post()).status).toBe(429); // per-IP limit on the route
  });
});

describe('POST /v1/track (audit M-02: an authenticated way to have a ceremony served)', () => {
  const ORGANIZER = privateKeyToAccount(`0x${'42'.repeat(32)}`);
  const OTHER = privateKeyToAccount(`0x${'43'.repeat(32)}`);
  const CID = ceremonyIdOf(90);

  function setup(policy: Parameters<typeof stack>[0] = {}) {
    const s = stack(policy);
    s.chain.addCeremony(CID, { phase: 3, threshold: 2, n: 3, organizer: ORGANIZER.address.toLowerCase() as Hex });
    const tracked: Hex[] = [];
    const opts = {
      chainId: s.chain.chainId,
      manager: MANAGER,
      chain: s.policy.chain,
      policy: s.policy,
      track: (cid: Hex) => tracked.push(cid),
      now: () => 1_700_000_000_000,
    };
    return { ...s, tracked, opts };
  }

  const signed = async (signer = ORGANIZER, cid = CID, validUntil = 1_700_000_600n) => ({
    chainId: '31337',
    manager: MANAGER,
    ceremonyId: cid,
    validUntil: validUntil.toString(),
    signature: await signer.signTypedData({
      domain: trackDomain(31337n, MANAGER),
      types: TRACK_TYPES,
      primaryType: 'TrackCeremony',
      message: { ceremonyId: cid, validUntil },
    }),
  });

  const codeOf = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as { code?: string }).code;

  it('tracks a ceremony its organizer signed for, validated on chain', async () => {
    const { opts, tracked } = setup();
    expect(await trackCeremony(opts, await signed())).toEqual({ ceremonyId: CID, tracked: true });
    expect(tracked).toEqual([CID]);
  });

  it('refuses a non-organizer, an expired request, a missing signature, an unknown or aborted ceremony', async () => {
    const { opts, tracked, chain } = setup();
    expect(await codeOf(trackCeremony(opts, await signed(OTHER)))).toBe('UNAUTHORIZED');
    expect(await codeOf(trackCeremony(opts, await signed(ORGANIZER, CID, 1_699_999_999n)))).toBe('UNAUTHORIZED');
    expect(await codeOf(trackCeremony(opts, { chainId: '31337', manager: MANAGER, ceremonyId: CID }))).toBe('UNAUTHORIZED');
    expect(await codeOf(trackCeremony(opts, await signed(ORGANIZER, ceremonyIdOf(91))))).toBe('NOT_FOUND');
    chain.addCeremony(CID, { phase: 4, threshold: 2, n: 3, organizer: ORGANIZER.address.toLowerCase() as Hex });
    expect(await codeOf(trackCeremony(opts, await signed()))).toBe('INVALID_ACTION');
    expect(await codeOf(trackCeremony({ ...opts, chainId: 1n }, await signed()))).toBe('WRONG_CHAIN');
    expect(tracked).toEqual([]);
  });

  it('accepts what the SDK signs and encodes (signTrackCeremony + trackRequestBody)', async () => {
    const { opts, tracked } = setup();
    const request = await signTrackCeremony(ORGANIZER, 31337n, MANAGER, CID, 1_700_000_600n);
    const body = trackRequestBody(31337n, MANAGER, request);
    expect(await trackCeremony(opts, body)).toEqual({ ceremonyId: CID, tracked: true });
    expect(tracked).toEqual([CID]);
  });

  it('accepts an API token instead of a signature; restricted mode still requires a sponsored ceremony', async () => {
    const token = 'operator-token-0123456789';
    const { opts, tracked } = setup({ policy: { apiTokens: [token] } });
    const body = { chainId: '31337', manager: MANAGER, ceremonyId: CID };
    expect(await codeOf(trackCeremony(opts, body, token))).toBe('NOT_SPONSORED');
    const allowed = setup({ policy: { apiTokens: [token], organizerAllowlist: [ORGANIZER.address.toLowerCase()] } });
    expect(await trackCeremony(allowed.opts, body, token)).toEqual({ ceremonyId: CID, tracked: true });
    expect(allowed.tracked).toEqual([CID]);
    expect(tracked).toEqual([]);
  });
});
