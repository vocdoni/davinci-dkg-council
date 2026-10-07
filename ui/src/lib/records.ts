/**
 * Per-ceremony local records and organizer invite labels (architecture §6.4).
 *
 * `council.ceremonies.v1`: role, ids, participant index, the roster hash the
 * member explicitly approved on this device (protocol §8.3), live-mode flag
 * and kit-export bookkeeping. `council.labels.v1`: organizer-only local
 * names per invite; never transmitted anywhere.
 */

import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';
import type { PendingAction } from './pending';
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
  /**
   * The derivation account index of this role's keys (protocol §5.2), from the recovery kit it
   * was restored from; absent means 0, the only index this app creates. Every key this record
   * acts with — and every kit entry exported for it — is derived with it.
   */
  accountIndex?: number;
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
  /**
   * Organizer: a block at or before the committee's creation (the finalized block when this
   * device created it). Where label scans of its event logs start; else the deployment block.
   */
  fromBlock?: number;
  /** Participant: one-time "save your kit once more" prompt after joining. */
  kitJoinNudge?: boolean;
  /**
   * Organizer: every configured relayer confirmed `POST /v1/track` for this committee (its
   * decryption is served from state, without log discovery). Unset: the dashboard retries.
   */
  relayerTracked?: boolean;
  /** Set when the record's root was switched away from (restore-switch); hidden from the UI. */
  archived?: boolean;
  /**
   * Actions sent from this device that the finalized state does not show yet (lib/pending.ts).
   * Display only; never part of a kit.
   */
  pending?: PendingAction[];
  createdAt: number;
}

export const recordKey = (chainId: number, manager: Hex, cid: Hex): string =>
  `${chainId}:${manager.toLowerCase()}:${cid.toLowerCase()}`;

/**
 * Serialize read-modify-writes of one record: two concurrent patches (a user action adding a
 * pending entry, the dashboard poll flagging the relayer registration) must not lose each other.
 */
const writeLocks = new Map<string, Promise<unknown>>();
export function withRecordLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = writeLocks.get(key) ?? Promise.resolve();
  const run = tail.then(fn);
  writeLocks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

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
  return withRecordLock(recordKey(chainId, manager, cid), async () => {
    const existing = await getRecord(chainId, manager, cid);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    await putRecord(next);
    return next;
  });
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

// --- invite mapping (local only, never transmitted; labels only) ---

/** Which invitation member `index` joined with, as cross-checked against authenticated state once. */
export interface InviteLink {
  /** 1-based member index. */
  index: number;
  /** The member's authorization address at that index. */
  auth: Hex;
  inviteId: number;
}

const inviteMapKey = (chainId: number, manager: Hex, cid: Hex) => `${recordKey(chainId, manager, cid)}:invites`;

/**
 * The stored member → invitation links. Kept because the join events they come from are history a
 * provider may stop serving; whoever reads them still cross-checks every link (inviteLinkage).
 */
export async function getInviteMapping(chainId: number, manager: Hex, cid: Hex): Promise<InviteLink[]> {
  return (await idbGet<InviteLink[]>(STORE_LABELS, inviteMapKey(chainId, manager, cid))) ?? [];
}

export async function putInviteMapping(chainId: number, manager: Hex, cid: Hex, links: InviteLink[]): Promise<void> {
  const sorted = links.slice().sort((a, b) => a.index - b.index);
  await idbPut(STORE_LABELS, inviteMapKey(chainId, manager, cid), sorted);
}

/** Replace every invitation name at once (organizer record import). */
export async function putLabels(chainId: number, manager: Hex, cid: Hex, labels: LabelMap): Promise<void> {
  await idbPut(STORE_LABELS, recordKey(chainId, manager, cid), labels);
}

/** Replace every vote name at once (organizer record import). */
export async function putVoteLabels(chainId: number, manager: Hex, cid: Hex, labels: VoteLabelMap): Promise<void> {
  await idbPut(STORE_LABELS, voteLabelKey(chainId, manager, cid), labels);
}
