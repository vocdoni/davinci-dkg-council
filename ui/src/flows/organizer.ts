/**
 * Organizer action builders. Every signed message comes straight from the
 * SDK (keys, EIP-712); this module only assembles parameters.
 */

import {
  accountFromSecret,
  buildInviteLink,
  ceremonyId,
  inviteCapabilityKey,
  organizerAuthKey,
  rootFromMnemonic,
  signAction,
  signTrackCeremony,
  validateCreateBounds,
  validateSchedule,
  type Action,
  type Hex,
  type TrackCeremonyRequest,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { AppConfig } from '../config';

/** Signed actions stay valid for one hour (the relayer enforces validUntil). */
export const actionValidUntil = (): bigint => BigInt(Math.floor(Date.now() / 1000) + 3600);

const domain = (config: AppConfig) => ({ chainId: BigInt(config.chainId), manager: config.manager });

/**
 * The organizer key for this deployment. `accountIndex` comes from the committee's record (a
 * kit restored with another index, protocol §5.2); new committees always use 0. Invite
 * capabilities do not depend on it.
 */
const organizerKey = (mnemonic: string, config: AppConfig, accountIndex = 0) =>
  organizerAuthKey(rootFromMnemonic(mnemonic), { ...domain(config), accountIndex });

export function organizerAddress(mnemonic: string, config: AppConfig, accountIndex = 0): Hex {
  return organizerKey(mnemonic, config, accountIndex).address;
}

export interface CreateCeremonyParams {
  threshold: number;
  /** Number of invites to create (the intended committee size). */
  memberCount: number;
  /** §8.1 PhaseMode: Manual (0) or Scheduled (1). */
  registrationMode: number;
  /** Unix seconds. Scheduled: the closing date. Manual: 0 or an optional expiry. */
  registrationDeadline: bigint;
  /** Seconds (>= 600 per protocol). */
  dealingDuration: bigint;
  /** §8.1 PhaseMode: Manual (0) or Scheduled (1). */
  decryptionMode: number;
  /** Unix seconds; Scheduled only (Manual must pass 0). */
  decryptionOpenAt: bigint;
  /** Unix seconds; Manual only — 0 for no fallback (Scheduled must pass 0). */
  manualDecryptionFallbackAt: bigint;
  /** Fixed nonce so the ceremony id can be shown before signing. */
  nonce?: bigint;
}

/** The deterministic ceremony id for a nonce chosen up front. */
export function ceremonyIdFor(mnemonic: string, config: AppConfig, nonce: bigint): Hex {
  const { chainId, manager } = domain(config);
  return ceremonyId(chainId, manager, organizerAddress(mnemonic, config), nonce);
}

export interface PreparedCreate {
  cid: Hex;
  nonce: bigint;
  organizerAddress: Hex;
  action: Action;
}

export async function prepareCreateCeremony(
  mnemonic: string,
  config: AppConfig,
  params: CreateCeremonyParams,
): Promise<PreparedCreate> {
  const root = rootFromMnemonic(mnemonic);
  const { chainId, manager } = domain(config);
  const org = organizerAuthKey(root, { chainId, manager });
  const nonce = params.nonce ?? BigInt(Date.now());
  const cid = ceremonyId(chainId, manager, org.address, nonce);
  const inviteKeys: Hex[] = [];
  for (let i = 0; i < params.memberCount; i++) {
    inviteKeys.push(inviteCapabilityKey(root, { chainId, manager, ceremonyId: cid, inviteId: i }).address);
  }
  // Mirror the contract's §8.1 creation rules before anything is signed.
  validateCreateBounds(params.threshold, inviteKeys);
  validateSchedule(
    {
      registrationMode: params.registrationMode,
      decryptionMode: params.decryptionMode,
      registrationDeadline: params.registrationDeadline,
      dealingDuration: params.dealingDuration,
      decryptionOpenAt: params.decryptionOpenAt,
      manualDecryptionFallbackAt: params.manualDecryptionFallbackAt,
    },
    BigInt(Math.floor(Date.now() / 1000)),
  );
  const message = {
    organizer: org.address,
    nonce,
    threshold: params.threshold,
    registrationMode: params.registrationMode,
    registrationDeadline: params.registrationDeadline,
    dealingDuration: params.dealingDuration,
    decryptionMode: params.decryptionMode,
    decryptionOpenAt: params.decryptionOpenAt,
    manualDecryptionFallbackAt: params.manualDecryptionFallbackAt,
    inviteKeys,
    validUntil: actionValidUntil(),
  };
  const signature = await signAction(accountFromSecret(org.secret), chainId, manager, 'CreateCeremony', message);
  return { cid, nonce, organizerAddress: org.address, action: { kind: 'createCeremony', message, signature } };
}

/** Rebuild the invite link for one invite id (deterministic from the root). */
export function organizerInviteLink(
  mnemonic: string,
  config: AppConfig,
  cid: Hex,
  inviteId: number,
  appBaseUrl: string,
): string {
  const root = rootFromMnemonic(mnemonic);
  const { chainId, manager } = domain(config);
  const cap = inviteCapabilityKey(root, { chainId, manager, ceremonyId: cid, inviteId });
  return buildInviteLink(appBaseUrl, { ceremonyId: cid, inviteId, secret: cap.secret });
}

export async function prepareAddInvites(
  mnemonic: string,
  config: AppConfig,
  cid: Hex,
  firstInviteId: number,
  count: number,
  accountIndex = 0,
): Promise<Action> {
  const root = rootFromMnemonic(mnemonic);
  const { chainId, manager } = domain(config);
  const org = organizerKey(mnemonic, config, accountIndex);
  const inviteKeys: Hex[] = [];
  for (let i = firstInviteId; i < firstInviteId + count; i++) {
    inviteKeys.push(inviteCapabilityKey(root, { chainId, manager, ceremonyId: cid, inviteId: i }).address);
  }
  const message = { ceremonyId: cid, firstInviteId, inviteKeys, validUntil: actionValidUntil() };
  const signature = await signAction(accountFromSecret(org.secret), chainId, manager, 'AddInvites', message);
  return { kind: 'addInvites', message, signature };
}

export async function prepareCloseRegistration(
  mnemonic: string,
  config: AppConfig,
  cid: Hex,
  participantCount: number,
  accountIndex = 0,
): Promise<Action> {
  const { chainId, manager } = domain(config);
  const org = organizerKey(mnemonic, config, accountIndex);
  const message = { ceremonyId: cid, participantCount, validUntil: actionValidUntil() };
  const signature = await signAction(accountFromSecret(org.secret), chainId, manager, 'CloseRegistration', message);
  return { kind: 'closeRegistration', message, signature };
}

export async function prepareAllowAdapter(
  mnemonic: string,
  config: AppConfig,
  cid: Hex,
  adapter: Hex,
  accountIndex = 0,
): Promise<Action> {
  const { chainId, manager } = domain(config);
  const org = organizerKey(mnemonic, config, accountIndex);
  const message = { ceremonyId: cid, adapter, validUntil: actionValidUntil() };
  const signature = await signAction(accountFromSecret(org.secret), chainId, manager, 'AllowAdapter', message);
  return { kind: 'allowAdapter', message, signature };
}

export async function prepareAuthorizeCreator(
  mnemonic: string,
  config: AppConfig,
  cid: Hex,
  creator: Hex,
  accountIndex = 0,
): Promise<Action> {
  const { chainId, manager } = domain(config);
  const org = organizerKey(mnemonic, config, accountIndex);
  const message = { ceremonyId: cid, creator, validUntil: actionValidUntil() };
  const signature = await signAction(accountFromSecret(org.secret), chainId, manager, 'AuthorizeCreator', message);
  return { kind: 'authorizeCreator', message, signature };
}

/**
 * §8.7: sign the irreversible "open the results" instruction. The signature is
 * a bearer instruction — build it only at the moment of opening, never ahead
 * of time, and keep it short-lived (10 minutes).
 */
export async function prepareOpenDecryption(
  mnemonic: string,
  config: AppConfig,
  cid: Hex,
  accountIndex = 0,
): Promise<Action> {
  const { chainId, manager } = domain(config);
  const org = organizerKey(mnemonic, config, accountIndex);
  const message = { ceremonyId: cid, validUntil: BigInt(Math.floor(Date.now() / 1000) + 600) };
  const signature = await signAction(accountFromSecret(org.secret), chainId, manager, 'OpenDecryption', message);
  return { kind: 'openDecryption', message, signature };
}

/**
 * Sign the relayer registration (`POST /v1/track`, architecture §5.1): the organizer asks the
 * deployment's relayers to serve this committee's decryption from contract state, independent of
 * their log discovery. Signed in the relayer's own EIP-712 domain, never the protocol's.
 */
export async function prepareTrackCeremony(
  mnemonic: string,
  config: AppConfig,
  cid: Hex,
  accountIndex = 0,
): Promise<TrackCeremonyRequest> {
  const { chainId, manager } = domain(config);
  const org = organizerKey(mnemonic, config, accountIndex);
  return signTrackCeremony(accountFromSecret(org.secret), chainId, manager, cid, actionValidUntil());
}

/** finalize/abort/scheduled close are permissionless; no signature. */
export const finalizeAction = (cid: Hex): Action => ({ kind: 'finalize', ceremonyId: cid });
export const abortAction = (cid: Hex): Action => ({ kind: 'abort', ceremonyId: cid });
export const scheduledCloseAction = (cid: Hex): Action => ({ kind: 'closeRegistrationScheduled', ceremonyId: cid });
