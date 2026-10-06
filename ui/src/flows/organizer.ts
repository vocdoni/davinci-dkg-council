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
  type Action,
  type Hex,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { AppConfig } from '../config';

/** Signed actions stay valid for one hour (the relayer enforces validUntil). */
export const actionValidUntil = (): bigint => BigInt(Math.floor(Date.now() / 1000) + 3600);

const domain = (config: AppConfig) => ({ chainId: BigInt(config.chainId), manager: config.manager });

export function organizerAddress(mnemonic: string, config: AppConfig): Hex {
  return organizerAuthKey(rootFromMnemonic(mnemonic), domain(config)).address;
}

export interface CreateCeremonyParams {
  threshold: number;
  /** Number of invites to create (the intended committee size). */
  memberCount: number;
  /** Unix seconds. */
  registrationDeadline: bigint;
  /** Seconds (>= 600 per protocol). */
  dealingDuration: bigint;
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
  const message = {
    organizer: org.address,
    nonce,
    threshold: params.threshold,
    registrationDeadline: params.registrationDeadline,
    dealingDuration: params.dealingDuration,
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
): Promise<Action> {
  const root = rootFromMnemonic(mnemonic);
  const { chainId, manager } = domain(config);
  const org = organizerAuthKey(root, { chainId, manager });
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
): Promise<Action> {
  const root = rootFromMnemonic(mnemonic);
  const { chainId, manager } = domain(config);
  const org = organizerAuthKey(root, { chainId, manager });
  const message = { ceremonyId: cid, participantCount, validUntil: actionValidUntil() };
  const signature = await signAction(accountFromSecret(org.secret), chainId, manager, 'CloseRegistration', message);
  return { kind: 'closeRegistration', message, signature };
}

export async function prepareAllowAdapter(
  mnemonic: string,
  config: AppConfig,
  cid: Hex,
  adapter: Hex,
): Promise<Action> {
  const root = rootFromMnemonic(mnemonic);
  const { chainId, manager } = domain(config);
  const org = organizerAuthKey(root, { chainId, manager });
  const message = { ceremonyId: cid, adapter, validUntil: actionValidUntil() };
  const signature = await signAction(accountFromSecret(org.secret), chainId, manager, 'AllowAdapter', message);
  return { kind: 'allowAdapter', message, signature };
}

export async function prepareAuthorizeCreator(
  mnemonic: string,
  config: AppConfig,
  cid: Hex,
  creator: Hex,
): Promise<Action> {
  const root = rootFromMnemonic(mnemonic);
  const { chainId, manager } = domain(config);
  const org = organizerAuthKey(root, { chainId, manager });
  const message = { ceremonyId: cid, creator, validUntil: actionValidUntil() };
  const signature = await signAction(accountFromSecret(org.secret), chainId, manager, 'AuthorizeCreator', message);
  return { kind: 'authorizeCreator', message, signature };
}

/** finalize/abort are permissionless; no signature. */
export const finalizeAction = (cid: Hex): Action => ({ kind: 'finalize', ceremonyId: cid });
export const abortAction = (cid: Hex): Action => ({ kind: 'abort', ceremonyId: cid });
