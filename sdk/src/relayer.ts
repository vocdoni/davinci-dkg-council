/**
 * Relayer HTTP client (architecture §5.1). Wire format, pinned: field elements
 * and all other unsigned integers are canonical decimal strings; ids,
 * addresses and signatures are 0x-hex; `memberSet`/`fieldIndexes` are JSON
 * numbers. Any action can bypass the relayer via `client.sendAction`.
 */

import { toDecimal } from './encoding.js';
import type { Action, Groth16Proof, Hex, Point } from './types.js';

export interface RelayResponse {
  txHash: Hex;
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
    case 'finalize':
    case 'abort':
      return { ...base, payload: { ceremonyId: action.ceremonyId } };
    case 'combine':
      return {
        ...base,
        payload: {
          requestId: action.requestId,
          memberSet: action.memberSet,
          fieldIndexes: action.fieldIndexes,
          plaintexts: action.plaintexts.map(toDecimal),
        },
      };
  }
}

export class RelayerClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(baseUrl: string, options: { fetchFn?: typeof fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    // Never `this.fetchFn = fetch`: calling it as a method passes this client as the receiver,
    // which a browser's window.fetch rejects ("Illegal invocation"). Node does not care.
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** POST /v1/relay. Resolves to the tx hash or throws a RelayerError. */
  async relay(chainId: bigint, manager: Hex, action: Action): Promise<Hex> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(relayRequestBody(chainId, manager, action)),
    });
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
  }

  /** GET /v1/status/:txHash. */
  async status(txHash: Hex): Promise<RelayStatus> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/status/${txHash}`);
    if (!res.ok) throw new RelayerError('INTERNAL', `status: HTTP ${res.status}`, undefined, res.status);
    return (await res.json()) as RelayStatus;
  }

  /** GET /v1/health. */
  async health(): Promise<RelayerHealth> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/health`);
    if (!res.ok) throw new RelayerError('INTERNAL', `health: HTTP ${res.status}`, undefined, res.status);
    return (await res.json()) as RelayerHealth;
  }
}
