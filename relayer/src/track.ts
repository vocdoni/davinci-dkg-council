/**
 * POST /v1/track (audit M-02): register a ceremony whose requests the combine worker enumerates
 * from contract state (`getRequestCount` / `getRequestIdsPage`), so its decryption is served
 * however the relayer's log scan fares (a provider that pruned the start block, a restart months
 * later, a lost state file).
 *
 *   { "chainId": "<decimal>", "manager": "0x…", "ceremonyId": "0x<12 bytes>",
 *     "validUntil": "<unix seconds>", "signature": "0x<65 bytes>" }
 *
 * Authenticated by a bearer API token (COUNCIL_API_TOKENS), or by the ceremony organizer's
 * EIP-712 signature over `TrackCeremony(bytes12 ceremonyId,uint64 validUntil)` in the relayer's
 * own domain (`TRACK_DOMAIN`: name "DAVINCI DKG Council Relayer", version "1", the chain id, the
 * manager as verifyingContract — never the protocol's domain, so no such signature can be
 * replayed as a protocol action). Validated at the head: the ceremony exists and is not aborted,
 * the organizer signed (signature path), and in restricted mode it is sponsored by this relayer.
 * Tracking is idempotent and costs reads only; the combine step is still sponsored under the
 * usual policy.
 */

import { Phase, TRACK_TYPES, trackDomain, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { recoverTypedDataAddress } from 'viem';
import type { ChainState } from './chainstate.js';
import { extractRevertData, RelayError, shortMessage } from './errors.js';
import type { SponsorPolicy } from './policy.js';

// The domain and typed struct live in the SDK (apps sign with `signTrackCeremony` and submit
// through `RelayerClient.track` / `RelayerPool.track`); re-exported here for the relayer's users.
export {
  TRACK_DOMAIN_NAME,
  TRACK_DOMAIN_VERSION,
  TRACK_TYPES,
  trackDomain,
} from '@vocdoni/davinci-dkg-council-sdk';

export interface TrackRequest {
  chainId: bigint;
  manager: Hex;
  ceremonyId: Hex;
  validUntil?: bigint;
  signature?: Hex;
}

const invalid = (detail: string): never => {
  throw new RelayError('INVALID_ACTION', detail);
};

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

function hexOf(v: unknown, bytes: number, label: string): Hex {
  if (typeof v !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)) invalid(`${label}: expected 0x-hex of ${bytes} bytes`);
  return (v as string).toLowerCase() as Hex;
}

function uintOf(v: unknown, bits: number, label: string): bigint {
  if (typeof v !== 'string' || !DECIMAL.test(v)) invalid(`${label}: expected a canonical decimal string`);
  const n = BigInt(v as string);
  if (n >= 1n << BigInt(bits)) invalid(`${label}: exceeds uint${bits}`);
  return n;
}

/** Shape validation only (the chain and the signature decide the rest). */
export function parseTrackRequest(body: unknown): TrackRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) invalid('body: expected a JSON object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!['chainId', 'manager', 'ceremonyId', 'validUntil', 'signature'].includes(k)) invalid(`${k}: unknown field`);
  }
  const out: TrackRequest = {
    chainId: uintOf(b.chainId, 64, 'chainId'),
    manager: hexOf(b.manager, 20, 'manager'),
    ceremonyId: hexOf(b.ceremonyId, 12, 'ceremonyId'),
  };
  if ((b.signature === undefined) !== (b.validUntil === undefined)) invalid('signature and validUntil go together');
  if (b.signature !== undefined) {
    out.signature = hexOf(b.signature, 65, 'signature');
    out.validUntil = uintOf(b.validUntil, 64, 'validUntil');
  }
  return out;
}

export interface TrackOptions {
  chainId: bigint;
  manager: Hex;
  chain: Pick<ChainState, 'ceremony'>;
  policy: Pick<SponsorPolicy, 'tokenValid' | 'ensureSponsored'>;
  /** The combine worker's `track`. */
  track: (cid: Hex) => void;
  now?: () => number;
}

/** Authenticate, validate on chain and track. Resolves to what the endpoint answers. */
export async function trackCeremony(
  opts: TrackOptions,
  body: unknown,
  token?: string,
): Promise<{ ceremonyId: Hex; tracked: true }> {
  const req = parseTrackRequest(body);
  if (req.chainId !== opts.chainId) throw new RelayError('WRONG_CHAIN', `this relayer serves chain ${opts.chainId}, not ${req.chainId}`);
  if (req.manager !== opts.manager.toLowerCase()) throw new RelayError('UNSUPPORTED_MANAGER', `this relayer serves manager ${opts.manager}`);
  const byToken = opts.policy.tokenValid(token);
  let signer: Hex | undefined;
  if (!byToken) {
    if (req.signature === undefined || req.validUntil === undefined) {
      throw new RelayError('UNAUTHORIZED', 'tracking a ceremony needs the organizer\'s signature or an API token');
    }
    const now = BigInt(Math.floor((opts.now ?? Date.now)() / 1000));
    if (req.validUntil < now) throw new RelayError('UNAUTHORIZED', 'the track request expired (validUntil)');
    try {
      signer = (
        await recoverTypedDataAddress({
          domain: trackDomain(opts.chainId, opts.manager),
          types: TRACK_TYPES,
          primaryType: 'TrackCeremony',
          message: { ceremonyId: req.ceremonyId, validUntil: req.validUntil },
          signature: req.signature,
        })
      ).toLowerCase() as Hex;
    } catch (err) {
      throw new RelayError('BAD_SIGNATURE', `track signature: ${shortMessage(err)}`);
    }
  }
  let view;
  try {
    view = await opts.chain.ceremony(req.ceremonyId);
  } catch (err) {
    if (extractRevertData(err) !== undefined) throw new RelayError('NOT_FOUND', `no ceremony ${req.ceremonyId} on this manager`);
    throw new RelayError('INTERNAL', `could not read ceremony ${req.ceremonyId}: ${shortMessage(err)}`);
  }
  if (view.phase === Phase.Aborted || view.phase === Phase.None) {
    throw new RelayError('INVALID_ACTION', `ceremony ${req.ceremonyId} is aborted: it has nothing to decrypt`);
  }
  if (signer !== undefined && signer !== view.organizer.toLowerCase()) {
    throw new RelayError('UNAUTHORIZED', 'the track request is not signed by the ceremony organizer');
  }
  await opts.policy.ensureSponsored(req.ceremonyId);
  opts.track(req.ceremonyId);
  return { ceremonyId: req.ceremonyId, tracked: true };
}
