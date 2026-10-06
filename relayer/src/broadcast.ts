/**
 * Broadcasting a signed transaction over several RPC endpoints.
 *
 * A refusal that says nothing about the transaction — method not allowed, a plan that does not
 * include sends, an auth failure, a rate limit, a transport error — is an *endpoint* failure:
 * the next endpoint is tried. A refusal about the transaction itself (nonce, fees, funds, gas)
 * is authoritative and stops the walk. When every endpoint fails, the most informative refusal
 * is raised, so an endpoint that cannot send never masks another endpoint's `nonce too low`
 * (viem's `fallback` transport raises the last error instead; the Sepolia run lost a ceremony to
 * that, docs/deployments.md).
 */

import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';
import type { PublicClient } from 'viem';
import { shortMessage } from './errors.js';

export interface Endpoint {
  /** Host only, for logs: never a URL that could carry an API key. */
  name: string;
  client: PublicClient;
}

/**
 * - accepted: the node already has it ("already known"), as good as a success;
 * - nonce: the nonce is used or taken (resync, retry);
 * - tx: the transaction itself is refused (funds, gas, fees): definitive;
 * - unknown: unclassified; try the next endpoint;
 * - transient / endpoint: rate limit, timeout, 5xx / method, plan, auth: try the next endpoint.
 */
export type SendErrorClass = 'accepted' | 'nonce' | 'tx' | 'unknown' | 'transient' | 'endpoint';

/** Most informative first. */
const PRIORITY: SendErrorClass[] = ['nonce', 'tx', 'unknown', 'transient', 'endpoint'];

const ACCEPTED = /already known|known transaction|already imported|already in (the )?(tx)?pool|alreadyknown/i;
const NONCE = /nonce too low|nonce too high|invalid nonce|nonce has already been used|nonce is too low|old nonce|replacement transaction underpriced|replacement fee too low|transaction underpriced: replacement/i;
const TX = /insufficient funds|intrinsic gas too low|gas limit reached|exceeds block gas limit|max fee per gas less than block base fee|fee cap less than block base fee|tip higher than fee cap|max priority fee per gas higher than max fee|feecap|transaction underpriced|tx fee .* exceeds|invalid sender|invalid signature|invalid transaction|oversized data|gas too low|underpriced/i;
const TRANSIENT = /rate limit|too many requests|request limit|exceeded the (daily|monthly|request)|capacity|timeout|timed out|fetch failed|econnrefused|econnreset|enotfound|eai_again|socket hang up|network error|service unavailable|bad gateway|gateway time|temporarily|try again|overloaded|header not found/i;
const ENDPOINT = /method not (found|allowed|supported|available)|not supported|unsupported method|does not exist\/is not available|not available on (your|the|this|free)|free plan|paid plan|upgrade (your )?plan|not (included|enabled) (in|on|for) (your|this)|unauthori[sz]ed|forbidden|api key|access denied|invalid project id|not whitelisted|blocked|disabled/i;

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const ENDPOINT_STATUS = new Set([401, 402, 403, 404, 405, 501]);
const TRANSIENT_NAMES = new Set(['HttpRequestError', 'TimeoutError', 'LimitExceededRpcError', 'ResourceUnavailableRpcError', 'InternalRpcError']);
const ENDPOINT_NAMES = new Set([
  'MethodNotFoundRpcError',
  'MethodNotSupportedRpcError',
  'UnauthorizedProviderError',
  'UnsupportedProviderMethodError',
]);
const ENDPOINT_CODES = new Set([-32601, -32004, 4100, 4200]);
const TRANSIENT_CODES = new Set([-32005, -32002, 429]);

function chain(err: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur as Record<string, unknown>);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

function text(err: unknown): string {
  const parts: string[] = [];
  for (const e of chain(err)) {
    for (const k of ['message', 'details', 'shortMessage']) if (typeof e[k] === 'string') parts.push(e[k] as string);
  }
  return parts.length > 0 ? parts.join(' | ') : String(err);
}

/** The node's own words when viem kept them (`details`), else viem's summary. */
export function describeSendError(err: unknown): string {
  for (const e of chain(err)) if (typeof e.details === 'string' && e.details.trim() !== '') return e.details;
  return shortMessage(err);
}

/** Classify an eth_sendRawTransaction failure (message first: providers misuse codes). */
export function classifySendError(err: unknown): SendErrorClass {
  const t = text(err);
  if (ACCEPTED.test(t)) return 'accepted';
  if (NONCE.test(t)) return 'nonce';
  if (TX.test(t)) return 'tx';
  if (ENDPOINT.test(t)) return 'endpoint';
  if (TRANSIENT.test(t)) return 'transient';
  for (const e of chain(err)) {
    const status = typeof e.status === 'number' ? e.status : undefined;
    const code = typeof e.code === 'number' ? e.code : undefined;
    const name = typeof e.name === 'string' ? e.name : '';
    if ((status !== undefined && ENDPOINT_STATUS.has(status)) || (code !== undefined && ENDPOINT_CODES.has(code)) || ENDPOINT_NAMES.has(name)) {
      return 'endpoint';
    }
    if ((status !== undefined && TRANSIENT_STATUS.has(status)) || (code !== undefined && TRANSIENT_CODES.has(code)) || TRANSIENT_NAMES.has(name)) {
      return 'transient';
    }
  }
  return 'unknown';
}

/** Every endpoint refused: carries the most informative refusal as its cause. */
export class BroadcastError extends Error {
  constructor(
    readonly kind: SendErrorClass,
    readonly failures: { endpoint: string; kind: SendErrorClass; error: unknown }[],
    best: { endpoint: string; error: unknown },
  ) {
    super(
      `${describeSendError(best.error)} (${best.endpoint})` +
        (failures.length > 1
          ? `; ${failures
              .filter((f) => f.error !== best.error)
              .map((f) => `${f.endpoint}: ${f.kind}`)
              .join(', ')}`
          : ''),
      { cause: best.error },
    );
    this.name = 'BroadcastError';
  }
}

/**
 * Send `raw` to the endpoints in order until one accepts it or refuses the transaction itself.
 * `onEndpointFailure` reports refusals that moved on to the next endpoint.
 */
export async function broadcastRaw(
  endpoints: Endpoint[],
  raw: Hex,
  onEndpointFailure?: (endpoint: string, kind: SendErrorClass, err: unknown) => void,
): Promise<void> {
  const failures: { endpoint: string; kind: SendErrorClass; error: unknown }[] = [];
  for (const ep of endpoints) {
    try {
      await ep.client.request({ method: 'eth_sendRawTransaction', params: [raw] });
      return;
    } catch (err) {
      const kind = classifySendError(err);
      if (kind === 'accepted') return;
      failures.push({ endpoint: ep.name, kind, error: err });
      if (kind === 'nonce' || kind === 'tx') break;
      onEndpointFailure?.(ep.name, kind, err);
    }
  }
  const best = failures.reduce((a, b) => (PRIORITY.indexOf(b.kind) < PRIORITY.indexOf(a.kind) ? b : a));
  throw new BroadcastError(best.kind, failures, best);
}
