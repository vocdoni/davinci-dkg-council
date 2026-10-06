/**
 * Invite capabilities and links (protocol §6).
 *
 * The invite link carries the capability secret in the URL fragment; an
 * unredeemed link is a bearer credential. Link construction/parsing here is
 * pure string work — fragment stripping from the address bar is the app's job.
 */

import { SECP256K1_N } from './constants.js';
import { normalizeCeremonyId } from './encoding.js';
import { accountFromSecret, inviteCapabilityKey, type CouncilRoot, type SecpKey } from './keys.js';
import { signAction } from './eip712.js';
import type { Hex, InviteMessage } from './types.js';

/** Derive the capability key for one invite from the organizer's root (§5.2). */
export function deriveInviteCapability(
  organizerRoot: CouncilRoot,
  params: { chainId: bigint; manager: Hex; ceremonyId: Hex; inviteId: number },
): SecpKey {
  return inviteCapabilityKey(organizerRoot, params);
}

export interface InviteLinkParts {
  ceremonyId: Hex;
  inviteId: number;
  /** The capability secret scalar. */
  secret: bigint;
}

/**
 * Build the invite link:
 * `https://<app>/c/0x<ceremonyId 24 hex>#v1.<inviteId decimal>.<capability secret, 64 lowercase hex>`.
 */
export function buildInviteLink(appBaseUrl: string, parts: InviteLinkParts): string {
  const base = appBaseUrl.replace(/\/+$/, '');
  const cid = normalizeCeremonyId(parts.ceremonyId);
  if (!Number.isInteger(parts.inviteId) || parts.inviteId < 0) throw new Error('invalid inviteId');
  if (parts.secret <= 0n || parts.secret >= SECP256K1_N) throw new Error('invalid capability secret');
  const secretHex = parts.secret.toString(16).padStart(64, '0');
  return `${base}/c/${cid}#v1.${parts.inviteId}.${secretHex}`;
}

/** Parse the `v1.<id>.<64 hex>` invite fragment (without the leading '#'). */
export function parseInviteFragment(fragment: string): { inviteId: number; secret: bigint } {
  const m = /^v1\.(0|[1-9][0-9]*)\.([0-9a-f]{64})$/.exec(fragment.replace(/^#/, ''));
  if (!m) throw new Error('not a v1 invite fragment');
  const inviteId = Number(m[1]);
  const secret = BigInt(`0x${m[2]}`);
  if (secret <= 0n || secret >= SECP256K1_N) throw new Error('capability secret out of range');
  return { inviteId, secret };
}

/** Parse a full invite link (path `/c/0x<24 hex>` + fragment). */
export function parseInviteLink(url: string): InviteLinkParts {
  const u = new URL(url);
  const m = /\/c\/(0x[0-9a-fA-F]{24})$/.exec(u.pathname);
  if (!m) throw new Error('not a ceremony link');
  const { inviteId, secret } = parseInviteFragment(u.hash);
  return { ceremonyId: normalizeCeremonyId(m[1] as string), inviteId, secret };
}

/**
 * Sign the EIP-712 Invite struct with the capability key, binding the
 * capability to the invitee's authorization address and X_i (§6, §7.2).
 */
export async function signInvite(
  capabilitySecret: bigint,
  chainId: bigint,
  manager: Hex,
  message: InviteMessage,
): Promise<Hex> {
  return signAction(accountFromSecret(capabilitySecret), chainId, manager, 'Invite', message);
}
