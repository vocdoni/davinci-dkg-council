/**
 * HTTP API (architecture §5.1) on node:http:
 *
 *   POST /v1/relay           -> 200 { txHash } | 4xx/5xx { error, detail, revertData? }
 *   GET  /v1/status/:txHash  -> { status, blockNumber?, revertReason? }   (hashes this relayer sent)
 *   GET  /v1/health          -> { ok, chainId, manager, relayer, balanceWei }   (liveness)
 *   GET  /v1/metrics         -> 200 | 503 { ok, alerts, budget, transactions, … }   (metrics.ts)
 *   POST /v1/track           -> 200 { ceremonyId, tracked }   (track.ts; with the combine worker)
 *
 * Ingress: a per-IP rate limit over every route, a cap on concurrent requests, and an Origin
 * check on every request (a disallowed Origin is refused, not merely left without CORS
 * headers). POST bodies must be `application/json`, which a cross-origin page cannot send
 * without a preflight. Relay requests are further limited per IP and action type — charged
 * for every request, rejected ones included — before the sponsorship policy runs.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';
import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { RelayError, shortMessage } from './errors.js';
import { silentLogger, type Logger } from './log.js';
import type { Sponsor } from './policy.js';
import { RateLimiter } from './ratelimit.js';
import type { TxSender } from './sender.js';
import { ACTION_NAMES, parseRelayRequest } from './wire.js';

export interface ServerOptions {
  chainId: bigint;
  manager: Hex;
  sponsor: Pick<Sponsor, 'sponsor'>;
  sender: Pick<TxSender, 'status' | 'balance' | 'address'>;
  corsOrigins: string[];
  /** Relay requests per minute per client IP and action type. */
  rateLimitPerIp: number;
  /** Requests per minute per client IP over every route. */
  ingressRatePerIp?: number;
  /** Requests handled at once; more are refused with BUSY. */
  maxConcurrent?: number;
  /** Peers (IPs or CIDRs) whose X-Forwarded-For is honoured. */
  trustedProxies?: string[];
  /** GET /v1/metrics (absent: 404). */
  metrics?: () => Promise<{ status: number; body: Record<string, unknown> }>;
  /** POST /v1/track (absent: 404): authenticate, validate and track a ceremony. */
  track?: (body: unknown, token?: string) => Promise<unknown>;
  log?: Logger;
  now?: () => number;
}

const MAX_BODY_BYTES = 256 * 1024;
const HEALTH_TTL_MS = 5000;
const STATUS_PATH = /^\/v1\/status\/(0x[0-9a-fA-F]{64})$/;
const JSON_TYPE = /^application\/json\s*(;\s*charset=utf-8\s*)?$/i;

const normalizeIp = (ip: string): string => (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip);

/** A BlockList of trusted proxy addresses and CIDR ranges. */
export function trustedProxyList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const raw of entries) {
    const [addr, prefix] = raw.trim().split('/') as [string, string | undefined];
    const family = isIP(addr);
    if (family === 0) throw new Error(`trusted proxy is not an IP or CIDR: ${raw}`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(prefix), type);
  }
  return list;
}

const isTrusted = (list: BlockList, ip: string): boolean => {
  const family = isIP(ip);
  return family !== 0 && list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
};

/**
 * The client address: the socket peer, unless the peer is a trusted proxy — then the
 * right-most X-Forwarded-For hop that is not itself a trusted proxy. Entries left of it are
 * client-supplied and never used.
 */
export function clientIp(remote: string | undefined, xff: string | string[] | undefined, trusted?: BlockList): string {
  const peer = normalizeIp(remote ?? 'unknown');
  if (!trusted || !isTrusted(trusted, peer)) return peer;
  const hops = (Array.isArray(xff) ? xff.join(',') : (xff ?? ''))
    .split(',')
    .map((h) => normalizeIp(h.trim()))
    .filter((h) => h.length > 0);
  let last = peer;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (isIP(hop) === 0) return last; // garbage from the trusted chain: stop at the last good hop
    if (!isTrusted(trusted, hop)) return hop;
    last = hop;
  }
  return last;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RelayError('INVALID_ACTION', `body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    // An aborted or timed-out upload never ends: settle so its capacity is released.
    req.on('close', () => reject(new RelayError('INVALID_ACTION', 'request closed before the body was complete')));
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text).toString(),
    ...headers,
  });
  res.end(text);
}

const bearer = (req: IncomingMessage): string | undefined => {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m?.[1];
};

/** Validate, rate-limit and hand one relay request to the sponsor. Exported for tests. */
export async function relay(
  opts: ServerOptions,
  limiter: RateLimiter,
  ip: string,
  body: unknown,
  token?: string,
): Promise<Hex> {
  // Every relay request — valid or not — is charged to its source IP, per action type;
  // anything that is not a known action shares one bucket, so client-chosen strings never
  // become limiter keys.
  const raw = (body as { action?: unknown } | null)?.action;
  const name = typeof raw === 'string' && (ACTION_NAMES as readonly string[]).includes(raw) ? raw : 'invalid';
  if (!limiter.take(`ip:${ip}:${name}`, opts.rateLimitPerIp)) {
    throw new RelayError('RATE_LIMITED', `too many ${name} requests from this address`);
  }
  const parsed = parseRelayRequest(body);
  if (parsed.chainId !== opts.chainId) {
    throw new RelayError('WRONG_CHAIN', `this relayer serves chain ${opts.chainId}, not ${parsed.chainId}`);
  }
  if (parsed.manager !== opts.manager.toLowerCase()) {
    throw new RelayError('UNSUPPORTED_MANAGER', `this relayer serves manager ${opts.manager}`);
  }
  // Ceremony quotas and rate are charged by the sponsor only after a successful simulation.
  return opts.sponsor.sponsor(parsed.action, { source: 'http', token });
}

export function createRelayerServer(opts: ServerOptions): Server {
  const log = opts.log ?? silentLogger;
  const now = opts.now ?? Date.now;
  const limiter = new RateLimiter(60_000, now);
  const ingressLimit = opts.ingressRatePerIp ?? 600;
  const maxConcurrent = opts.maxConcurrent ?? 64;
  const trusted = opts.trustedProxies && opts.trustedProxies.length > 0 ? trustedProxyList(opts.trustedProxies) : undefined;
  const anyOrigin = opts.corsOrigins.includes('*');
  const origins = new Set(opts.corsOrigins.map((o) => o.replace(/\/$/, '')));
  let active = 0;
  let health: { at: number; body: Record<string, unknown> } | undefined;

  const corsHeaders = (origin: string): Record<string, string> => ({
    'access-control-allow-origin': anyOrigin ? '*' : origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
    vary: 'Origin',
  });

  const healthBody = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    if (health && now() - health.at < HEALTH_TTL_MS) return { status: 200, body: health.body };
    try {
      const balance = await opts.sender.balance();
      const body = {
        ok: true,
        chainId: opts.chainId.toString(),
        manager: opts.manager,
        relayer: opts.sender.address,
        balanceWei: balance.toString(),
      };
      health = { at: now(), body };
      return { status: 200, body };
    } catch (err) {
      return { status: 503, body: { ok: false, error: 'INTERNAL', detail: shortMessage(err) } };
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const path = new URL(req.url ?? '/', 'http://relayer').pathname;
    let headers: Record<string, string> = {};
    try {
      if (origin !== undefined) {
        if (!anyOrigin && !origins.has(origin)) throw new RelayError('FORBIDDEN_ORIGIN', `origin ${origin} is not allowed`);
        headers = corsHeaders(origin);
      }
      const ip = clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], trusted);
      if (!limiter.take(`ingress:${ip}`, ingressLimit)) throw new RelayError('RATE_LIMITED', 'too many requests from this address');

      if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        res.end();
        return;
      }
      const jsonBody = async (): Promise<unknown> => {
        const type = req.headers['content-type'] ?? '';
        if (!JSON_TYPE.test(type)) {
          throw new RelayError('UNSUPPORTED_MEDIA_TYPE', 'the body must be sent as application/json');
        }
        const text = await readBody(req);
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new RelayError('INVALID_ACTION', 'body is not valid JSON');
        }
      };
      if (req.method === 'POST' && path === '/v1/track' && opts.track) {
        if (!limiter.take(`ip:${ip}:track`, opts.rateLimitPerIp)) {
          throw new RelayError('RATE_LIMITED', 'too many track requests from this address');
        }
        const result = await opts.track(await jsonBody(), bearer(req));
        log.info('ceremony tracked', { result, ip });
        send(res, 200, result, headers);
        return;
      }
      if (req.method === 'GET' && path === '/v1/metrics' && opts.metrics) {
        const m = await opts.metrics();
        send(res, m.status, m.body, headers);
        return;
      }
      if (req.method === 'POST' && path === '/v1/relay') {
        const body = await jsonBody();
        const txHash = await relay(opts, limiter, ip, body, bearer(req));
        log.info('relayed', { action: (body as { action?: unknown }).action, txHash, ip });
        send(res, 200, { txHash }, headers);
        return;
      }
      const status = req.method === 'GET' ? STATUS_PATH.exec(path) : null;
      if (status) {
        send(res, 200, await opts.sender.status(status[1] as Hex), headers);
        return;
      }
      if (req.method === 'GET' && path === '/v1/health') {
        const h = await healthBody();
        send(res, h.status, h.body, headers);
        return;
      }
      throw new RelayError('NOT_FOUND', `no route ${req.method ?? ''} ${path}`);
    } catch (err) {
      const e = err instanceof RelayError ? err : new RelayError('INTERNAL', shortMessage(err));
      if (e.code === 'INTERNAL') log.error('request failed', { path, err: shortMessage(err) });
      else if (e.code === 'SIMULATION_REVERTED') log.info('simulation reverted', { path, detail: e.detail });
      else if (e.code === 'BUDGET_EXHAUSTED') log.warn('budget exhausted', { detail: e.detail });
      send(res, e.status, e.toJSON(), headers);
    }
  };

  const server = createServer((req, res) => {
    if (active >= maxConcurrent) {
      send(res, 503, { error: 'BUSY', detail: 'too many concurrent requests; retry shortly' });
      req.resume();
      return;
    }
    // Capacity is held until the work is done, not until the client hangs up: a client
    // that disconnects right after its body cannot stack work beyond the cap.
    active++;
    handle(req, res)
      .catch((err: unknown) => {
        log.error('unhandled', { err: shortMessage(err) });
        if (!res.headersSent) send(res, 500, { error: 'INTERNAL', detail: 'unhandled error' });
      })
      .finally(() => active--);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 64;
  return server;
}
