/**
 * Root, key derivation and per-ceremony keys (protocol §5.1, §5.2).
 *
 * Secret-handling module: everything here is pure computation over in-memory
 * values. No function in this file performs I/O or logging.
 */

import { expand, extract } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import {
  generateMnemonic as bip39Generate,
  mnemonicToSeedSync,
  validateMnemonic,
} from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english';
import { hexToBytes, keccak256, toBytes } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  DERIVATION_VERSION,
  PURPOSE_AUTH,
  PURPOSE_DEALER_COEFFICIENT,
  PURPOSE_DEALER_EPHEMERAL,
  PURPOSE_INVITE_CAPABILITY,
  PURPOSE_ORGANIZER_AUTH,
  PURPOSE_SHARE_ENCRYPTION,
  R,
  SECP256K1_N,
  SEED_SALT,
} from './constants.js';
import { G, mulPoint } from './curve.js';
import { abiEncode, bigIntToHex32, normalizeCeremonyId } from './encoding.js';
import type { Hex, Point } from './types.js';

/** The HKDF pseudorandom key derived from the 12-word root. Treat as secret. */
export interface CouncilRoot {
  /** PRK = HKDF-Extract(SHA-256, salt = "davinci-dkg-council/seed/v1", IKM = BIP-39 seed). */
  readonly prk: Uint8Array;
}

/** Generate a fresh 12-word mnemonic (128 bits from the platform CSPRNG). */
export function generateMnemonic(): string {
  return bip39Generate(english, 128);
}

/** Validate a mnemonic against the English wordlist (checksum included). */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, english);
}

/**
 * Derive the root PRK from a mnemonic. The BIP-39 passphrase is empty, fixed
 * in v1 (protocol §5.1).
 */
export function rootFromMnemonic(mnemonic: string): CouncilRoot {
  if (!isValidMnemonic(mnemonic)) throw new Error('invalid mnemonic');
  const seed = mnemonicToSeedSync(mnemonic, '');
  return { prk: extract(sha256, seed, toBytes(SEED_SALT)) };
}

function bytesToBigIntBE(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

/**
 * DeriveScalar (protocol §5.1): rejection-sampled HKDF-Expand with per-modulus
 * limit `floor(2^256 / q) · q`. Counter is uint32; exhaustion throws.
 */
export function deriveScalar(
  root: CouncilRoot,
  q: bigint,
  purpose: string,
  contextTypes: string,
  contextValues: unknown[],
  allowZero: boolean,
): bigint {
  const purposeHash = keccak256(toBytes(purpose));
  const contextHash = keccak256(abiEncode(contextTypes, contextValues));
  const limit = (2n ** 256n / q) * q;
  for (let counter = 0; counter <= 0xffffffff; counter++) {
    const info = abiEncode('bytes32, bytes32, uint32', [purposeHash, contextHash, counter]);
    const okm = expand(sha256, root.prk, hexToBytes(info), 32);
    const u = bytesToBigIntBE(okm);
    if (u >= limit) continue;
    const v = u % q;
    if (v === 0n && !allowZero) continue;
    return v;
  }
  throw new Error(`deriveScalar: counter exhausted for purpose ${purpose}`);
}

const PARTICIPANT_CTX_TYPES = 'uint256, address, bytes12, uint32, uint32';
const ORGANIZER_CTX_TYPES = 'uint256, address, uint32, uint32';
const INVITE_CTX_TYPES = 'uint256, address, bytes12, uint32, uint32';
const DEALER_CTX_TYPES =
  'uint256, address, bytes12, uint32, uint32, bytes32, uint8, uint8, bytes32';

export interface CeremonyContext {
  chainId: bigint;
  manager: Hex;
  ceremonyId: Hex;
  accountIndex?: number;
}

export interface SecpKey {
  /** Secret scalar in [1, secp256k1n). Never leaves the module's return value. */
  secret: bigint;
  /** Ethereum address of the key. */
  address: Hex;
}

function secpSecretToKey(secret: bigint): SecpKey {
  const account = privateKeyToAccount(bigIntToHex32(secret));
  return { secret, address: account.address };
}

/** A viem account for EIP-712 signing from a derived secp256k1 secret. */
export function accountFromSecret(secret: bigint): PrivateKeyAccount {
  return privateKeyToAccount(bigIntToHex32(secret));
}

/** Participant authorization key for one ceremony (purpose `auth-secp256k1`). */
export function participantAuthKey(root: CouncilRoot, ctx: CeremonyContext): SecpKey {
  const secret = deriveScalar(root, SECP256K1_N, PURPOSE_AUTH, PARTICIPANT_CTX_TYPES, [
    ctx.chainId,
    ctx.manager,
    normalizeCeremonyId(ctx.ceremonyId),
    ctx.accountIndex ?? 0,
    DERIVATION_VERSION,
  ], false);
  return secpSecretToKey(secret);
}

export interface ShareKey {
  /** x_i in F_r \ {0}. Decrypts shares; never signs, never sent anywhere. */
  secret: bigint;
  /** X_i = x_i·G in TE, the key registered at join. */
  publicKey: Point;
}

/** Participant share-encryption key for one ceremony (purpose `share-encryption-bjj`). */
export function shareEncryptionKey(root: CouncilRoot, ctx: CeremonyContext): ShareKey {
  const secret = deriveScalar(root, R, PURPOSE_SHARE_ENCRYPTION, PARTICIPANT_CTX_TYPES, [
    ctx.chainId,
    ctx.manager,
    normalizeCeremonyId(ctx.ceremonyId),
    ctx.accountIndex ?? 0,
    DERIVATION_VERSION,
  ], false);
  return { secret, publicKey: mulPoint(G, secret) };
}

/** Organizer authorization key (exists before any ceremony id; §5.2). */
export function organizerAuthKey(
  root: CouncilRoot,
  params: { chainId: bigint; manager: Hex; accountIndex?: number },
): SecpKey {
  const secret = deriveScalar(root, SECP256K1_N, PURPOSE_ORGANIZER_AUTH, ORGANIZER_CTX_TYPES, [
    params.chainId,
    params.manager,
    params.accountIndex ?? 0,
    DERIVATION_VERSION,
  ], false);
  return secpSecretToKey(secret);
}

/** Invite capability key, derived from the ORGANIZER's root (§5.2, §6). */
export function inviteCapabilityKey(
  root: CouncilRoot,
  params: { chainId: bigint; manager: Hex; ceremonyId: Hex; inviteId: number },
): SecpKey {
  const secret = deriveScalar(root, SECP256K1_N, PURPOSE_INVITE_CAPABILITY, INVITE_CTX_TYPES, [
    params.chainId,
    params.manager,
    normalizeCeremonyId(params.ceremonyId),
    params.inviteId,
    DERIVATION_VERSION,
  ], false);
  return secpSecretToKey(secret);
}

/** The frozen context that pins deterministic dealer derivations (§5.2). */
export interface DealerContext {
  chainId: bigint;
  manager: Hex;
  ceremonyId: Hex;
  accountIndex?: number;
  rosterHash: Hex;
  /** 1-based member index of the dealer. */
  dealerIndex: number;
  t: number;
  circuitReleaseId: Hex;
}

function dealerContextValues(ctx: DealerContext): unknown[] {
  return [
    ctx.chainId,
    ctx.manager,
    normalizeCeremonyId(ctx.ceremonyId),
    ctx.accountIndex ?? 0,
    DERIVATION_VERSION,
    ctx.rosterHash,
    ctx.dealerIndex,
    ctx.t,
    ctx.circuitReleaseId,
  ];
}

/** Deterministic dealing coefficient a_k (zero allowed; purpose `dealer-coefficient`). */
export function dealerCoefficient(root: CouncilRoot, ctx: DealerContext, k: number): bigint {
  if (k < 0 || k >= ctx.t) throw new Error('dealerCoefficient: k out of range');
  return deriveScalar(
    root,
    R,
    PURPOSE_DEALER_COEFFICIENT,
    `${DEALER_CTX_TYPES}, uint8`,
    [...dealerContextValues(ctx), k],
    true,
  );
}

/** All t coefficients a_0..a_{t-1}. */
export function dealerCoefficients(root: CouncilRoot, ctx: DealerContext): bigint[] {
  const out: bigint[] = [];
  for (let k = 0; k < ctx.t; k++) out.push(dealerCoefficient(root, ctx, k));
  return out;
}

/** Deterministic dealing ephemeral e != 0 (purpose `dealer-ephemeral`). */
export function dealerEphemeral(root: CouncilRoot, ctx: DealerContext): bigint {
  return deriveScalar(root, R, PURPOSE_DEALER_EPHEMERAL, DEALER_CTX_TYPES, dealerContextValues(ctx), false);
}
