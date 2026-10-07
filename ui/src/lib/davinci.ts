/**
 * DAVINCI Elections pairing (docs/davinci-integration.md; the Elections pairing API, version 1).
 *
 * A fresh one-use code is typed by hand (never read from a URL), resolved only at an Elections
 * origin pinned in config.json, and a fail-closed deployment check runs before any grant: the
 * adapter granted is read on chain from the pinned registry, the creator comes from the pinned
 * origin's resolve. Nothing in a link or a response ever picks the origin, the registry or the
 * adapter. The code is a short-lived bearer secret: it is not logged, persisted or put in any
 * URL other than the two API paths.
 */

import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';
import type { AppConfig } from '../config';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Crockford-normalize a typed pairing code: upper-case, drop spaces and dashes, O→0, I/L→1.
 * Null unless the result is exactly 12 alphabet symbols.
 */
export function normalizePairingCode(raw: string): string | null {
  const code = raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (code.length !== 12) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  return code;
}

/** `XXXX-XXXX-XXXX`, for display next to the input. */
export const formatPairingCode = (code: string): string =>
  `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;

/** A pairing step refused, with the message already written for the organizer. */
export class PairingError extends Error {
  /** For support (console only): the mismatching field or HTTP detail. Never shown as the main copy. */
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'PairingError';
    this.detail = detail;
  }
}

export const CODE_INVALID_TEXT =
  'This code is not valid anymore. Ask for a new code in DAVINCI Elections (Committees → Get a pairing code).';
export const UNAVAILABLE_TEXT =
  'DAVINCI Elections cannot connect committees right now. Try again later or contact its operators.';
export const MISMATCH_TEXT =
  'This DAVINCI Elections server uses a different voting network than this committee. Nothing was changed.';
export const UNREACHABLE_TEXT = 'We could not reach DAVINCI Elections. Check your connection and try again.';
export const BAD_CODE_SHAPE_TEXT =
  'That does not look like a pairing code — it is 12 letters and numbers, like K7F4-Q2ND-8HXR.';
export const GRANTS_UNCONFIRMED_TEXT =
  'The network has not confirmed the approvals yet. Nothing is lost — press Connect again in a few ' +
  'minutes; the approvals already made are kept and never re-sent.';

/**
 * How the grant-confirmation wait polls (§6: complete only after both grants are *finalized*,
 * since every read this app acts on is at a finalized block). Mutable so tests can shrink it.
 */
export const grantWaitTuning = { pollMs: 2_000, maxMs: 30 * 60_000 };

/**
 * Wait until `allGranted` (authenticated finalized reads for BOTH grants) holds, then return;
 * after `maxMs` give up with the plain retry message. A sent-but-unmined (or later reverted)
 * grant must never let the completion consume the one-use code — Elections would verify, find
 * the grants missing and park the committee in `forming` while this app says it is done.
 */
export async function waitForGrants(allGranted: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + grantWaitTuning.maxMs;
  for (;;) {
    if (await allGranted()) return;
    if (Date.now() >= deadline) throw new PairingError(GRANTS_UNCONFIRMED_TEXT);
    await new Promise((resolve) => setTimeout(resolve, grantWaitTuning.pollMs));
  }
}

export interface ResolvedPairing {
  orgId: string;
  orgName: string;
  creator: Hex;
  chainId: number;
  manager: Hex;
  registry: Hex;
  adapter: Hex;
  /** ISO 8601 end of the code's validity. */
  expiresAt: string;
}

export interface CompletionResult {
  status: 'ready' | 'open' | 'forming' | 'unusable';
  statusReason: string | null;
  returnPath: string;
}

const isHexAddress = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * One API call against the pinned origin; errors mapped to plain language per the contract.
 * `redirect: 'error'` — following a redirect would let another server answer for the pinned
 * origin (supply the creator, swallow the completion) while the UI still names the pinned host.
 */
async function api(origin: string, path: string, init: RequestInit, fetchFn: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${origin}${path}`, { ...init, credentials: 'omit', redirect: 'error' });
  } catch {
    throw new PairingError(UNREACHABLE_TEXT);
  }
  if (res.ok) {
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new PairingError(UNAVAILABLE_TEXT, 'invalid JSON in a 200 response');
    }
  }
  const body: unknown = await res.json().catch(() => undefined);
  const code =
    typeof body === 'object' && body !== null
      ? String((body as { error?: { code?: unknown } }).error?.code ?? '')
      : '';
  // Unknown, expired, used and superseded codes are indistinguishable on purpose (404);
  // a 400 here means the code was malformed, which reads the same to the organizer.
  if (res.status === 404 || res.status === 400) throw new PairingError(CODE_INVALID_TEXT, `HTTP ${res.status} ${code}`);
  if (res.status === 429) {
    const seconds = Number(res.headers.get('Retry-After'));
    const wait = Number.isFinite(seconds) && seconds > 0 ? `about ${Math.ceil(seconds / 60)} min` : 'a few minutes';
    throw new PairingError(`DAVINCI Elections is getting too many requests from this connection. Try again in ${wait}.`);
  }
  throw new PairingError(UNAVAILABLE_TEXT, `HTTP ${res.status} ${code}`);
}

/**
 * Resolve a normalized code at the pinned origin (GET; marks the code claimed, re-resolvable
 * while valid). Strictly validates the shape; `version !== 1` aborts.
 */
export async function resolvePairing(origin: string, code: string, fetchFn: typeof fetch = fetch): Promise<ResolvedPairing> {
  const body = await api(origin, `/api/public/council-pairing/${encodeURIComponent(code)}`, { method: 'GET' }, fetchFn);
  const malformed = (field: string) => new PairingError(UNAVAILABLE_TEXT, `malformed resolve response: ${field}`);
  if (typeof body !== 'object' || body === null) throw malformed('not an object');
  const o = body as Record<string, unknown>;
  if (o.version !== 1) {
    throw new PairingError(
      'This DAVINCI Elections server needs a newer version of this committee app. Nothing was changed.',
      `version ${String(o.version)}`,
    );
  }
  if (typeof o.orgId !== 'string' || o.orgId === '') throw malformed('orgId');
  if (typeof o.orgName !== 'string' || o.orgName.trim() === '') throw malformed('orgName');
  if (!isHexAddress(o.creator)) throw malformed('creator');
  if (typeof o.chainId !== 'number' || !Number.isInteger(o.chainId) || o.chainId <= 0) throw malformed('chainId');
  if (!isHexAddress(o.manager)) throw malformed('manager');
  if (!isHexAddress(o.registry)) throw malformed('registry');
  if (!isHexAddress(o.adapter)) throw malformed('adapter');
  return {
    orgId: o.orgId,
    orgName: o.orgName.trim(),
    creator: o.creator,
    chainId: o.chainId,
    manager: o.manager,
    registry: o.registry,
    adapter: o.adapter,
    expiresAt: typeof o.expiresAt === 'string' ? o.expiresAt : '',
  };
}

/**
 * The fail-closed deployment check (contract §5, items 3–7) between the resolve response, the
 * pinned configuration and `onChainAdapter` — the `councilAdapter()` this app read on chain from
 * the pinned registry, which is the address actually granted. Throws the one plain mismatch
 * error, with the disagreeing field as the support detail.
 */
export function checkDeployment(resolved: ResolvedPairing, config: AppConfig, onChainAdapter: Hex): void {
  const mismatch = (field: string) => new PairingError(MISMATCH_TEXT, `${field} does not match`);
  if (resolved.chainId !== config.chainId) throw mismatch(`chainId ${resolved.chainId}`);
  if (resolved.manager.toLowerCase() !== config.manager.toLowerCase()) throw mismatch('manager');
  if (!config.davinci || resolved.registry.toLowerCase() !== config.davinci.registry.toLowerCase()) {
    throw mismatch('registry');
  }
  if (resolved.adapter.toLowerCase() !== onChainAdapter.toLowerCase()) throw mismatch('adapter');
  if (BigInt(resolved.creator) === 0n) throw mismatch('creator (zero)');
}

/**
 * Report the ceremony id back (POST complete; uses the code up). Call only after both grants
 * are mined. A 404 here means the code expired meanwhile — the grants are in place, so the
 * caller asks for a new code and the grant steps are skipped on the retry.
 */
export async function completePairing(
  origin: string,
  code: string,
  cid: Hex,
  fetchFn: typeof fetch = fetch,
): Promise<CompletionResult> {
  const body = await api(
    origin,
    `/api/public/council-pairing/${encodeURIComponent(code)}/complete`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cid }) },
    fetchFn,
  );
  // A 200 already consumed the code and recorded the link; read the rest leniently.
  const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const status = o.status;
  return {
    status: status === 'ready' || status === 'open' || status === 'forming' || status === 'unusable' ? status : 'forming',
    statusReason: typeof o.statusReason === 'string' ? o.statusReason : null,
    returnPath: typeof o.returnPath === 'string' ? o.returnPath : '',
  };
}

/**
 * The cosmetic "back to DAVINCI Elections" link: `{pinnedOrigin}{returnPath}` only when the path
 * has the one allowed shape and names `orgId`; else the organizer home on the pinned origin.
 */
export function returnLink(origin: string, returnPath: string, orgId: string): string {
  if (/^\/organizer\/orgs\/[0-9a-f-]{36}\/committees$/.test(returnPath) && returnPath.split('/')[3] === orgId) {
    return `${origin}${returnPath}`;
  }
  return `${origin}/organizer`;
}
