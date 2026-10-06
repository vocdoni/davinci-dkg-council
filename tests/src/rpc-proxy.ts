/**
 * A JSON-RPC proxy in front of Anvil that answers like a public provider: an `eth_getLogs` over
 * more than `maxLogRange` blocks (default 10,000) is refused, and so is one whose answer would hold
 * more than `maxLogResults` logs; everything else is forwarded. Every request is recorded (method,
 * and the block range of each `eth_getLogs`), so a test can prove what a client did and did not
 * ask for. Single and batched requests both work.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ProxyLimits {
  /** Widest eth_getLogs range served, in blocks (inclusive). */
  maxLogRange: bigint;
  /** Most logs one eth_getLogs answer may carry. */
  maxLogResults: number;
}

export interface ProxyCall {
  method: string;
  /** eth_getLogs: the resolved [fromBlock, toBlock]. */
  range?: [bigint, bigint];
  /** Set when the proxy refused the request (the error message). */
  refused?: string;
}

export interface RpcProxy {
  url: string;
  /** Mutable: tests may tighten or relax the limits between steps. */
  limits: ProxyLimits;
  calls: ProxyCall[];
  /** eth_getLogs requests seen since the last reset. */
  logCalls(): ProxyCall[];
  reset(): void;
  close(): Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown[];
}

type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcRequest['id'] } & (
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
);

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

export async function startRpcProxy(upstream: string, limits: Partial<ProxyLimits> = {}): Promise<RpcProxy> {
  const state: RpcProxy['limits'] = { maxLogRange: limits.maxLogRange ?? 10_000n, maxLogResults: limits.maxLogResults ?? 10_000 };
  const calls: ProxyCall[] = [];

  const forward = async (body: JsonRpcRequest): Promise<JsonRpcResponse> => {
    const res = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return (await res.json()) as JsonRpcResponse;
  };

  /** A block tag or number as a number, through the upstream node for tags. */
  const blockNumberOf = async (tag: unknown): Promise<bigint> => {
    if (tag === undefined || tag === null) tag = 'latest';
    if (typeof tag === 'string' && /^0x[0-9a-fA-F]+$/.test(tag)) return BigInt(tag);
    if (tag === 'earliest') return 0n;
    const r = await forward({ jsonrpc: '2.0', id: 0, method: 'eth_getBlockByNumber', params: [tag, false] });
    if (!('result' in r) || !r.result) throw new Error(`proxy: cannot resolve block tag ${String(tag)}`);
    return BigInt((r.result as { number: string }).number);
  };

  const refuse = (id: JsonRpcRequest['id'], call: ProxyCall, message: string): JsonRpcResponse => {
    call.refused = message;
    return { jsonrpc: '2.0', id, error: { code: -32005, message } };
  };

  const handle = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    const call: ProxyCall = { method: req.method };
    calls.push(call);
    if (req.method !== 'eth_getLogs') return forward(req);
    const filter = (req.params?.[0] ?? {}) as { blockHash?: string; fromBlock?: unknown; toBlock?: unknown };
    if (filter.blockHash) return forward(req);
    const from = await blockNumberOf(filter.fromBlock);
    const to = await blockNumberOf(filter.toBlock);
    call.range = [from, to];
    if (to >= from && to - from + 1n > state.maxLogRange) {
      // QuickNode's wording; the SDK recognizes the common variants.
      return refuse(req.id, call, `eth_getLogs is limited to a ${state.maxLogRange.toLocaleString('en-US')} range`);
    }
    const res = await forward(req);
    if ('result' in res && Array.isArray(res.result) && res.result.length > state.maxLogResults) {
      return refuse(req.id, call, `query returned more than ${state.maxLogResults} results`);
    }
    return res;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const parsed = JSON.parse(await readBody(req)) as JsonRpcRequest | JsonRpcRequest[];
        const out = Array.isArray(parsed) ? await Promise.all(parsed.map(handle)) : await handle(parsed);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(err instanceof Error ? err.message : String(err));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    limits: state,
    calls,
    logCalls: () => calls.filter((c) => c.method === 'eth_getLogs'),
    reset: () => {
      calls.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
