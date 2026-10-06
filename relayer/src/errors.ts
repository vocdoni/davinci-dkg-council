/**
 * Relayer error codes (architecture §5.1) and revert decoding.
 */

import { COUNCIL_MANAGER_ABI, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { decodeErrorResult } from 'viem';

/**
 * The §5.1 codes plus the sponsorship-policy codes (see README): NOT_FOUND,
 * UNAUTHORIZED, NOT_SPONSORED, QUOTA_EXCEEDED, CONFLICT, BUDGET_EXHAUSTED,
 * BUSY, FORBIDDEN_ORIGIN, UNSUPPORTED_MEDIA_TYPE.
 */
export type ErrorCode =
  | 'INVALID_ACTION'
  | 'BAD_SIGNATURE'
  | 'WRONG_CHAIN'
  | 'UNSUPPORTED_MANAGER'
  | 'SIMULATION_REVERTED'
  | 'RATE_LIMITED'
  | 'TX_FAILED'
  | 'INTERNAL'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'NOT_SPONSORED'
  | 'QUOTA_EXCEEDED'
  | 'CONFLICT'
  | 'BUDGET_EXHAUSTED'
  | 'BUSY'
  | 'FORBIDDEN_ORIGIN'
  | 'UNSUPPORTED_MEDIA_TYPE';

const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_ACTION: 400,
  BAD_SIGNATURE: 400,
  WRONG_CHAIN: 400,
  UNSUPPORTED_MANAGER: 400,
  SIMULATION_REVERTED: 422,
  RATE_LIMITED: 429,
  TX_FAILED: 502,
  INTERNAL: 500,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  NOT_SPONSORED: 403,
  QUOTA_EXCEEDED: 429,
  CONFLICT: 409,
  BUDGET_EXHAUSTED: 503,
  BUSY: 503,
  FORBIDDEN_ORIGIN: 403,
  UNSUPPORTED_MEDIA_TYPE: 415,
};

export class RelayError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    readonly detail: string,
    readonly revertData?: Hex,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'RelayError';
    this.status = HTTP_STATUS[code];
  }

  /** The §5.1 error body. */
  toJSON(): { error: ErrorCode; detail: string; revertData?: Hex } {
    return this.revertData === undefined
      ? { error: this.code, detail: this.detail }
      : { error: this.code, detail: this.detail, revertData: this.revertData };
  }
}

const isHexData = (v: unknown): v is Hex => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);

/**
 * Find the revert data in an RPC error. viem nests the JSON-RPC error (whose
 * `data` carries the revert bytes) somewhere in the `cause` chain; some
 * providers wrap it one level deeper (`data.data`).
 */
export function extractRevertData(err: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const data = (cur as { data?: unknown }).data;
    if (isHexData(data) && data.length >= 10) return data;
    if (data && typeof data === 'object') {
      const inner = (data as { data?: unknown }).data;
      if (isHexData(inner) && inner.length >= 10) return inner;
    }
    // viem's ContractFunctionRevertedError keeps the bytes in `raw`.
    const raw = (cur as { raw?: unknown }).raw;
    if (isHexData(raw) && raw.length >= 10) return raw;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** True when the error is an execution revert rather than a transport failure. */
export function isRevert(err: unknown): boolean {
  if (extractRevertData(err) !== undefined) return true;
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const msg = String((cur as { message?: unknown }).message ?? '');
    const details = String((cur as { details?: unknown }).details ?? '');
    if (/revert/i.test(msg) || /revert/i.test(details)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Decode revert data into `ErrorName()` (custom errors, Error(string), Panic(uint256)). */
export function decodeRevert(data: Hex | undefined): string {
  if (data === undefined || data === '0x') return 'reverted without data';
  try {
    const decoded = decodeErrorResult({ abi: COUNCIL_MANAGER_ABI, data });
    const args = (decoded.args ?? []) as readonly unknown[];
    return `${decoded.errorName}(${args.map(String).join(', ')})`;
  } catch {
    return `unknown revert ${data.slice(0, 10)}`;
  }
}

/** The custom error name of a revert, or undefined. */
export function revertName(err: unknown): string | undefined {
  const data = err instanceof RelayError ? err.revertData : extractRevertData(err);
  if (data === undefined) return undefined;
  try {
    return decodeErrorResult({ abi: COUNCIL_MANAGER_ABI, data }).errorName;
  } catch {
    return undefined;
  }
}

/** Build the SIMULATION_REVERTED error for a failed eth_call / estimate. */
export function simulationError(err: unknown): RelayError {
  const data = extractRevertData(err);
  const detail = data !== undefined ? decodeRevert(data) : shortMessage(err);
  return new RelayError('SIMULATION_REVERTED', detail, data);
}

export function shortMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const short = (err as { shortMessage?: unknown }).shortMessage;
    if (typeof short === 'string' && short.length > 0) return short;
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg.split('\n')[0] ?? msg;
  }
  return String(err);
}
