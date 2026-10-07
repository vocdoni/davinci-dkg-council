/**
 * EIP-712 domain, typed structs, digests, signing and payload hashes
 * (protocol §7). The struct field names, types and order are normative; the
 * tests assert the generated encodeType strings byte-for-byte.
 */

import { hashTypedData, keccak256, recoverAddress, type TypedDataDomain } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { EIP712_NAME, EIP712_VERSION, SECP256K1_N, TAG_DEAL_PAYLOAD, TAG_PARTIAL_PAYLOAD } from './constants.js';
import { abiEncode, tagHash } from './encoding.js';
import type {
  AddInvitesMessage,
  AllowAdapterMessage,
  AuthorizeCreatorMessage,
  CloseRegistrationMessage,
  CreateCeremonyMessage,
  DealMessage,
  DealPayload,
  Groth16Proof,
  Hex,
  InviteMessage,
  JoinMessage,
  OpenDecryptionMessage,
  PartialMessage,
  PartialPayload,
  Point,
} from './types.js';

/** All Council typed structs (protocol §7.2). Field order is normative. */
export const EIP712_TYPES = {
  CreateCeremony: [
    { name: 'organizer', type: 'address' },
    { name: 'nonce', type: 'uint64' },
    { name: 'threshold', type: 'uint8' },
    { name: 'registrationMode', type: 'uint8' },
    { name: 'registrationDeadline', type: 'uint64' },
    { name: 'dealingDuration', type: 'uint64' },
    { name: 'decryptionMode', type: 'uint8' },
    { name: 'decryptionOpenAt', type: 'uint64' },
    { name: 'manualDecryptionFallbackAt', type: 'uint64' },
    { name: 'inviteKeys', type: 'address[]' },
    { name: 'validUntil', type: 'uint64' },
  ],
  OpenDecryption: [
    { name: 'ceremonyId', type: 'bytes12' },
    { name: 'validUntil', type: 'uint64' },
  ],
  AddInvites: [
    { name: 'ceremonyId', type: 'bytes12' },
    { name: 'firstInviteId', type: 'uint32' },
    { name: 'inviteKeys', type: 'address[]' },
    { name: 'validUntil', type: 'uint64' },
  ],
  CloseRegistration: [
    { name: 'ceremonyId', type: 'bytes12' },
    { name: 'participantCount', type: 'uint8' },
    { name: 'validUntil', type: 'uint64' },
  ],
  AllowAdapter: [
    { name: 'ceremonyId', type: 'bytes12' },
    { name: 'adapter', type: 'address' },
    { name: 'validUntil', type: 'uint64' },
  ],
  AuthorizeCreator: [
    { name: 'ceremonyId', type: 'bytes12' },
    { name: 'creator', type: 'address' },
    { name: 'validUntil', type: 'uint64' },
  ],
  Invite: [
    { name: 'ceremonyId', type: 'bytes12' },
    { name: 'inviteId', type: 'uint32' },
    { name: 'participant', type: 'address' },
    { name: 'pkX', type: 'uint256' },
    { name: 'pkY', type: 'uint256' },
    { name: 'validUntil', type: 'uint64' },
  ],
  Join: [
    { name: 'ceremonyId', type: 'bytes12' },
    { name: 'participant', type: 'address' },
    { name: 'inviteId', type: 'uint32' },
    { name: 'pkX', type: 'uint256' },
    { name: 'pkY', type: 'uint256' },
    { name: 'popAx', type: 'uint256' },
    { name: 'popAy', type: 'uint256' },
    { name: 'popZ', type: 'uint256' },
    { name: 'validUntil', type: 'uint64' },
  ],
  Deal: [
    { name: 'ceremonyId', type: 'bytes12' },
    { name: 'dealerIndex', type: 'uint8' },
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'validUntil', type: 'uint64' },
  ],
  Partial: [
    { name: 'ceremonyId', type: 'bytes12' },
    { name: 'requestId', type: 'bytes32' },
    { name: 'participantIndex', type: 'uint8' },
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'validUntil', type: 'uint64' },
  ],
} as const;

export type ActionStructName = keyof typeof EIP712_TYPES;

/** The exact encodeType string for a struct, built from EIP712_TYPES. */
export function encodeTypeOf(name: ActionStructName): string {
  const fields = EIP712_TYPES[name].map((f) => `${f.type} ${f.name}`).join(',');
  return `${name}(${fields})`;
}

/** The EIP-712 domain for a deployment (protocol §7.1). */
export function councilDomain(chainId: bigint, manager: Hex): TypedDataDomain {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract: manager };
}

type MessageOf<N extends ActionStructName> = N extends 'CreateCeremony'
  ? CreateCeremonyMessage
  : N extends 'OpenDecryption'
    ? OpenDecryptionMessage
    : N extends 'AddInvites'
      ? AddInvitesMessage
      : N extends 'CloseRegistration'
        ? CloseRegistrationMessage
        : N extends 'AllowAdapter'
          ? AllowAdapterMessage
          : N extends 'AuthorizeCreator'
            ? AuthorizeCreatorMessage
            : N extends 'Invite'
              ? InviteMessage
              : N extends 'Join'
                ? JoinMessage
                : N extends 'Deal'
                  ? DealMessage
                  : PartialMessage;

/** The EIP-712 digest of an action struct. */
export function actionDigest<N extends ActionStructName>(
  chainId: bigint,
  manager: Hex,
  primaryType: N,
  message: MessageOf<N>,
): Hex {
  return hashTypedData({
    domain: { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract: manager },
    types: EIP712_TYPES,
    primaryType,
    message,
  } as never);
}

/**
 * Sign an action struct with a derived key (via `accountFromSecret`). The
 * returned signature is 65 bytes `r || s || v`, low-s, `v ∈ {27, 28}`.
 */
export async function signAction<N extends ActionStructName>(
  account: PrivateKeyAccount,
  chainId: bigint,
  manager: Hex,
  primaryType: N,
  message: MessageOf<N>,
): Promise<Hex> {
  const sig = await account.signTypedData({
    domain: { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract: manager },
    types: EIP712_TYPES,
    primaryType,
    message,
  } as never);
  assertCanonicalSignature(sig);
  return sig;
}

/**
 * Enforce the protocol's signature shape rules (§7.1): 65 bytes, v in {27,28},
 * 1 <= r < n, 1 <= s <= n/2 (low-s).
 */
export function assertCanonicalSignature(sig: Hex): void {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error('signature must be 65 bytes');
  const r = BigInt(`0x${sig.slice(2, 66)}`);
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130, 132), 16);
  if (v !== 27 && v !== 28) throw new Error('signature v must be 27 or 28');
  if (r < 1n || r >= SECP256K1_N) throw new Error('signature r out of range');
  if (s < 1n || s > SECP256K1_N / 2n) throw new Error('signature s must be low-s');
}

/** Recover the signer of an action; throws on a malformed signature. */
export async function recoverActionSigner<N extends ActionStructName>(
  chainId: bigint,
  manager: Hex,
  primaryType: N,
  message: MessageOf<N>,
  sig: Hex,
): Promise<Hex> {
  assertCanonicalSignature(sig);
  return recoverAddress({ hash: actionDigest(chainId, manager, primaryType, message), signature: sig });
}

// --- payload hashes (protocol §7.2) ---

const pointRows = (points: Point[], expected: number): [bigint, bigint][] => {
  if (points.length !== expected) throw new Error(`expected ${expected} points, got ${points.length}`);
  return points.map((p) => [p.x, p.y] as [bigint, bigint]);
};

const proofWords = (proof: Groth16Proof) => ({
  pA: proof.pA,
  pB: proof.pB,
  pC: proof.pC,
});

/** Deal.payloadHash over the padded dealing payload (protocol §7.2). */
export function dealPayloadHash(ctx: Hex, payload: DealPayload): Hex {
  if (payload.masked.length !== 16) throw new Error('masked must have 16 entries');
  const { pA, pB, pC } = proofWords(payload.proof);
  return keccak256(
    abiEncode(
      'bytes32, bytes32, uint256[2][16], uint256[2], uint256[16], uint256[2], uint256[2][2], uint256[2]',
      [
        tagHash(TAG_DEAL_PAYLOAD),
        ctx,
        pointRows(payload.C, 16),
        [payload.E.x, payload.E.y],
        payload.masked,
        pA,
        pB,
        pC,
      ],
    ),
  );
}

/** Partial.payloadHash over the padded partial payload (protocol §7.2). */
export function partialPayloadHash(requestId: Hex, payload: PartialPayload): Hex {
  const { pA, pB, pC } = proofWords(payload.proof);
  return keccak256(
    abiEncode('bytes32, bytes32, uint256[2][16], uint256[2], uint256[2][2], uint256[2]', [
      tagHash(TAG_PARTIAL_PAYLOAD),
      requestId,
      pointRows(payload.D, 16),
      pA,
      pB,
      pC,
    ]),
  );
}
