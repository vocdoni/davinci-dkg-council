import { connect, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayerClient, RelayerError, relayRequestBody, type Action, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { clientIp, createRelayerServer, trustedProxyList, type ServerOptions } from '../src/server.js';
import { ceremonyIdOf, MANAGER, RELAYER_ADDRESS } from './mockchain.js';
import { stack, type StackOptions } from './stack.js';

let server: Server | undefined;
let stopMonitor: (() => void) | undefined;

afterEach(async () => {
  stopMonitor?.();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function start(overrides: Partial<ServerOptions> = {}, stackOpts: StackOptions = {}) {
  const s = stack(stackOpts);
  for (let i = 1; i <= 5; i++) s.chain.addCeremony(ceremonyIdOf(i), { phase: 2, threshold: 2, n: 3 });
  s.sender.start(20);
  stopMonitor = () => s.sender.stop();
  server = createRelayerServer({
    chainId: s.chain.chainId,
    manager: MANAGER,
    sponsor: s.sponsor,
    sender: s.sender,
    corsOrigins: ['https://app.example'],
    rateLimitPerIp: 100,
    ingressRatePerIp: 1000,
    ...overrides,
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...s, url, client: new RelayerClient(url) };
}

const finalize = (n: number): Action => ({ kind: 'finalize', ceremonyId: ceremonyIdOf(n) });
const body = (action: Action): string => JSON.stringify(relayRequestBody(31337n, MANAGER, action));
const JSON_HEADERS = { 'content-type': 'application/json' };

const relayError = async (p: Promise<unknown>): Promise<RelayerError> => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RelayerError);
  return err as RelayerError;
};

async function confirmed(client: RelayerClient, hash: Hex): Promise<{ status: string; blockNumber?: string }> {
  for (let i = 0; i < 100; i++) {
    const st = await client.status(hash);
    if (st.status !== 'pending') return st;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('still pending');
}

describe('relayer HTTP API', () => {
  it('relays a permissionless action and reports its status (SDK client round trip)', async () => {
    const { chain, client } = await start();
    const txHash = await client.relay(31337n, MANAGER, finalize(1));
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const st = await confirmed(client, txHash);
    expect(st.status).toBe('confirmed');
    expect(Number(st.blockNumber)).toBeGreaterThan(0);
    expect(chain.manager.ceremonies.get(ceremonyIdOf(1))?.phase).toBe(3);
  });

  it('returns SIMULATION_REVERTED with the decoded error and pays nothing', async () => {
    const { chain, client } = await start();
    chain.addCeremony(ceremonyIdOf(9), { phase: 3, threshold: 2, n: 3 });
    const err = await relayError(client.relay(31337n, MANAGER, finalize(9)));
    expect(err.code).toBe('SIMULATION_REVERTED');
    expect(err.detail).toBe('WrongPhase()');
    expect(err.httpStatus).toBe(422);
    expect(chain.sentRaw).toHaveLength(0);
  });

  it('rejects the wrong chain and an unsupported manager', async () => {
    const { client } = await start();
    expect((await relayError(client.relay(100n, MANAGER, finalize(1)))).code).toBe('WRONG_CHAIN');
    expect((await relayError(client.relay(31337n, '0x0000000000000000000000000000000000000abc', finalize(1)))).code).toBe(
      'UNSUPPORTED_MANAGER',
    );
  });

  it('rejects malformed bodies with INVALID_ACTION', async () => {
    const { url } = await start();
    for (const b of ['not json', JSON.stringify({ action: 'finalize' }), JSON.stringify([1, 2])]) {
      const res = await fetch(`${url}/v1/relay`, { method: 'POST', body: b, headers: JSON_HEADERS });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('INVALID_ACTION');
    }
  });

  it('charges every relay request to its source IP per action type, rejected ones included', async () => {
    const { chain, client } = await start({ rateLimitPerIp: 2 });
    chain.addCeremony(ceremonyIdOf(9), { phase: 3, threshold: 2, n: 3 });
    expect((await relayError(client.relay(31337n, MANAGER, finalize(9)))).code).toBe('SIMULATION_REVERTED');
    expect((await relayError(client.relay(31337n, MANAGER, finalize(9)))).code).toBe('SIMULATION_REVERTED');
    const err = await relayError(client.relay(31337n, MANAGER, finalize(1)));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.httpStatus).toBe(429);
    await client.relay(31337n, MANAGER, { kind: 'abort', ceremonyId: ceremonyIdOf(4) }); // own bucket
  });

  it('does not charge the ceremony before a successful simulation', async () => {
    const { chain, client } = await start({}, { policy: { ceremonyRatePerMinute: 1 } });
    chain.manager.forced.set('finalize', 'FinalizeConditionNotMet');
    expect((await relayError(client.relay(31337n, MANAGER, finalize(1)))).code).toBe('SIMULATION_REVERTED');
    chain.manager.forced.delete('finalize');
    await client.relay(31337n, MANAGER, finalize(1));
    const grant: Action = {
      kind: 'allowAdapter',
      message: { ceremonyId: ceremonyIdOf(1), adapter: '0x0000000000000000000000000000000000000ada', validUntil: 9n },
      signature: `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`,
    };
    const err = await relayError(client.relay(31337n, MANAGER, grant));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.detail).toContain(ceremonyIdOf(1));
  });

  it('puts unknown action names in one shared bucket', async () => {
    const { url } = await start({ rateLimitPerIp: 2 });
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${url}/v1/relay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ action: `junk-${i}-${'x'.repeat(1000)}` }),
      });
      codes.push(((await res.json()) as { error: string }).error);
    }
    expect(codes).toEqual(['INVALID_ACTION', 'INVALID_ACTION', 'RATE_LIMITED']);
  });

  it('serves a cached health with the relayer address and balance', async () => {
    const { client, sender } = await start();
    let calls = 0;
    const balance = sender.balance.bind(sender);
    sender.balance = () => {
      calls++;
      return balance();
    };
    const h = await client.health();
    expect(h).toEqual({ ok: true, chainId: '31337', manager: MANAGER, relayer: RELAYER_ADDRESS, balanceWei: (10n ** 21n).toString() });
    await client.health();
    await client.health();
    expect(calls).toBe(1);
  });

  it('applies the ingress rate limit to every route, health and status included', async () => {
    const { url } = await start({ ingressRatePerIp: 3 });
    const codes = [];
    for (const p of ['/v1/health', `/v1/status/0x${'77'.repeat(32)}`, '/v1/health', '/v1/health']) {
      codes.push((await fetch(`${url}${p}`)).status);
    }
    expect(codes).toEqual([200, 404, 200, 429]);
  });

  it('refuses requests beyond the concurrency cap with BUSY', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { url, client } = await start({
      maxConcurrent: 1,
      sponsor: { sponsor: async () => (await gate, `0x${'ab'.repeat(32)}`) as Hex },
    });
    const slow = client.relay(31337n, MANAGER, finalize(1));
    await new Promise((r) => setTimeout(r, 50));
    const busy = await fetch(`${url}/v1/health`);
    expect(busy.status).toBe(503);
    expect(((await busy.json()) as { error: string }).error).toBe('BUSY');
    release();
    await slow;
    expect((await fetch(`${url}/v1/health`)).status).toBe(200);
  });

  it('holds capacity until the work finishes, even if the client hangs up; an aborted upload releases it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const { url, client } = await start({
      maxConcurrent: 1,
      sponsor: { sponsor: async () => (started++, await gate, `0x${'ab'.repeat(32)}`) as Hex },
    });
    // Submit a complete body, then disconnect at once.
    const abort = new AbortController();
    const gone = fetch(`${url}/v1/relay`, { method: 'POST', headers: JSON_HEADERS, body: body(finalize(1)), signal: abort.signal });
    await new Promise((r) => setTimeout(r, 50));
    abort.abort();
    await gone.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toBe(1);
    expect((await fetch(`${url}/v1/health`)).status).toBe(503); // still working on it
    expect((await relayError(client.relay(31337n, MANAGER, finalize(2)))).code).toBe('BUSY');
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`${url}/v1/health`)).status).toBe(200);

    // An upload that never completes: the socket closes mid-body, capacity comes back.
    const { port } = new URL(url);
    await new Promise<void>((resolve) => {
      const sock = connect(Number(port), '127.0.0.1', () => {
        sock.write('POST /v1/relay HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"act');
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 50);
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`${url}/v1/health`)).status).toBe(200);
  });

  it('answers 404 for unknown routes and for transactions it did not send', async () => {
    const { url, client } = await start();
    expect((await fetch(`${url}/v2/whatever`)).status).toBe(404);
    expect((await relayError(client.status(`0x${'77'.repeat(32)}`))).httpStatus).toBe(404);
  });

  it('passes the bearer token to the sponsorship policy', async () => {
    const token = 'council-test-token-0123456789';
    const { url } = await start({}, { policy: { apiTokens: [token] } });
    const create: Action = {
      kind: 'createCeremony',
      message: {
        organizer: '0x00000000000000000000000000000000000000b2',
        nonce: 1n,
        threshold: 1,
        registrationDeadline: 2_000_000_000n,
        dealingDuration: 600n,
        inviteKeys: ['0x0000000000000000000000000000000000001000'],
        validUntil: 2_000_000_000n,
      },
      signature: `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`,
    };
    const without = await fetch(`${url}/v1/relay`, { method: 'POST', headers: JSON_HEADERS, body: body(create) });
    expect(without.status).toBe(401);
    const withToken = await fetch(`${url}/v1/relay`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
      body: body(create),
    });
    expect(withToken.status).toBe(200);
  });
});

describe('origin and content type (browser-originated requests)', () => {
  it('refuses a disallowed Origin on every route, not only preflight', async () => {
    const { url } = await start();
    const evil = { origin: 'https://evil.example' };
    const get = await fetch(`${url}/v1/health`, { headers: evil });
    expect(get.status).toBe(403);
    expect(((await get.json()) as { error: string }).error).toBe('FORBIDDEN_ORIGIN');
    expect((await fetch(`${url}/v1/relay`, { method: 'OPTIONS', headers: evil })).status).toBe(403);
  });

  it('refuses cross-origin POSTs from a disallowed origin, JSON or text/plain, and sends nothing', async () => {
    const { url, chain } = await start();
    for (const type of ['text/plain', 'application/json']) {
      const res = await fetch(`${url}/v1/relay`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': type },
        body: body(finalize(1)),
      });
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(chain.sentRaw).toHaveLength(0);
  });

  it('requires application/json on POST (a simple text/plain request is refused, even from an allowed origin)', async () => {
    const { url, chain } = await start();
    for (const headers of [
      { origin: 'https://app.example', 'content-type': 'text/plain' } as Record<string, string>,
      { 'content-type': 'text/plain;charset=UTF-8' },
      { 'content-type': 'application/x-www-form-urlencoded' },
    ]) {
      const res = await fetch(`${url}/v1/relay`, { method: 'POST', headers, body: body(finalize(1)) });
      expect(res.status).toBe(415);
      expect(((await res.json()) as { error: string }).error).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
    expect(chain.sentRaw).toHaveLength(0);
  });

  it('serves an allowed origin with CORS headers (preflight and the actual POST)', async () => {
    const { url } = await start();
    const app = { origin: 'https://app.example' };
    const pre = await fetch(`${url}/v1/relay`, { method: 'OPTIONS', headers: app });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');
    const res = await fetch(`${url}/v1/relay`, {
      method: 'POST',
      headers: { ...app, 'content-type': 'application/json; charset=utf-8' },
      body: body(finalize(1)),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });
});

describe('client IP behind proxies', () => {
  const trusted = trustedProxyList(['10.0.0.0/8', '192.168.1.1', 'fd00::/8']);

  it('ignores X-Forwarded-For from a peer that is not a trusted proxy', () => {
    expect(clientIp('203.0.113.9', '1.2.3.4', trusted)).toBe('203.0.113.9');
    expect(clientIp('203.0.113.9', '1.2.3.4', undefined)).toBe('203.0.113.9');
    expect(clientIp('::ffff:203.0.113.9', undefined, trusted)).toBe('203.0.113.9');
  });

  it('takes the right-most hop that is not a trusted proxy; forged left entries are ignored', () => {
    expect(clientIp('10.1.2.3', '1.1.1.1, 2.2.2.2', trusted)).toBe('2.2.2.2');
    expect(clientIp('10.1.2.3', 'forged, 6.6.6.6, 2.2.2.2, 192.168.1.1', trusted)).toBe('2.2.2.2');
    expect(clientIp('10.1.2.3', ['9.9.9.9', '10.0.0.7'], trusted)).toBe('9.9.9.9');
    expect(clientIp('fd00::1', '2001:db8::5', trusted)).toBe('2001:db8::5');
    expect(clientIp('10.1.2.3', '10.0.0.5', trusted)).toBe('10.0.0.5'); // only proxies: left-most
    expect(clientIp('10.1.2.3', 'garbage', trusted)).toBe('10.1.2.3');
  });

  it('keys rate limits on that address over HTTP, with forged headers', async () => {
    const viaProxy = await start({ ingressRatePerIp: 1, trustedProxies: ['127.0.0.1'] });
    const get = (xff: string) => fetch(`${viaProxy.url}/v1/health`, { headers: { 'x-forwarded-for': xff } });
    expect((await get('9.9.9.9, 2.2.2.2')).status).toBe(200);
    expect((await get('8.8.8.8, 2.2.2.2')).status).toBe(429); // same client behind a forged prefix
    expect((await get('3.3.3.3')).status).toBe(200);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    stopMonitor?.();

    const direct = await start({ ingressRatePerIp: 1, trustedProxies: ['10.9.9.9'] });
    const get2 = (xff: string) => fetch(`${direct.url}/v1/health`, { headers: { 'x-forwarded-for': xff } });
    expect((await get2('4.4.4.4')).status).toBe(200);
    expect((await get2('5.5.5.5')).status).toBe(429); // the header is not trusted: keyed on the peer
  });
});
