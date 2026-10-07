/**
 * The organizer record (ops review P1.2): everything about a committee that lives only on the
 * organizer's device — the names typed for each invitation, which invitation each member joined
 * with, the vote names, the committee's own name — plus the public facts needed to find it again
 * months later (deployment, link, dates, circuit release). One JSON file the organizer keeps with
 * the recovery kit, or loads on another device.
 *
 * It never holds a key or an invitation link (those carry secrets); it does hold the names the
 * organizer typed, so it is private. Loading it only restores local display data: identity codes
 * and every check still come from the authenticated public record.
 */

import {
  PhaseMode,
  type CeremonyView,
  type CircuitReleaseStatus,
  type Hex,
  type PhasePolicyView,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { AppConfig } from '../config';
import {
  getInviteMapping,
  getLabels,
  getVoteLabels,
  putInviteMapping,
  putLabels,
  putVoteLabels,
  updateRecord,
  type CeremonyRecord,
  type InviteLink,
  type LabelMap,
  type VoteLabelMap,
} from './records';

export const ORGANIZER_RECORD_FORMAT = 'davinci-dkg-council-organizer-record/v1';

const iso = (unix: bigint): string | null => (unix === 0n ? null : new Date(Number(unix) * 1000).toISOString());

export interface OrganizerRecordFile {
  format: typeof ORGANIZER_RECORD_FORMAT;
  exportedAt: string;
  deployment: {
    chainId: string;
    manager: Hex;
    appUrl: string;
    deploymentBlock: number;
    /** A block at or before the committee's creation, when this device knows one. */
    fromBlock?: number;
    relayerUrls: string[];
    artifactsBaseUrls: string[];
    circuitRelease?: { id: Hex; tag?: string; developmentSetup?: boolean };
  };
  committee: {
    ceremonyId: Hex;
    link: string;
    name?: string;
    threshold?: number;
    members?: number;
    invitations?: number;
    /** ISO dates of the phase policy (null when not set). */
    policy?: {
      registrationDeadline: string | null;
      decryptionMode: 'manual' | 'scheduled';
      decryptionOpenAt: string | null;
      manualDecryptionFallbackAt: string | null;
    };
  };
  /** Invitation id (decimal) → the name typed for that person. */
  inviteLabels: Record<string, string>;
  /** Member index → invitation, as cross-checked when it was recorded. */
  inviteMapping: InviteLink[];
  /** DAVINCI process id (lowercase) → the vote's name. */
  voteLabels: Record<string, string>;
}

/** Collect this device's organizer record for one committee. */
export async function exportOrganizerRecord(
  record: CeremonyRecord,
  config: AppConfig,
  context: { view?: CeremonyView; policy?: PhasePolicyView; release?: CircuitReleaseStatus; appUrl: string },
): Promise<OrganizerRecordFile> {
  const [labels, mapping, votes] = await Promise.all([
    getLabels(record.chainId, record.manager, record.cid),
    getInviteMapping(record.chainId, record.manager, record.cid),
    getVoteLabels(record.chainId, record.manager, record.cid),
  ]);
  const { view, policy, release } = context;
  return {
    format: ORGANIZER_RECORD_FORMAT,
    exportedAt: new Date().toISOString(),
    deployment: {
      chainId: String(record.chainId),
      manager: record.manager.toLowerCase() as Hex,
      appUrl: context.appUrl,
      deploymentBlock: config.deploymentBlock,
      ...(record.fromBlock !== undefined ? { fromBlock: record.fromBlock } : {}),
      relayerUrls: config.relayerUrls,
      artifactsBaseUrls: config.artifactsBaseUrls,
      ...(release
        ? { circuitRelease: { id: release.id, tag: release.tag, developmentSetup: release.developmentSetup } }
        : {}),
    },
    committee: {
      ceremonyId: record.cid.toLowerCase() as Hex,
      link: `${context.appUrl}/c/${record.cid.toLowerCase()}`,
      ...(record.name ? { name: record.name } : {}),
      ...(view ? { threshold: view.threshold, members: view.n || view.joinedCount, invitations: view.inviteCount } : {}),
      ...(view && policy
        ? {
            policy: {
              registrationDeadline: iso(view.registrationDeadline),
              decryptionMode: policy.decryptionMode === (PhaseMode.Scheduled as number) ? 'scheduled' : 'manual',
              decryptionOpenAt: iso(policy.decryptionOpenAt),
              manualDecryptionFallbackAt: iso(policy.manualDecryptionFallbackAt),
            },
          }
        : {}),
    },
    inviteLabels: Object.fromEntries(Object.entries(labels).map(([k, v]) => [String(k), v])),
    inviteMapping: mapping,
    voteLabels: votes,
  };
}

export class OrganizerRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrganizerRecordError';
  }
}

const isHex = (v: unknown, bytes: number): v is Hex =>
  typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v);

/** Parse and check a saved organizer record (shape only; it carries no authority). */
export function parseOrganizerRecord(text: string): OrganizerRecordFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OrganizerRecordError('this file is not an organizer record (not readable)');
  }
  const o = raw as Partial<OrganizerRecordFile>;
  if (!o || o.format !== ORGANIZER_RECORD_FORMAT) {
    throw new OrganizerRecordError('this file is not an organizer record (maybe it is a recovery kit — use “Restore” for that)');
  }
  const d = o.deployment;
  const c = o.committee;
  if (!d || typeof d.chainId !== 'string' || !isHex(d.manager, 20) || !c || !isHex(c.ceremonyId, 12)) {
    throw new OrganizerRecordError('this organizer record is incomplete');
  }
  // Everything that is written to this device must have the type the screens render.
  if (c.name !== undefined && typeof c.name !== 'string') {
    throw new OrganizerRecordError('this organizer record is damaged');
  }
  const strings = (m: unknown): m is Record<string, string> =>
    typeof m === 'object' && m !== null && !Array.isArray(m) && Object.values(m).every((v) => typeof v === 'string');
  if (!strings(o.inviteLabels) || !strings(o.voteLabels) || !Array.isArray(o.inviteMapping)) {
    throw new OrganizerRecordError('this organizer record is damaged');
  }
  for (const k of Object.keys(o.inviteLabels)) {
    if (!/^(0|[1-9][0-9]?)$/.test(k)) throw new OrganizerRecordError('this organizer record is damaged');
  }
  for (const m of o.inviteMapping) {
    const ok =
      typeof m === 'object' &&
      m !== null &&
      Number.isInteger(m.index) &&
      m.index >= 1 &&
      m.index <= 16 &&
      Number.isInteger(m.inviteId) &&
      m.inviteId >= 0 &&
      isHex(m.auth, 20);
    if (!ok) throw new OrganizerRecordError('this organizer record is damaged');
  }
  return o as OrganizerRecordFile;
}

/**
 * Load a saved record into `record`'s committee on this device: refuses a file of another
 * committee; names and links in the file replace those already here, anything the file lacks
 * stays, and the committee's own name is filled in only when this device has none.
 */
export async function importOrganizerRecord(
  file: OrganizerRecordFile,
  record: CeremonyRecord,
): Promise<{ names: number; votes: number; links: number }> {
  const same =
    file.deployment.chainId === String(record.chainId) &&
    file.deployment.manager.toLowerCase() === record.manager.toLowerCase() &&
    file.committee.ceremonyId.toLowerCase() === record.cid.toLowerCase();
  if (!same) throw new OrganizerRecordError('this organizer record belongs to another committee — nothing was changed');
  const { chainId, manager, cid } = record;
  const labels: LabelMap = { ...(await getLabels(chainId, manager, cid)) };
  for (const [k, v] of Object.entries(file.inviteLabels)) if (v.trim() !== '') labels[Number(k)] = v.trim();
  const votes: VoteLabelMap = { ...(await getVoteLabels(chainId, manager, cid)) };
  for (const [k, v] of Object.entries(file.voteLabels)) if (v.trim() !== '') votes[k.toLowerCase()] = v.trim();
  const byIndex = new Map((await getInviteMapping(chainId, manager, cid)).map((m) => [m.index, m]));
  for (const m of file.inviteMapping) byIndex.set(m.index, { index: m.index, auth: m.auth, inviteId: m.inviteId });
  await putLabels(chainId, manager, cid, labels);
  await putVoteLabels(chainId, manager, cid, votes);
  await putInviteMapping(chainId, manager, cid, [...byIndex.values()]);
  if (file.committee.name && !record.name) await updateRecord(chainId, manager, cid, { name: file.committee.name });
  return {
    names: Object.keys(file.inviteLabels).length,
    votes: Object.keys(file.voteLabels).length,
    links: file.inviteMapping.length,
  };
}

export const organizerRecordFileName = (cid: Hex): string =>
  `council-organizer-record-${cid.slice(2, 10)}-${new Date().toISOString().slice(0, 10)}.json`;
