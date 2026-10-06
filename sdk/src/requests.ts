/**
 * Decryption requests from contract state (architecture §4 `client`, protocol §9.3 item 3).
 *
 * Which vote a request belongs to is read from the request record itself (`getRequestOrigin`:
 * adapter, DAVINCI process id, creator), never from event logs, and confirmed at the same
 * authenticated finalized anchor: the request id recomputes from (chain, manager, ceremony,
 * adapter, process id), `getBinding(adapter, processId)` maps back to exactly this request and
 * ceremony and says it was submitted, the adapter is allowed and the creator authorized by this
 * ceremony. Enumeration uses `getRequestCount` + `getRequestIdsPage`. Both work from any
 * archive-free RPC for as long as the chain exists, however old the ceremony.
 */

import { normalizeCeremonyId, requestId as computeRequestId } from './encoding.js';
import type { FinalizedAnchor, ViewCall } from './client.js';
import type { Hex } from './types.js';

/** The authenticated-read surface these helpers need (`CouncilClient`, or a test double). */
export interface AuthenticatedReader {
  readonly chainId: bigint;
  readonly manager: Hex;
  authenticatedRead(calls: ViewCall[], anchor?: FinalizedAnchor): Promise<{ results: unknown[]; anchor: FinalizedAnchor }>;
}

/** Request ids per `getRequestIdsPage` call. */
export const REQUEST_PAGE_SIZE = 64;

/** Who bound a request (`getRequestOrigin`). */
export interface RequestOrigin {
  adapter: Hex;
  processId: Hex;
  creator: Hex;
}

/** Why a request's binding was refused, in the order the checks run. */
export type RequestBindingRefusal =
  /** `getBinding` names another ceremony than the one asked about. */
  | 'other-ceremony'
  /** The stored origin does not recompute to this request id, or `getBinding` maps elsewhere. */
  | 'binding-mismatch'
  /** The adapter that bound it is not allowed by this ceremony. */
  | 'adapter-not-allowed'
  /** The creator recorded for it is not authorized by this ceremony. */
  | 'creator-not-authorized'
  /** Bound, but its ciphertexts were not submitted yet. */
  | 'not-submitted';

export type RequestBinding =
  | ({ ok: true; anchor: FinalizedAnchor } & RequestOrigin)
  | { ok: false; reason: RequestBindingRefusal; anchor: FinalizedAnchor };

export async function readRequestOrigin(
  reader: AuthenticatedReader,
  requestIdValue: Hex,
  anchor?: FinalizedAnchor,
): Promise<RequestOrigin & { anchor: FinalizedAnchor }> {
  const { results, anchor: at } = await reader.authenticatedRead(
    [{ functionName: 'getRequestOrigin', args: [requestIdValue] }],
    anchor,
  );
  const [adapter, processId, creator] = results[0] as readonly [Hex, Hex, Hex];
  return { adapter, processId, creator, anchor: at };
}

/** Every request id bound to `cid`, in binding order, read page by page at one anchor. */
export async function readRequestIds(
  reader: AuthenticatedReader,
  cid: Hex,
  anchor?: FinalizedAnchor,
  pageSize: number = REQUEST_PAGE_SIZE,
): Promise<{ ids: Hex[]; anchor: FinalizedAnchor }> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('readRequestIds: pageSize must be a positive integer');
  const id = normalizeCeremonyId(cid);
  const first = await reader.authenticatedRead([{ functionName: 'getRequestCount', args: [id] }], anchor);
  const count = Number(first.results[0] as bigint | number);
  const calls: ViewCall[] = [];
  for (let offset = 0; offset < count; offset += pageSize) {
    calls.push({ functionName: 'getRequestIdsPage', args: [id, BigInt(offset), BigInt(pageSize)] });
  }
  const ids: Hex[] = [];
  if (calls.length > 0) {
    const { results } = await reader.authenticatedRead(calls, first.anchor);
    for (const page of results) ids.push(...(page as readonly Hex[]));
  }
  if (ids.length !== count) throw new Error('council client: the request list does not match its count — refusing');
  return { ids, anchor: first.anchor };
}

/**
 * The vote a request belongs to, derived from state and authenticated at one finalized anchor
 * (protocol §9.3 item 3). A refusal says which check failed; a read failure throws.
 */
export async function readRequestBinding(
  reader: AuthenticatedReader,
  cid: Hex,
  requestIdValue: Hex,
  anchor?: FinalizedAnchor,
): Promise<RequestBinding> {
  const id = normalizeCeremonyId(cid);
  const origin = await readRequestOrigin(reader, requestIdValue, anchor);
  const at = origin.anchor;
  const refuse = (reason: RequestBindingRefusal): RequestBinding => ({ ok: false, reason, anchor: at });
  const { results } = await reader.authenticatedRead(
    [
      { functionName: 'getBinding', args: [origin.adapter, origin.processId] },
      { functionName: 'isAdapterAllowed', args: [id, origin.adapter] },
      { functionName: 'isCreatorAuthorized', args: [id, origin.creator] },
    ],
    at,
  );
  const [boundCid, boundRequestId, requested] = results[0] as readonly [Hex, Hex, boolean];
  if (boundCid.toLowerCase() !== id) return refuse('other-ceremony');
  const expected = computeRequestId(reader.chainId, reader.manager, id, origin.adapter, origin.processId);
  const rid = requestIdValue.toLowerCase();
  if (expected.toLowerCase() !== rid || boundRequestId.toLowerCase() !== rid) return refuse('binding-mismatch');
  if (results[1] !== true) return refuse('adapter-not-allowed');
  if (results[2] !== true) return refuse('creator-not-authorized');
  if (requested !== true) return refuse('not-submitted');
  return { ok: true, adapter: origin.adapter, processId: origin.processId, creator: origin.creator, anchor: at };
}
