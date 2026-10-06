/**
 * Recovery kit: build, serialize, parse, verify, rehearse (protocol §5.3).
 *
 * The kit is data, never executable. The checksum detects corruption only; it
 * is not authentication — restore flows must compare re-derived keys against
 * authenticated chain state (client module) before use.
 *
 * Secret-handling module: no I/O, no logging.
 */

import { keccak256 } from 'viem';
import { KIT_FORMAT } from './constants.js';
import { abiEncode, fromDecimal, toDecimal } from './encoding.js';
import { jcsCanonicalize, type JsonValue } from './jcs.js';
import {
  isValidMnemonic,
  organizerAuthKey,
  participantAuthKey,
  rootFromMnemonic,
  shareEncryptionKey,
  type CouncilRoot,
} from './keys.js';
import type { Hex, Point } from './types.js';

export type KitRole = 'participant' | 'organizer';

export interface KitManifestEntry {
  role: KitRole;
  /** Decimal-string chain id (canonical kit encoding). */
  chainId: string;
  manager: Hex;
  ceremonyId: Hex;
  accountIndex: number;
  authAddress: Hex;
  /** Required for participants: X_i in decimal strings. */
  sharePublicKey?: { x: string; y: string };
  /** Optional until assigned. */
  participantIndex?: number;
  rosterHash?: Hex;
  circuitReleaseId?: Hex;
  appUrl?: string;
}

export interface KitFile {
  format: typeof KIT_FORMAT;
  private: {
    mnemonic: string;
    wordlist: 'english';
    derivationVersion: 1;
  };
  manifest: KitManifestEntry[];
  checksum: Hex;
}

const isLowerHex = (v: unknown, bytes: number): v is Hex =>
  typeof v === 'string' && new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(v);

const isDecimal = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);

/** checksum = keccak256(abi.encode(string mnemonic, string jcsManifest)) (§5.3). */
export function kitChecksum(mnemonic: string, manifest: KitManifestEntry[]): Hex {
  const jcsManifest = jcsCanonicalize(manifest as unknown as JsonValue);
  return keccak256(abiEncode('string, string', [mnemonic, jcsManifest]));
}

function validateEntry(entry: KitManifestEntry, i: number): void {
  const at = `manifest[${i}]`;
  if (entry.role !== 'participant' && entry.role !== 'organizer') {
    throw new Error(`${at}: unknown role`);
  }
  if (!isDecimal(entry.chainId)) throw new Error(`${at}: chainId must be a decimal string`);
  if (!isLowerHex(entry.manager, 20)) throw new Error(`${at}: manager must be lowercase 0x-hex (20 bytes)`);
  if (!isLowerHex(entry.ceremonyId, 12)) throw new Error(`${at}: ceremonyId must be lowercase 0x-hex (12 bytes)`);
  if (!Number.isInteger(entry.accountIndex) || entry.accountIndex < 0) {
    throw new Error(`${at}: accountIndex must be a non-negative integer`);
  }
  if (!isLowerHex(entry.authAddress, 20)) throw new Error(`${at}: authAddress must be lowercase 0x-hex (20 bytes)`);
  if (entry.role === 'participant') {
    const pk = entry.sharePublicKey;
    if (!pk || !isDecimal(pk.x) || !isDecimal(pk.y)) {
      throw new Error(`${at}: participant entries require sharePublicKey with decimal coordinates`);
    }
    if (entry.participantIndex !== undefined) {
      if (!Number.isInteger(entry.participantIndex) || entry.participantIndex < 1 || entry.participantIndex > 16) {
        throw new Error(`${at}: participantIndex must be in 1..16`);
      }
    }
    if (entry.rosterHash !== undefined && !isLowerHex(entry.rosterHash, 32)) {
      throw new Error(`${at}: rosterHash must be lowercase 0x-hex (32 bytes)`);
    }
  } else {
    if (entry.sharePublicKey !== undefined || entry.participantIndex !== undefined || entry.rosterHash !== undefined) {
      throw new Error(`${at}: organizer entries carry no participant fields`);
    }
  }
  if (entry.circuitReleaseId !== undefined && !isLowerHex(entry.circuitReleaseId, 32)) {
    throw new Error(`${at}: circuitReleaseId must be lowercase 0x-hex (32 bytes)`);
  }
}

/** Build a kit from a mnemonic and manifest; validates everything and computes the checksum. */
export function buildKit(mnemonic: string, manifest: KitManifestEntry[]): KitFile {
  if (!isValidMnemonic(mnemonic)) throw new Error('buildKit: invalid mnemonic');
  if (mnemonic !== mnemonic.trim().split(/\s+/).join(' ')) {
    throw new Error('buildKit: mnemonic must use single spaces');
  }
  manifest.forEach(validateEntry);
  return {
    format: KIT_FORMAT,
    private: { mnemonic, wordlist: 'english', derivationVersion: 1 },
    manifest,
    checksum: kitChecksum(mnemonic, manifest),
  };
}

/** Serialize a kit to its JSON file content. */
export function serializeKit(kit: KitFile): string {
  return `${JSON.stringify(kit, null, 2)}\n`;
}

/**
 * Parse and validate a kit file. v1 readers accept only `wordlist: "english"`
 * and `derivationVersion: 1` and verify the checksum (§5.3).
 */
export function parseKit(json: string): KitFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('parseKit: not valid JSON');
  }
  const kit = raw as Partial<KitFile>;
  if (kit.format !== KIT_FORMAT) throw new Error(`parseKit: unsupported format ${String(kit.format)}`);
  const priv = kit.private;
  if (!priv || typeof priv.mnemonic !== 'string') throw new Error('parseKit: missing private.mnemonic');
  if (priv.wordlist !== 'english') throw new Error('parseKit: unsupported wordlist');
  if (priv.derivationVersion !== 1) throw new Error('parseKit: unsupported derivationVersion');
  if (!isValidMnemonic(priv.mnemonic)) throw new Error('parseKit: invalid mnemonic');
  if (!Array.isArray(kit.manifest)) throw new Error('parseKit: missing manifest');
  kit.manifest.forEach((e, i) => validateEntry(e as KitManifestEntry, i));
  if (!isLowerHex(kit.checksum, 32)) throw new Error('parseKit: missing checksum');
  const expected = kitChecksum(priv.mnemonic, kit.manifest as KitManifestEntry[]);
  if (kit.checksum !== expected) {
    throw new Error('parseKit: checksum mismatch — the kit file is corrupted');
  }
  return kit as KitFile;
}

/** Restore the root from a parsed kit. */
export function restoreFromKit(kit: KitFile): { root: CouncilRoot; manifest: KitManifestEntry[] } {
  return { root: rootFromMnemonic(kit.private.mnemonic), manifest: kit.manifest };
}

/** The public identity derived from a root for one manifest entry (no secrets). */
export interface KitEntryIdentity {
  role: KitRole;
  ceremonyId: Hex;
  authAddress: Hex;
  sharePublicKey?: Point;
}

/**
 * Derive the public identity for one manifest entry from the root (§5.3
 * restore step 1). Only the entry's *context* (chainId, manager, ceremonyId,
 * accountIndex) is used; the recorded addresses/keys are not trusted. Feed
 * the result to `CouncilClient.verifyRestoredIdentity`, which authenticates
 * it against chain registration state and returns the participant index and
 * roster hash as recorded on chain. Pure, no I/O.
 */
export function kitEntryIdentity(root: CouncilRoot, entry: KitManifestEntry): KitEntryIdentity {
  const chainId = fromDecimal(entry.chainId);
  if (entry.role === 'organizer') {
    const key = organizerAuthKey(root, { chainId, manager: entry.manager, accountIndex: entry.accountIndex });
    return { role: 'organizer', ceremonyId: entry.ceremonyId, authAddress: key.address };
  }
  const ctx = { chainId, manager: entry.manager, ceremonyId: entry.ceremonyId, accountIndex: entry.accountIndex };
  return {
    role: 'participant',
    ceremonyId: entry.ceremonyId,
    authAddress: participantAuthKey(root, ctx).address,
    sharePublicKey: shareEncryptionKey(root, ctx).publicKey,
  };
}

export interface RehearsalResult {
  ok: boolean;
  /** Human-readable mismatches, empty when ok. */
  mismatches: string[];
  derivedAuthAddress: Hex;
  derivedSharePublicKey?: Point;
}

/** The reference keys a rehearsal compares against (retained from the prepared join, not from the kit). */
export interface RehearsalExpected {
  authAddress: Hex;
  sharePublicKey?: Point;
}

/**
 * Rehearsal / restore check (protocol §5.3): re-derive the keys for one
 * manifest entry and compare them against `expected` — the keys retained
 * locally when the join was prepared. Without `expected` the comparison
 * falls back to the entry's own recorded values, which only detects kit
 * corruption (the manifest and checksum travel together, so a tampered kit
 * is self-consistent). Authentication is a separate, mandatory step:
 * `CouncilClient.verifyRestoredIdentity` against chain state.
 */
export function rehearseEntry(
  root: CouncilRoot,
  entry: KitManifestEntry,
  expected?: RehearsalExpected,
): RehearsalResult {
  const mismatches: string[] = [];
  const derived = kitEntryIdentity(root, entry);
  const source = expected ? 'expected' : 'kit';
  const refAuth = (expected?.authAddress ?? entry.authAddress).toLowerCase();
  if (derived.authAddress.toLowerCase() !== refAuth) {
    mismatches.push(`authAddress: derived ${derived.authAddress.toLowerCase()}, ${source} has ${refAuth}`);
  }
  if (entry.role === 'organizer') {
    return { ok: mismatches.length === 0, mismatches, derivedAuthAddress: derived.authAddress };
  }
  const derivedPk = derived.sharePublicKey as Point;
  if (expected) {
    const pk = expected.sharePublicKey;
    if (pk && (derivedPk.x !== pk.x || derivedPk.y !== pk.y)) {
      mismatches.push('sharePublicKey: derived X_i does not match the expected key');
    }
  } else {
    const pk = entry.sharePublicKey;
    if (pk && (toDecimal(derivedPk.x) !== pk.x || toDecimal(derivedPk.y) !== pk.y)) {
      mismatches.push('sharePublicKey: derived X_i does not match the kit');
    }
  }
  return {
    ok: mismatches.length === 0,
    mismatches,
    derivedAuthAddress: derived.authAddress,
    derivedSharePublicKey: derivedPk,
  };
}

/** The printable recovery sheet (kit artifact 1, §5.3): numbered words plus the warning. */
export function printableSheet(mnemonic: string, opts?: { title?: string }): string {
  if (!isValidMnemonic(mnemonic)) throw new Error('printableSheet: invalid mnemonic');
  const words = mnemonic.split(' ');
  const lines = words.map((w, i) => `${String(i + 1).padStart(2, ' ')}. ${w}`);
  return [
    opts?.title ?? 'Council recovery words',
    '',
    ...lines,
    '',
    'Anyone holding these words can act as you in every committee derived from them.',
    'Store this sheet somewhere safe and private. There is no way to reset it.',
  ].join('\n');
}
