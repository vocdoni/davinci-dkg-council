/**
 * Long-lived ceremonies: request bindings and enumeration from state (no logs), and the paged
 * log scanner left for cosmetics, against public-provider limits (range caps, result caps,
 * rate limits, lagging backends).
 */

import { describe, expect, it } from 'vitest';
import type { Log } from 'viem';
import { CouncilClient } from '../src/client.js';
import { requestId as computeRequestId } from '../src/encoding.js';
import { isBehindHeadError, isLogRangeError, LogScanner, scanLogs, type LogSource } from '../src/logs.js';
import { readRequestBinding, readRequestIds, type AuthenticatedReader } from '../src/requests.js';
import type { FinalizedAnchor, ViewCall } from '../src/client.js';
import type { Hex } from '../src/types.js';

const MANAGER: Hex = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const CID: Hex = '0xba92d83fa5be494b998b1667';

// --- a log source with public-provider limits ---

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface Limits {
  maxRange?: bigint;
  maxResults?: number;
  /** Fail every getLogs with this error. */
  fail?: () => Error;
  /** Behind the head by this many blocks: ranges past (head - lag) are refused. */
  lag?: bigint;
}

function source(logBlocks: bigint[], head: () => bigint, limits: Limits = {}) {
  const ranges: [bigint, bigint][] = [];
  const src = {
    ranges,
    getBlockNumber: async () => head(),
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([fromBlock, toBlock]);
      if (limits.fail) throw limits.fail();
      if (limits.lag !== undefined && toBlock > head() - limits.lag) {
        throw new RpcError(-32602, 'block range extends beyond current head block');
      }
      if (limits.maxRange !== undefined && toBlock - fromBlock + 1n > limits.maxRange) {
        throw new RpcError(-32005, `query exceeds max block range ${limits.maxRange}`);
      }
      const hits = logBlocks.filter((b) => b >= fromBlock && b <= toBlock);
      if (limits.maxResults !== undefined && hits.length > limits.maxResults) {
        throw new RpcError(-32005, `query returned more than ${limits.maxResults} results`);
      }
      return hits.map((b) => ({ blockNumber: b }) as unknown as Log);
    },
  };
  return src as typeof src & LogSource;
}

const blocksOf = (logs: readonly Log[]) => logs.map((l) => l.blockNumber);

describe('log range classification', () => {
  it('recognizes the refusals of public providers', () => {
    for (const m of [
      'query returned more than 10000 results',
      'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range',
      'eth_getLogs is limited to a 10,000 range',
      'exceed maximum block range: 50000',
      'block range is too wide',
      'Block range too large: maximum allowed is 1000 blocks',
      'ranges over 10000 blocks are not supported on freetier',
      'query exceeds max results 20000, retry with the range 1-2',
      'Too many logs requested. Max logs per response is 10000',
    ]) {
      expect(isLogRangeError(new RpcError(-32005, m)), m).toBe(true);
    }
    expect(isLogRangeError({ status: 413, message: 'HTTP request failed.' })).toBe(true);
  });

  it('does not shrink the range for rate limits, outages or disabled methods', () => {
    for (const m of ['rate limited', 'Too Many Requests', 'fetch failed', 'the method eth_getLogs does not exist/is not available']) {
      expect(isLogRangeError(new RpcError(-32005, m)), m).toBe(false);
    }
    expect(isBehindHeadError(new RpcError(-32602, 'block range extends beyond current head block'))).toBe(true);
  });
});

describe('paged log scan', () => {
  const LOGS = [5n, 9_999n, 10_000n, 25_000n, 649_999n, 650_000n];

  it('scans [from, head] in ranges of at most chunkSize blocks', async () => {
    const src = source(LOGS, () => 650_000n);
    const r = await scanLogs(src, { address: MANAGER, fromBlock: 0n });
    expect(r.complete).toBe(true);
    expect(blocksOf(r.logs)).toEqual(LOGS);
    expect(r.nextBlock).toBe(650_001n);
    expect(src.ranges.every(([a, b]) => b - a + 1n <= 10_000n)).toBe(true);
    expect(src.ranges).toHaveLength(66);
  });

  it('halves the range when a provider refuses it, and keeps the size that worked', async () => {
    const src = source(LOGS, () => 100_000n, { maxRange: 3_000n });
    const r = await scanLogs(src, { address: MANAGER, fromBlock: 0n });
    expect(r.complete).toBe(true);
    expect(blocksOf(r.logs)).toEqual(LOGS.filter((b) => b <= 100_000n));
    expect(r.chunkSize).toBe(2_500n);
    const accepted = src.ranges.filter(([a, b]) => b - a + 1n <= 3_000n);
    expect(accepted.length).toBe(41);
    expect(src.ranges.length - accepted.length).toBe(2); // 10,000 and 5,000 refused once each
  });

  it('halves on a result cap too', async () => {
    const dense = Array.from({ length: 40 }, (_, i) => BigInt(i * 10));
    const src = source(dense, () => 1_000n, { maxResults: 8 });
    const r = await scanLogs(src, { address: MANAGER, fromBlock: 0n });
    expect(r.complete).toBe(true);
    expect(blocksOf(r.logs)).toEqual(dense);
  });

  it('resumes from its cursor after a request budget, without gaps or duplicates', async () => {
    const src = source(LOGS, () => 650_000n);
    const first = await scanLogs(src, { address: MANAGER, fromBlock: 0n, maxRequests: 3 });
    expect(first.complete).toBe(false);
    expect(first.nextBlock).toBe(30_000n);
    const rest = await scanLogs(src, { address: MANAGER, fromBlock: first.nextBlock, chunkSize: first.chunkSize });
    expect(rest.complete).toBe(true);
    expect([...blocksOf(first.logs), ...blocksOf(rest.logs)]).toEqual(LOGS);
  });

  it('stops early, without an error, at a backend behind the head', async () => {
    const src = source(LOGS, () => 30_000n, { lag: 2n });
    const r = await scanLogs(src, { address: MANAGER, fromBlock: 0n });
    expect(r.complete).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.nextBlock).toBe(20_000n);
  });

  it('moves to the next provider when one fails, and reports an error only when all do', async () => {
    const down = source(LOGS, () => 650_000n, { fail: () => new RpcError(-32601, 'the method eth_getLogs does not exist/is not available') });
    const up = source(LOGS, () => 650_000n);
    const r = await scanLogs([down, up], { address: MANAGER, fromBlock: 0n });
    expect(r.complete).toBe(true);
    expect(blocksOf(r.logs)).toEqual(LOGS);

    const limited = source(LOGS, () => 650_000n, { fail: () => new RpcError(-32005, 'rate limited') });
    const failed = await scanLogs([limited], { address: MANAGER, fromBlock: 0n });
    expect(failed.complete).toBe(false);
    expect(failed.nextBlock).toBe(0n);
    expect((failed.error as Error).message).toBe('rate limited');
    expect(limited.ranges).toHaveLength(1); // a rate limit is not answered by shrinking the range
  });

  it('LogScanner follows the head and keeps every log once', async () => {
    let head = 15_000n;
    const src = source(LOGS, () => head);
    const scanner = new LogScanner(src, { address: MANAGER, fromBlock: 0n });
    await scanner.advance();
    expect(scanner.complete).toBe(true);
    expect(blocksOf(scanner.logs)).toEqual([5n, 9_999n, 10_000n]);
    head = 650_000n;
    await scanner.advance({ maxRequests: 10 });
    expect(scanner.complete).toBe(false);
    await Promise.all([scanner.advance({ maxRequests: 100 }), scanner.advance({ maxRequests: 100 })]); // one shared scan
    expect(scanner.complete).toBe(true);
    expect(blocksOf(scanner.logs)).toEqual(LOGS);
    expect(scanner.nextBlock).toBe(650_001n);
  });
});

// --- request enumeration and bindings from state ---

const ANCHOR: FinalizedAnchor = { blockNumber: 100n, blockHash: `0x${'cc'.repeat(32)}` };
const ADAPTER: Hex = '0x00000000000000000000000000000000000000ad';
const CREATOR: Hex = '0x00000000000000000000000000000000000000c0';
const PROCESS: Hex = `0x${'cd'.repeat(31)}`;
const RID = computeRequestId(31337n, MANAGER, CID, ADAPTER, PROCESS);

interface State {
  ids: Hex[];
  origin: [Hex, Hex, Hex];
  binding: [Hex, Hex, boolean];
  allowed: boolean;
  authorized: boolean;
}

function reader(state: State): AuthenticatedReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    chainId: 31337n,
    manager: MANAGER,
    calls,
    authenticatedRead: async (batch: ViewCall[]) => {
      const results = batch.map((c) => {
        calls.push(c.functionName);
        const a = c.args ?? [];
        switch (c.functionName) {
          case 'getRequestCount':
            return BigInt(state.ids.length);
          case 'getRequestIdsPage':
            return state.ids.slice(Number(a[1]), Number(a[1]) + Number(a[2]));
          case 'getRequestOrigin':
            return state.origin;
          case 'getBinding':
            return state.binding;
          case 'isAdapterAllowed':
            return state.allowed;
          case 'isCreatorAuthorized':
            return state.authorized;
          default:
            throw new Error(`no view ${c.functionName}`);
        }
      });
      return { results, anchor: ANCHOR };
    },
  };
}

const healthy = (): State => ({
  ids: [RID],
  origin: [ADAPTER, PROCESS, CREATOR],
  binding: [CID, RID, true],
  allowed: true,
  authorized: true,
});

describe('requests from state (§9.3 item 3, no logs)', () => {
  it('enumerates request ids page by page at one anchor', async () => {
    const ids = Array.from({ length: 130 }, (_, i) => `0x${i.toString(16).padStart(64, '0')}` as Hex);
    const r = reader({ ...healthy(), ids });
    const out = await readRequestIds(r, CID, undefined, 64);
    expect(out.ids).toEqual(ids);
    expect(r.calls.filter((c) => c === 'getRequestIdsPage')).toHaveLength(3);
    expect(await readRequestIds(reader({ ...healthy(), ids: [] }), CID)).toEqual({ ids: [], anchor: ANCHOR });
  });

  it('derives the vote from the request record and authenticates it', async () => {
    const r = reader(healthy());
    const b = await readRequestBinding(r, CID, RID);
    expect(b).toEqual({ ok: true, adapter: ADAPTER, processId: PROCESS, creator: CREATOR, anchor: ANCHOR });
    expect(r.calls).toEqual(['getRequestOrigin', 'getBinding', 'isAdapterAllowed', 'isCreatorAuthorized']);
  });

  it('refuses every inconsistency, naming the failed check', async () => {
    const reason = async (patch: Partial<State>, rid: Hex = RID) => {
      const b = await readRequestBinding(reader({ ...healthy(), ...patch }), CID, rid);
      return b.ok ? 'ok' : b.reason;
    };
    expect(await reason({ binding: ['0x0000000000000000000000aa', RID, true] })).toBe('other-ceremony');
    // A record whose origin does not hash to the request id, or a binding naming another request.
    expect(await reason({ origin: [ADAPTER, `0x${'99'.repeat(31)}`, CREATOR] })).toBe('binding-mismatch');
    expect(await reason({ binding: [CID, `0x${'77'.repeat(32)}`, true] })).toBe('binding-mismatch');
    expect(await reason({}, `0x${'77'.repeat(32)}`)).toBe('binding-mismatch');
    expect(await reason({ allowed: false })).toBe('adapter-not-allowed');
    expect(await reason({ authorized: false })).toBe('creator-not-authorized');
    expect(await reason({ binding: [CID, RID, false] })).toBe('not-submitted');
  });

  it('is what CouncilClient.verifyRequestBinding and getRequestIds run', async () => {
    const views: Record<string, (args: readonly unknown[]) => unknown> = {
      getRequestOrigin: () => [ADAPTER, PROCESS, CREATOR],
      getBinding: () => [CID, RID, true],
      isAdapterAllowed: () => true,
      isCreatorAuthorized: () => true,
      getRequestCount: () => 1n,
      getRequestIdsPage: () => [RID],
    };
    const stub = () =>
      ({
        getChainId: async () => 31337,
        getBlock: async () => ({ hash: ANCHOR.blockHash, number: ANCHOR.blockNumber }),
        readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) =>
          (views[functionName] as (a: readonly unknown[]) => unknown)(args),
      }) as never;
    const client = new CouncilClient({ chainId: 31337n, manager: MANAGER, clients: [stub(), stub()] });
    expect((await client.verifyRequestBinding(CID, RID)).ok).toBe(true);
    expect(await client.getRequestIds(CID)).toEqual([RID]);
    expect(await client.getRequestOrigin(RID)).toEqual({ adapter: ADAPTER, processId: PROCESS, creator: CREATOR });
  });
});
