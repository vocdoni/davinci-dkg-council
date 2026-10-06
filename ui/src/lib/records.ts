/**
 * Per-ceremony local records and organizer invite labels (architecture §6.4).
 *
 * `council.ceremonies.v1`: role, ids, participant index, the roster hash the
 * member explicitly approved on this device (protocol §8.3), live-mode flag
 * and kit-export bookkeeping. `council.labels.v1`: organizer-only local
 * names per invite; never transmitted anywhere.
 */

import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { idbGet, idbGetAll, idbPut, STORE_CEREMONIES, STORE_LABELS } from './db';

export type Role = 'organizer' | 'participant';

export interface CeremonyRecord {
  /** `${chainId}:${manager}:${cid}` */
  key: string;
  chainId: number;
  manager: Hex;
  cid: Hex;
  role: Role;
  /** Local display name; never leaves the device. */
  name?: string;
  /** Organizer: the nonce the ceremony id was derived from. */
  nonce?: string;
  /** Participant: the invite this member joined with. */
  inviteId?: number;
  /** Participant: 1-based index once joined. */
  participantIndex?: number;
  /**
   * The exact roster hash the member approved on this device (protocol
   * §8.3). Live mode may only auto-submit a contribution for this value.
   */
  approvedRosterHash?: Hex;
  /** "Keep this tab open" automation opt-in. */
  liveMode?: boolean;
  /** Fingerprint of the manifest last exported in a kit (nudges updates). */
  kitExportFingerprint?: string;
  /** Participant: one-time "save your kit once more" prompt after joining. */
  kitJoinNudge?: boolean;
  /** Set when the record's root was switched away from (restore-switch); hidden from the UI. */
  archived?: boolean;
  createdAt: number;
}

export const recordKey = (chainId: number, manager: Hex, cid: Hex): string =>
  `${chainId}:${manager.toLowerCase()}:${cid.toLowerCase()}`;

export async function getRecord(chainId: number, manager: Hex, cid: Hex): Promise<CeremonyRecord | undefined> {
  return idbGet<CeremonyRecord>(STORE_CEREMONIES, recordKey(chainId, manager, cid));
}

export async function putRecord(record: CeremonyRecord): Promise<void> {
  await idbPut(STORE_CEREMONIES, record.key, record);
}

export async function updateRecord(
  chainId: number,
  manager: Hex,
  cid: Hex,
  patch: Partial<CeremonyRecord>,
): Promise<CeremonyRecord | undefined> {
  const existing = await getRecord(chainId, manager, cid);
  if (!existing) return undefined;
  const next = { ...existing, ...patch };
  await putRecord(next);
  return next;
}

export async function listRecords(includeArchived = false): Promise<CeremonyRecord[]> {
  const all = await idbGetAll<CeremonyRecord>(STORE_CEREMONIES);
  return all.filter((r) => includeArchived || !r.archived).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Archive every active record (restore-switch): they belong to the root being
 * switched away from and must not be misread under the new one. A later
 * restore of the old kit rewrites them fresh.
 */
export async function archiveAllRecords(): Promise<void> {
  const all = await idbGetAll<CeremonyRecord>(STORE_CEREMONIES);
  for (const r of all) {
    if (!r.archived) await idbPut(STORE_CEREMONIES, r.key, { ...r, archived: true });
  }
}

// --- organizer labels (local only, never transmitted) ---

export type LabelMap = Record<number, string>;

export async function getLabels(chainId: number, manager: Hex, cid: Hex): Promise<LabelMap> {
  return (await idbGet<LabelMap>(STORE_LABELS, recordKey(chainId, manager, cid))) ?? {};
}

export async function setLabel(
  chainId: number,
  manager: Hex,
  cid: Hex,
  inviteId: number,
  label: string,
): Promise<LabelMap> {
  const labels = await getLabels(chainId, manager, cid);
  if (label.trim() === '') delete labels[inviteId];
  else labels[inviteId] = label.trim();
  await idbPut(STORE_LABELS, recordKey(chainId, manager, cid), labels);
  return labels;
}

// --- vote labels (local only, never transmitted; keyed by processId) ---

export type VoteLabelMap = Record<string, string>;

const voteLabelKey = (chainId: number, manager: Hex, cid: Hex) => `${recordKey(chainId, manager, cid)}:votes`;

export async function getVoteLabels(chainId: number, manager: Hex, cid: Hex): Promise<VoteLabelMap> {
  return (await idbGet<VoteLabelMap>(STORE_LABELS, voteLabelKey(chainId, manager, cid))) ?? {};
}

export async function setVoteLabel(
  chainId: number,
  manager: Hex,
  cid: Hex,
  processId: string,
  label: string,
): Promise<VoteLabelMap> {
  const labels = await getVoteLabels(chainId, manager, cid);
  const pid = processId.toLowerCase();
  if (label.trim() === '') delete labels[pid];
  else labels[pid] = label.trim();
  await idbPut(STORE_LABELS, voteLabelKey(chainId, manager, cid), labels);
  return labels;
}
