/**
 * Multi-endpoint broadcasting and a hot key used outside the relayer (the Sepolia failure,
 * docs/deployments.md "Findings" 1 and 2): an endpoint that refuses sends must not mask another
 * endpoint's nonce error, and external use of the key must self-heal with a clear warning.
 */

import { describe, expect, it } from 'vitest';
import { encodeAction, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { createPublicClient, custom, HttpRequestError, parseTransaction, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { classifySendError } from '../src/broadcast.js';
import { RelayError } from '../src/errors.js';
import type { Logger } from '../src/log.js';
import { TxSender } from '../src/sender.js';
import { ceremonyIdOf, MANAGER, MockChain, RELAYER_ADDRESS, RELAYER_KEY, rpcError } from './mockchain.js';

const account = privateKeyToAccount(RELAYER_KEY);
const finalizeData = (n: number): Hex => encodeAction({ kind: 'finalize', ceremonyId: ceremonyIdOf(n) });

/** 1rpc.io's free plan on Sepolia. */
const planRefusal = () => rpcError(-32000, 'chain is not available on free plan');
/** publicnode's cap on the request body: a large contribution on Gnosis (production, 2026-10-07). */
const sizeRefusal = () => rpcError(-32005, 'Request exceeds defined limit');
const rateLimited = () => new HttpRequestError({ url: 'https://rpc.example', status: 429, details: 'Too Many Requests' });

function capture() {
  const entries: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const log: Logger = {
    info: (msg, fields) => entries.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => entries.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => entries.push({ level: 'error', msg, fields }),
  };
  return { log, entries, foreignWarnings: () => entries.filter((e) => /did not send/.test(e.msg)) };
}

function setup(opts: { endpoints?: (chain: MockChain) => { name: string; client: MockChain['client'] }[]; nonceRefreshMs?: number; automine?: boolean } = {}) {
  const chain = new MockChain({ automine: opts.automine ?? true });
  for (let i = 1; i <= 6; i++) chain.addCeremony(ceremonyIdOf(i), { phase: 2, threshold: 2, n: 3 });
  const clock = { t: 1_000_000 };
  const logs = capture();
  const sender = new TxSender({
    client: chain.client,
    account,
    chainId: chain.chainId,
    maxFeeWei: 10n ** 11n,
    bumpAfterMs: 60_000,
    endpoints: opts.endpoints?.(chain),
    nonceRefreshMs: opts.nonceRefreshMs ?? 15_000,
    log: logs.log,
    now: () => clock.t,
  });
  /** A transaction sent with the relayer's key from somewhere else (the deployer, a script). */
  const external = async () => {
    const raw = await account.signTransaction({
      chainId: 31337,
      type: 'eip1559',
      nonce: chain.pendingNonce(RELAYER_ADDRESS),
      to: account.address,
      gas: 21_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1n,
    });
    await chain.request('eth_sendRawTransaction', [raw]);
  };
  /** Nonces of every relayer broadcast attempt that reached the node, refused ones included. */
  const attempts: Hex[] = [];
  chain.beforeSend = (raw) => attempts.push(raw);
  const relayerNonces = () => attempts.map((raw) => parseTransaction(raw)).filter((tx) => tx.to === MANAGER).map((tx) => tx.nonce);
  return { chain, sender, logs, external, relayerNonces, advance: (ms: number) => (clock.t += ms) };
}

const errorOf = async (p: Promise<unknown>): Promise<RelayError> => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RelayError);
  return err as RelayError;
};

describe('send refusal classification', () => {
  it.each([
    [rpcError(-32000, 'nonce too low'), 'nonce'],
    [rpcError(-32000, 'replacement transaction underpriced'), 'nonce'],
    [rpcError(-32000, 'insufficient funds for gas * price + value'), 'tx'],
    [rpcError(-32000, 'max fee per gas less than block base fee'), 'tx'],
    [rpcError(-32000, 'already known'), 'accepted'],
    [planRefusal(), 'endpoint'],
    [rpcError(-32601, 'the method eth_sendRawTransaction does not exist/is not available'), 'endpoint'],
    [rpcError(-32000, 'unauthorized: invalid API key'), 'endpoint'],
    [new HttpRequestError({ url: 'https://x', status: 405, details: 'Method Not Allowed' }), 'endpoint'],
    // viem labels every -32005 "Request exceeds defined limit", a rate limit included: transient,
    // which moves on to the next endpoint all the same (the production large-contribution refusal).
    [sizeRefusal(), 'transient'],
    [new HttpRequestError({ url: 'https://x', status: 413, details: 'Request Entity Too Large' }), 'endpoint'],
    [rateLimited(), 'transient'],
    [new Error('fetch failed'), 'transient'],
    [new Error('RPC Request failed.'), 'unknown'],
  ] as const)('%s -> %s', (err, kind) => {
    expect(classifySendError(err)).toBe(kind);
  });
});

describe('broadcasting over several endpoints', () => {
  it('a send-refusing endpoint last in the list cannot mask the nonce error (the Sepolia order)', async () => {
    let refuser: ReturnType<MockChain['endpoint']> | undefined;
    const { sender, external, relayerNonces, logs } = setup({
      nonceRefreshMs: 1e12, // isolate the refusal path from idle reconciliation
      endpoints: (chain) => {
        refuser = chain.endpoint(() => Promise.reject(planRefusal()));
        return [
          { name: 'publicnode', client: chain.client },
          { name: '1rpc', client: refuser.client },
        ];
      },
    });
    await sender.send(MANAGER, finalizeData(1));
    await external(); // the deployer uses the hot key: nonce 1 is gone
    await sender.send(MANAGER, finalizeData(2));
    expect(relayerNonces()).toEqual([0, 1, 2]); // 1 refused with "nonce too low", retried at 2
    expect(refuser?.calls()).toBe(0); // the nonce verdict stopped the walk
    expect(logs.foreignWarnings()).toHaveLength(1);
  });

  it('a send-refusing endpoint first in the list is skipped; the next endpoint decides', async () => {
    let refuser: ReturnType<MockChain['endpoint']> | undefined;
    const { sender, external, relayerNonces, logs } = setup({
      nonceRefreshMs: 1e12,
      endpoints: (chain) => {
        refuser = chain.endpoint(() => Promise.reject(planRefusal()));
        return [
          { name: '1rpc', client: refuser.client },
          { name: 'publicnode', client: chain.client },
        ];
      },
    });
    await sender.send(MANAGER, finalizeData(1));
    await external();
    const hash = await sender.send(MANAGER, finalizeData(2));
    expect(hash).toMatch(/^0x/);
    expect(relayerNonces()).toEqual([0, 1, 2]);
    expect(refuser?.calls()).toBe(3);
    expect(logs.entries.some((e) => e.msg.startsWith('broadcast endpoint refused') && e.fields?.endpoint === '1rpc')).toBe(true);
  });

  it('when every endpoint fails, the most informative refusal is reported', async () => {
    const limited = setup({
      endpoints: (chain) => [
        { name: '1rpc', client: chain.endpoint(() => Promise.reject(planRefusal())).client },
        { name: 'busy', client: chain.endpoint(() => Promise.reject(rateLimited())).client },
      ],
    });
    const err = await errorOf(limited.sender.send(MANAGER, finalizeData(1)));
    expect(err.code).toBe('TX_FAILED');
    expect(err.detail).toBe('Too Many Requests (busy); 1rpc: endpoint');

    const broke = setup({
      endpoints: (chain) => [
        { name: '1rpc', client: chain.endpoint(() => Promise.reject(planRefusal())).client },
        { name: 'publicnode', client: chain.client },
      ],
    });
    broke.chain.failNextSend = rpcError(-32000, 'insufficient funds for gas * price + value');
    const funds = await errorOf(broke.sender.send(MANAGER, finalizeData(1)));
    expect(funds.detail).toContain('insufficient funds');
    expect(funds.detail).not.toContain('free plan');
  });

  it('an accepted transaction behind a transport error on one endpoint is "already known" on the next', async () => {
    const { chain, sender } = setup({
      automine: false,
      endpoints: (c) => [
        { name: 'flaky', client: c.endpoint(async (_raw, forward) => (await forward(), Promise.reject(new Error('fetch failed')))).client },
        { name: 'publicnode', client: c.client },
      ],
    });
    const hash = await sender.send(MANAGER, finalizeData(1));
    expect(chain.mempool.map((t) => t.hash)).toEqual([hash]);
    expect(sender.pendingCount).toBe(1);
  });
});

describe('a provider capping the request body (publicnode on Gnosis)', () => {
  /** A client onto the chain that refuses some methods with "Request exceeds defined limit". */
  function capped(chain: MockChain, refuse: (method: string) => boolean) {
    let refusals = 0;
    const client = createPublicClient({
      transport: custom(
        {
          request: ({ method, params }: { method: string; params?: unknown[] }) => {
            if (refuse(method)) {
              refusals += 1;
              return Promise.reject(sizeRefusal());
            }
            return chain.request(method, params ?? []);
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;
    return { client, refusals: () => refusals };
  }

  function largeSetup(refuse: (method: string) => boolean) {
    const chain = new MockChain({ automine: true });
    chain.addCeremony(ceremonyIdOf(1), { phase: 2, threshold: 2, n: 3 });
    const publicnode = capped(chain, refuse);
    const logs = capture();
    const sender = new TxSender({
      client: publicnode.client,
      account,
      chainId: chain.chainId,
      maxFeeWei: 10n ** 11n,
      bumpAfterMs: 60_000,
      endpoints: [
        { name: 'publicnode', client: publicnode.client },
        { name: 'gnosischain', client: chain.client },
      ],
      log: logs.log,
    });
    return { chain, sender, logs, publicnode };
  }

  it('simulation, estimate and broadcast all fall through to an endpoint that accepts them', async () => {
    const big = new Set(['eth_call', 'eth_estimateGas', 'eth_sendRawTransaction']);
    const { sender, logs, publicnode } = largeSetup((m) => big.has(m));
    const hash = await sender.send(MANAGER, finalizeData(1));
    expect(hash).toMatch(/^0x/);
    expect(publicnode.refusals()).toBeGreaterThan(0);
    expect(logs.entries.some((e) => e.msg.includes('retrying on the next endpoint'))).toBe(true);
    expect(logs.entries.some((e) => e.msg.startsWith('broadcast endpoint refused') && e.fields?.endpoint === 'publicnode')).toBe(true);
  });

  it('a revert is the chain answer: never retried over the endpoints', async () => {
    const chain = new MockChain({ automine: true });
    chain.addCeremony(ceremonyIdOf(1), { phase: 2, threshold: 2, n: 3 });
    const reverting = capped(chain, () => false);
    let endpointCalls = 0;
    const counting = createPublicClient({
      transport: custom(
        {
          request: ({ method, params }: { method: string; params?: unknown[] }) => {
            endpointCalls += 1;
            return chain.request(method, params ?? []);
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;
    const sender = new TxSender({
      client: createPublicClient({
        transport: custom(
          {
            request: ({ method, params }: { method: string; params?: unknown[] }) =>
              method === 'eth_call' ? Promise.reject(rpcError(3, 'execution reverted: Phase()')) : chain.request(method, params ?? []),
          },
          { retryCount: 0 },
        ),
      }) as PublicClient,
      account,
      chainId: chain.chainId,
      maxFeeWei: 10n ** 11n,
      bumpAfterMs: 60_000,
      endpoints: [{ name: 'other', client: counting }],
      log: capture().log,
    });
    const err = await errorOf(sender.send(MANAGER, finalizeData(1)));
    expect(err.code).toBe('SIMULATION_REVERTED');
    expect(endpointCalls).toBe(0);
    expect(reverting.refusals()).toBe(0);
  });
});

describe('a hot key used outside the relayer', () => {
  it('reconciles the nonce before a send after a quiet spell, and warns', async () => {
    const { sender, external, relayerNonces, logs, advance } = setup({ nonceRefreshMs: 15_000 });
    await sender.send(MANAGER, finalizeData(1));
    advance(5_000);
    await sender.send(MANAGER, finalizeData(2));
    expect(logs.foreignWarnings()).toHaveLength(0); // our own sends never warn
    await external();
    advance(15_000);
    await sender.send(MANAGER, finalizeData(3));
    expect(relayerNonces()).toEqual([0, 1, 3]); // straight to 3: no refused broadcast
    const [warning] = logs.foreignWarnings();
    expect(warning?.level).toBe('warn');
    expect(warning?.fields).toMatchObject({ expected: 2, onChain: 3, foreign: 1 });
    expect(sender.foreignTransactions).toBe(1);
  });

  it('within the refresh window, the refused send reconciles and retries', async () => {
    const { sender, external, relayerNonces, logs } = setup({ nonceRefreshMs: 15_000 });
    await sender.send(MANAGER, finalizeData(1));
    await external();
    await external();
    await sender.send(MANAGER, finalizeData(2));
    expect(relayerNonces()).toEqual([0, 1, 3]);
    expect(logs.foreignWarnings()[0]?.fields).toMatchObject({ expected: 1, onChain: 3, foreign: 2 });
  });

  it('retries once when the chain is past the tried nonce even if the refusal text says nothing', async () => {
    const { sender, external, relayerNonces } = setup({
      nonceRefreshMs: 1e12,
      endpoints: (chain) => [
        {
          name: 'opaque',
          client: chain.endpoint((_raw, forward) =>
            forward().catch(() => Promise.reject(new Error('RPC Request failed.'))),
          ).client,
        },
      ],
    });
    await sender.send(MANAGER, finalizeData(1));
    await external();
    await sender.send(MANAGER, finalizeData(2));
    expect(relayerNonces()).toEqual([0, 1, 2]);
  });

  it('does not retry an opaque refusal when the nonce is still free', async () => {
    const { sender, relayerNonces } = setup({
      endpoints: (chain) => [{ name: 'opaque', client: chain.endpoint(() => Promise.reject(new Error('RPC Request failed.'))).client }],
    });
    const err = await errorOf(sender.send(MANAGER, finalizeData(1)));
    expect(err.code).toBe('TX_FAILED');
    expect(err.detail).toContain('RPC Request failed.');
    expect(relayerNonces()).toEqual([]);
  });
});
