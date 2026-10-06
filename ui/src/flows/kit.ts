/**
 * Recovery-kit assembly for this device's ceremonies (protocol §5.3).
 *
 * The kit file holds the root in plaintext; the app forces a save and a
 * rehearsal before anything is signed, and offers an updated export whenever
 * the manifest grows (a new ceremony, an assigned index).
 */

import {
  buildKit,
  organizerAuthKey,
  participantAuthKey,
  rootFromMnemonic,
  shareEncryptionKey,
  toDecimal,
  type Hex,
  type KitFile,
  type KitManifestEntry,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { CeremonyRecord } from '../lib/records';

export interface KitEntryExtras {
  rosterHash?: Hex;
  circuitReleaseId?: Hex;
}

/** One manifest entry for a ceremony record, re-derived from the root. */
export function manifestEntryFor(
  mnemonic: string,
  record: CeremonyRecord,
  extras: KitEntryExtras = {},
): KitManifestEntry {
  const root = rootFromMnemonic(mnemonic);
  const chainId = BigInt(record.chainId);
  const manager = record.manager.toLowerCase() as Hex;
  const cid = record.cid.toLowerCase() as Hex;
  const appUrl = typeof location !== 'undefined' ? location.origin : undefined;
  if (record.role === 'organizer') {
    const key = organizerAuthKey(root, { chainId, manager });
    return {
      role: 'organizer',
      chainId: record.chainId.toString(10),
      manager,
      ceremonyId: cid,
      accountIndex: 0,
      authAddress: key.address.toLowerCase() as Hex,
      ...(extras.circuitReleaseId ? { circuitReleaseId: extras.circuitReleaseId } : {}),
      ...(appUrl ? { appUrl } : {}),
    };
  }
  const ctx = { chainId, manager, ceremonyId: cid };
  const auth = participantAuthKey(root, ctx);
  const share = shareEncryptionKey(root, ctx);
  return {
    role: 'participant',
    chainId: record.chainId.toString(10),
    manager,
    ceremonyId: cid,
    accountIndex: 0,
    authAddress: auth.address.toLowerCase() as Hex,
    sharePublicKey: { x: toDecimal(share.publicKey.x), y: toDecimal(share.publicKey.y) },
    ...(record.participantIndex ? { participantIndex: record.participantIndex } : {}),
    ...(extras.rosterHash ? { rosterHash: extras.rosterHash } : {}),
    ...(extras.circuitReleaseId ? { circuitReleaseId: extras.circuitReleaseId } : {}),
    ...(appUrl ? { appUrl } : {}),
  };
}

/** Build the kit file covering the given records. */
export function buildKitForRecords(
  mnemonic: string,
  records: CeremonyRecord[],
  extrasByKey: Record<string, KitEntryExtras> = {},
): KitFile {
  const manifest = records.map((r) => manifestEntryFor(mnemonic, r, extrasByKey[r.key] ?? {}));
  return buildKit(mnemonic, manifest);
}

/**
 * Stable fingerprint of a manifest's recovery-critical content: which
 * identities (role + deployment + ceremony + account) the kit can rebuild.
 * Everything else in an entry (participant index, roster hash) is re-derived
 * from the public record on restore, so changing it must never re-trigger the
 * "save a fresh copy" nudge (UX review P0-1).
 */
export function manifestFingerprint(manifest: KitManifestEntry[]): string {
  return JSON.stringify(
    manifest.map((e) => [e.role, e.chainId, e.manager, e.ceremonyId, e.accountIndex ?? 0].join('|')).sort(),
  );
}

export const kitFileName = (): string => `council-recovery-kit-${new Date().toISOString().slice(0, 10)}.json`;

/**
 * Does the entered mnemonic rebuild exactly the kit's root key? Full
 * re-derivation (checksum included), not a word-by-word string compare, so
 * every identity in the kit's manifest is implied to re-derive identically.
 */
export function mnemonicMatchesKit(entered: string, kit: KitFile): boolean {
  const normalize = (m: string) => m.trim().toLowerCase().split(/\s+/).join(' ');
  try {
    const a = rootFromMnemonic(normalize(entered)).prk;
    const b = rootFromMnemonic(normalize(kit.private.mnemonic)).prk;
    return a.length === b.length && a.every((v, i) => v === b[i]);
  } catch {
    return false;
  }
}
