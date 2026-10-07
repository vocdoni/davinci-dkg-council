/**
 * Relayer HTTP client (architecture §5.1). Wire format, pinned: field elements
 * and all other unsigned integers are canonical decimal strings; ids,
 * addresses and signatures are 0x-hex; `memberSet`/`fieldIndexes` are JSON
 * numbers. Any action can bypass the relayer via `client.sendAction`.
 *
 * `RelayerPool` fails over across several relayers in order: relayers add no
 * trust (every action is signed and re-checked on chain), so any of them may
 * carry an action — but one that refuses the action itself is final, and the
 * next is not asked.
 */

import type { PrivateKeyAccount } from 'viem/accounts';
import { toDecimal } from './encoding.js';
import { assertCanonicalSignature } from './eip712.js';
import type { Action, Groth16Proof, Hex, Point } from './types.js';

export interface RelayResponse {
  txHash: Hex;
}

// --- POST /v1/track: register a ceremony with a relayer's combine worker ---
//
// Tracking makes the relayer enumerate the ceremony's requests from contract
// state (`getRequestCount` / `getRequestIdsPage`), so its decryption is served
// however the relayer's log discovery fares (a provider that pruned history, a
// restart months later, a lost state file). It is authenticated by the
// ceremony organizer's EIP-712 signature in the relayer's OWN domain — never
// the protocol's, so a track signature cannot be replayed as a protocol
// action — or by a bearer API token the relayer's operator issued.

export const TRACK_DOMAIN_NAME = 'DAVINCI DKG Council Relayer';
export const TRACK_DOMAIN_VERSION = '1';
/** `TrackCeremony(bytes12 ceremonyId,uint64 validUntil)`. */
export const TRACK_TYPES = {
  TrackCeremony: [
    { name: 'ceremonyId', type: 'bytes12' },
    { name: 'validUntil', type: 'uint64' },
  ],
} as const;

/** The EIP-712 domain a track request is signed in (the relayer's own). */
export const trackDomain = (chainId: bigint, manager: Hex) =>
  ({ name: TRACK_DOMAIN_NAME, version: TRACK_DOMAIN_VERSION, chainId, verifyingContract: manager }) as const;

export interface TrackCeremonyRequest {
  ceremonyId: Hex;
  /** Unix seconds; present together with `signature` (both absent with a bearer token). */
  validUntil?: bigint;
  /** The organizer's signature over `TRACK_TYPES` in `trackDomain`. */
  signature?: Hex;
}

/** Sign a track request as the ceremony organizer. */
export async function signTrackCeremony(
  account: PrivateKeyAccount,
  chainId: bigint,
  manager: Hex,
  ceremonyId: Hex,
  validUntil: bigint,
): Promise<TrackCeremonyRequest> {
  const signature = await account.signTypedData({
    domain: trackDomain(chainId, manager),
    types: TRACK_TYPES,
    primaryType: 'TrackCeremony',
    message: { ceremonyId, validUntil },
  });
  assertCanonicalSignature(signature);
  return { ceremonyId, validUntil, signature };
}

/** The exact §5.1 `/v1/track` request body. Exported for tests. */
export function trackRequestBody(chainId: bigint, manager: Hex, request: TrackCeremonyRequest): Record<string, unknown> {
  return {
    chainId: toDecimal(chainId),
    manager,
    ceremonyId: request.ceremonyId,
    ...(request.signature !== undefined && request.validUntil !== undefined
      ? { validUntil: toDecimal(request.validUntil), signature: request.signature }
      : {}),
  };
}

export interface RelayStatus {
  status: 'pending' | 'confirmed' | 'failed';
  blockNumber?: string;
  revertReason?: string;
}

export interface RelayerHealth {
  ok: boolean;
  chainId: string;
  manager: Hex;
  relayer: Hex;
  balanceWei: string;
}

export class RelayerError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly revertData?: Hex,
    readonly httpStatus?: number,
  ) {
    super(`relayer: ${code}: ${detail}`);
    this.name = 'RelayerError';
  }
}

/** Serialize a typed message struct: bigint/number -> decimal string, hex kept. */
const wireMessage = (message: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(message)) {
    if (typeof v === 'bigint' || typeof v === 'number') out[k] = toDecimal(v);
    else if (Array.isArray(v)) out[k] = v.map((e) => (typeof e === 'bigint' || typeof e === 'number' ? toDecimal(e) : e));
    else out[k] = v;
  }
  return out;
};

const wirePoint = (p: Point): [string, string] => [toDecimal(p.x), toDecimal(p.y)];

const wireProof = (proof: Groth16Proof) => ({
  pA: proof.pA.map(toDecimal),
  pB: proof.pB.map((row) => row.map(toDecimal)),
  pC: proof.pC.map(toDecimal),
});

/** The exact §5.1 request body for one action. Exported for tests. */
export function relayRequestBody(chainId: bigint, manager: Hex, action: Action): Record<string, unknown> {
  const base: Record<string, unknown> = {
    action: action.kind,
    // Canonical decimal string — a JSON number would silently lose precision
    // for chain ids above 2^53.
    chainId: toDecimal(chainId),
    manager,
  };
  switch (action.kind) {
    case 'createCeremony':
    case 'addInvites':
    case 'closeRegistration':
    case 'allowAdapter':
    case 'authorizeCreator':
      return { ...base, message: wireMessage(action.message as never), signatures: [action.signature] };
    case 'join':
      return {
        ...base,
        message: { join: wireMessage(action.message as never), invite: wireMessage(action.invite as never) },
        signatures: [action.signature, action.inviteSignature],
      };
    case 'deal':
      return {
        ...base,
        message: wireMessage(action.message as never),
        signatures: [action.signature],
        payload: {
          C: action.payload.C.map(wirePoint),
          E: wirePoint(action.payload.E),
          masked: action.payload.masked.map(toDecimal),
          proof: wireProof(action.payload.proof),
        },
      };
    case 'submitPartial':
      return {
        ...base,
        message: wireMessage(action.message as never),
        signatures: [action.signature],
        payload: { D: action.payload.D.map(wirePoint), proof: wireProof(action.payload.proof) },
      };
    case 'openDecryption':
      return { ...base, message: wireMessage(action.message as never), signatures: [action.signature] };
    case 'finalize':
    case 'abort':
    case 'closeRegistrationScheduled':
      return { ...base, payload: { ceremonyId: action.ceremonyId } };
    case 'combine':
      return {
        ...base,
        payload: {
          requestId: action.requestId,
          memberSet: action.memberSet,
          fieldIndexes: action.fieldIndexes,
          plaintexts: action.plaintexts.map(toDecimal),
          // The relayer rebuilds C2 from state; the D vectors travel on the wire (§5.1).
          partialVectors: action.partialVectors.map((v) => v.map(wirePoint)),
        },
      };
    case 'publishPartialData':
      return {
        ...base,
        payload: {
          requestId: action.requestId,
          participantIndex: action.participantIndex,
          D: action.D.map(wirePoint),
        },
      };
  }
}

export class RelayerClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number | undefined;

  /**
   * `timeoutMs` bounds each request, headers and body: a relayer that accepts the connection but
   * never answers then fails with code `TIMEOUT` (outcome unknown — a relay may still land).
   */
  constructor(baseUrl: string, options: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    // Never `this.fetchFn = fetch`: calling it as a method passes this client as the receiver,
    // which a browser's window.fetch rejects ("Illegal invocation"). Node does not care.
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs;
  }

  /** One request and the read of its answer, within `timeoutMs` when set. */
  private async call<T>(path: string, init: RequestInit, read: (res: Response) => Promise<T>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    if (this.timeoutMs === undefined) return read(await this.fetchFn(url, init));
    const ctl = new AbortController();
    const timeout = () =>
      new RelayerError('TIMEOUT', `${url}: no answer within ${this.timeoutMs} ms — the outcome is unknown`);
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    // Also settle when a fetch implementation ignores the signal.
    const aborted = new Promise<never>((_, reject) => ctl.signal.addEventListener('abort', () => reject(timeout())));
    aborted.catch(() => undefined);
    try {
      const out = await Promise.race([
        this.fetchFn(url, { ...init, signal: ctl.signal }).then((res) => Promise.race([read(res), aborted])),
        aborted,
      ]);
      if (ctl.signal.aborted) throw timeout();
      return out;
    } catch (err) {
      if (ctl.signal.aborted) throw timeout();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /v1/relay. Resolves to the tx hash or throws a RelayerError. */
  async relay(chainId: bigint, manager: Hex, action: Action): Promise<Hex> {
    return this.call(
      '/v1/relay',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(relayRequestBody(chainId, manager, action)),
      },
      async (res) => {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          throw new RelayerError(
            typeof body.error === 'string' ? body.error : 'INTERNAL',
            typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`,
            typeof body.revertData === 'string' ? (body.revertData as Hex) : undefined,
            res.status,
          );
        }
        if (typeof body.txHash !== 'string') throw new RelayerError('INTERNAL', 'missing txHash in relay response');
        return body.txHash as Hex;
      },
    );
  }

  /**
   * POST /v1/track: register a ceremony with this relayer's combine worker,
   * authenticated by the organizer signature in `request` or by a bearer API
   * `token`. Idempotent; throws a RelayerError when the relayer refuses (e.g.
   * a relayer without a combine worker answers 404).
   */
  async track(chainId: bigint, manager: Hex, request: TrackCeremonyRequest, token?: string): Promise<void> {
    await this.call(
      '/v1/track',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(trackRequestBody(chainId, manager, request)),
      },
      async (res) => {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok || body.tracked !== true) {
          throw new RelayerError(
            typeof body.error === 'string' ? body.error : 'INTERNAL',
            typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`,
            undefined,
            res.status,
          );
        }
      },
    );
  }

  /** GET /v1/status/:txHash. */
  async status(txHash: Hex): Promise<RelayStatus> {
    return this.call(`/v1/status/${txHash}`, {}, async (res) => {
      if (!res.ok) throw new RelayerError('INTERNAL', `status: HTTP ${res.status}`, undefined, res.status);
      return (await res.json()) as RelayStatus;
    });
  }

  /** GET /v1/health. */
  async health(): Promise<RelayerHealth> {
    return this.call('/v1/health', {}, async (res) => {
      if (!res.ok) throw new RelayerError('INTERNAL', `health: HTTP ${res.status}`, undefined, res.status);
      return (await res.json()) as RelayerHealth;
    });
  }
}

/**
 * Relayer refusals about the action itself: another relayer would answer the
 * same, so a pool stops at the first of these instead of trying the next.
 * Everything else (unreachable, overloaded, out of budget, not sponsoring,
 * serving another deployment) moves on to the next relayer.
 */
const FINAL_REFUSALS = new Set([
  'SIMULATION_REVERTED',
  'BAD_SIGNATURE',
  'INVALID_ACTION',
  'CONFLICT',
  'UNSUPPORTED_MEDIA_TYPE',
]);

/** Is `err` a refusal of the action itself (no other relayer should be asked)? */
export function isFinalRelayerRefusal(err: unknown): boolean {
  return err instanceof RelayerError && FINAL_REFUSALS.has(err.code);
}

/** One relayer that did not take the request, and why. */
export interface RelayerFailure {
  url: string;
  error: unknown;
}

/** No relayer of a pool took the request; `failures` lists each one's answer, in order. */
export class RelayersUnavailableError extends Error {
  constructor(readonly failures: RelayerFailure[]) {
    super(
      `relayer: none of ${failures.length} relayer(s) took the request (` +
        failures.map((f) => `${f.url}: ${f.error instanceof Error ? f.error.message : String(f.error)}`).join('; ') +
        ')',
    );
    this.name = 'RelayersUnavailableError';
  }
}

/** Several relayers tried in order (architecture §5): the first that takes an action carries it. */
export class RelayerPool {
  readonly urls: readonly string[];
  private readonly clients: RelayerClient[];
  /** Which relayer sent each transaction, so its status is asked there first. */
  private readonly sentBy = new Map<string, number>();

  /**
   * `timeoutMs` (default 30 s) bounds each relayer's answer, so a relayer that stalls is skipped
   * like one that is down (its outcome is unknown; the next relayer gets the same signed action,
   * which the chain accepts once).
   */
  constructor(urls: readonly string[], options: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    if (urls.length === 0) throw new Error('relayer pool: at least one relayer URL is required');
    this.urls = urls.slice();
    this.clients = urls.map((u) => new RelayerClient(u, { timeoutMs: 30_000, ...options }));
  }

  /**
   * Relay through the first relayer that takes the action. A final refusal
   * (`isFinalRelayerRefusal`) is thrown as is; when every relayer failed
   * otherwise, throws `RelayersUnavailableError`.
   */
  async relay(chainId: bigint, manager: Hex, action: Action): Promise<Hex> {
    const failures: RelayerFailure[] = [];
    for (let i = 0; i < this.clients.length; i++) {
      try {
        const txHash = await (this.clients[i] as RelayerClient).relay(chainId, manager, action);
        this.sentBy.set(txHash.toLowerCase(), i);
        return txHash;
      } catch (err) {
        if (isFinalRelayerRefusal(err)) throw err;
        failures.push({ url: this.urls[i] as string, error: err });
      }
    }
    throw new RelayersUnavailableError(failures);
  }

  /** The status from the relayer that sent `txHash` (else the first that knows it). */
  async status(txHash: Hex): Promise<RelayStatus> {
    const first = this.sentBy.get(txHash.toLowerCase());
    const order = [...(first === undefined ? [] : [first]), ...this.clients.keys()].filter(
      (i, k, all) => all.indexOf(i) === k,
    );
    const failures: RelayerFailure[] = [];
    for (const i of order) {
      try {
        return await (this.clients[i] as RelayerClient).status(txHash);
      } catch (err) {
        failures.push({ url: this.urls[i] as string, error: err });
      }
    }
    throw new RelayersUnavailableError(failures);
  }

  /**
   * Register a ceremony with **every** relayer of the pool (unlike `relay`,
   * tracking is per relayer: each combine worker keeps its own list). Never
   * throws; returns each relayer's outcome, in order.
   */
  async track(
    chainId: bigint,
    manager: Hex,
    request: TrackCeremonyRequest,
  ): Promise<{ url: string; tracked: boolean; error?: unknown }[]> {
    return Promise.all(
      this.clients.map((c, i) =>
        c.track(chainId, manager, request).then(
          () => ({ url: this.urls[i] as string, tracked: true }),
          (error: unknown) => ({ url: this.urls[i] as string, tracked: false, error }),
        ),
      ),
    );
  }

  /** Every relayer's health, in order (never throws; a failed one carries its error). */
  async health(): Promise<{ url: string; health?: RelayerHealth; error?: unknown }[]> {
    return Promise.all(
      this.clients.map((c, i) =>
        c.health().then(
          (health) => ({ url: this.urls[i] as string, health }),
          (error: unknown) => ({ url: this.urls[i] as string, error }),
        ),
      ),
    );
  }
}
