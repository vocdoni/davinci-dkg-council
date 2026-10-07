/**
 * Just-sent actions this device is waiting on.
 *
 * Every screen reads authenticated state at the finalized block (protocol §9.3), which trails the
 * head by about 15–20 minutes on Sepolia. An action the relayer already mined is invisible for
 * that long: a committee this device just created reads as unknown (the views revert
 * `UnknownCeremony()`), a list it just locked still reads as open. Each sent action is kept on its
 * ceremony record as a pending entry until the finalized state shows its effect, so the screens
 * show "waiting for the network to confirm" and keep its button off instead of an error or a
 * second, doomed attempt. The relayer's verdict on the transaction is checked too: a rejected one
 * is dropped and reported.
 *
 * Display only. Every check before anything is signed or proven still runs on authenticated
 * state, and nothing here is ever read as proof that an action happened.
 */

import { Phase, type Action, type CeremonyView, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { isAdapterAllowed, isCreatorAuthorized, participantIndexOf, republishCheck, type ChainReader } from './chain';
import { getRecord, putRecord, recordKey, withRecordLock, type CeremonyRecord } from './records';
import { submitRevertName, TxRejectedError } from './relayerErrors';
import type { Services } from '../services';

export type PendingKind =
  | 'create'
  | 'addInvites'
  | 'join'
  | 'close'
  | 'deal'
  | 'finish'
  | 'grant'
  | 'partial'
  | 'open'
  | 'republish';

export interface PendingAction {
  kind: PendingKind;
  /** The relayer's transaction; absent when the change was already at the head when we sent ours. */
  txHash?: Hex;
  /** Date.now() when it was sent. */
  sentAt: number;
  /** addInvites: the invitation count once the new ones are in. */
  inviteCount?: number;
  /** deal, partial, republish: this member's index. */
  memberIndex?: number;
  /** partial, republish */
  requestId?: Hex;
  /** republish: the request's field count (for the §10.4 hash check). */
  fieldCount?: number;
  /** republish: the commitment's publication block before re-sending (decimal). */
  publishedBlock?: string;
  /** grant */
  grant?: 'adapter' | 'creator';
  /** grant: the adapter or creator; join: this member's authorization address. */
  address?: Hex;
  /** finish: abort instead of finalize. */
  abort?: boolean;
}

export type PendingDraft = Omit<PendingAction, 'txHash' | 'sentAt'>;

/** A pending action the relayer reported as rejected. */
export interface FailedAction {
  action: PendingAction;
  reason?: string;
}

/**
 * After this long a pending entry is dropped even if the finalized state never showed it (a
 * reorg, a lost relayer): the screens then show the chain as it is, buttons included.
 */
export const PENDING_MAX_AGE_MS = 2 * 60 * 60_000;

/**
 * Refusals at the head that mean the step is already done, so the change only waits for
 * finality: the committee id is derived from this organizer's key and nonce, the join, dealing,
 * partial and grant are this device's own, and a phase that already moved on at the head
 * (locked, finished, called off) only has to reach the finalized view the screen shows.
 */
const ALREADY_AT_HEAD: Partial<Record<PendingKind, string[]>> = {
  create: ['CeremonyExists'],
  join: ['DuplicateParticipant'],
  close: ['WrongPhase'],
  deal: ['AlreadyDealt'],
  finish: ['WrongPhase'],
  grant: ['AlreadyListed'],
  partial: ['AlreadyPartial'],
  open: ['AlreadyOpen'],
};

/** One pending entry per step: a newer one for the same step replaces the older. */
export function pendingKey(p: PendingDraft): string {
  switch (p.kind) {
    case 'grant':
      return `grant:${p.grant}:${(p.address ?? '').toLowerCase()}`;
    case 'partial':
      return `partial:${(p.requestId ?? '').toLowerCase()}`;
    case 'republish':
      return `republish:${(p.requestId ?? '').toLowerCase()}`;
    default:
      return p.kind;
  }
}

export const findPending = (record: CeremonyRecord, draft: PendingDraft): PendingAction | undefined =>
  (record.pending ?? []).find((p) => pendingKey(p) === pendingKey(draft));

async function updatePending(
  record: CeremonyRecord,
  change: (list: PendingAction[]) => PendingAction[],
): Promise<void> {
  await withRecordLock(recordKey(record.chainId, record.manager, record.cid), async () => {
    const current = await getRecord(record.chainId, record.manager, record.cid);
    if (!current) return;
    const next = change(current.pending ?? []);
    await putRecord({ ...current, pending: next.length > 0 ? next : undefined });
  });
}

export const addPending = (record: CeremonyRecord, p: PendingAction): Promise<void> =>
  updatePending(record, (list) => [...list.filter((q) => pendingKey(q) !== pendingKey(p)), p]);

export const removePending = (record: CeremonyRecord, draft: PendingDraft): Promise<void> =>
  updatePending(record, (list) => list.filter((q) => pendingKey(q) !== pendingKey(draft)));

const bit = (bitmap: number | bigint, index: number): boolean => ((BigInt(bitmap) >> BigInt(index)) & 1n) === 1n;

/**
 * Does the finalized state show `p`'s effect? `view` is the committee at the finalized block, or
 * null while it is unknown there. Grants and partials need one more authenticated read.
 */
export async function pendingSettled(
  p: PendingAction,
  client: ChainReader,
  cid: Hex,
  view: CeremonyView | null,
): Promise<boolean> {
  if (view === null) return false;
  switch (p.kind) {
    case 'create':
      return true;
    case 'addInvites':
      return view.inviteCount >= (p.inviteCount ?? 0) || view.phase !== (Phase.Registration as number);
    case 'join':
      if (view.phase !== (Phase.Registration as number)) return true;
      return p.address !== undefined && (await participantIndexOf(client, cid, p.address)) > 0;
    case 'close':
      return view.phase !== (Phase.Registration as number);
    case 'deal':
      if (view.phase !== (Phase.Dealing as number)) return true;
      return p.memberIndex !== undefined && bit(view.qualBitmap, p.memberIndex - 1);
    case 'finish':
      return view.phase === (Phase.Live as number) || view.phase === (Phase.Aborted as number);
    case 'grant': {
      if (view.phase !== (Phase.Live as number) || !p.address) return false;
      return p.grant === 'creator'
        ? isCreatorAuthorized(client, cid, p.address)
        : isAdapterAllowed(client, cid, p.address);
    }
    case 'partial': {
      if (!p.requestId || p.memberIndex === undefined) return false;
      const meta = await client.getRequestMeta(p.requestId);
      if (bit(meta.partialBitmap, p.memberIndex - 1)) return true;
      return (await client.getPlaintexts(p.requestId)).ready;
    }
    case 'open': {
      // Settled once the finalized state shows the gate opened (§8.7).
      const policy = await client.getPolicy(cid);
      return policy.manualOpenedAt !== 0n || policy.decryptionOpen;
    }
    case 'republish': {
      if (!p.requestId || p.memberIndex === undefined || p.fieldCount === undefined) return false;
      if ((await client.getPlaintexts(p.requestId)).ready) return true;
      // Settled once the vector is retrievable and matching again — or, when this device cannot
      // read history at all, once the authenticated commitment shows the new publication block.
      const check = await republishCheck(client, cid, p.requestId, p.fieldCount, p.memberIndex);
      if (check.state === 'not-needed') return true;
      return p.publishedBlock !== undefined && check.publishedBlock > BigInt(p.publishedBlock);
    }
  }
}

/** Hashes the relayer already reported mined: no need to ask again. */
const minedHashes = new Set<string>();

/**
 * Settle `record`'s pending actions against the finalized state: drop those it shows (or that are
 * too old) and those the relayer rejected, which are returned. `changed` says whether the record
 * was rewritten (the caller refreshes its copy).
 */
export async function settlePending(
  services: Pick<Services, 'client' | 'txStatus'>,
  record: CeremonyRecord,
  view: CeremonyView | null,
  now = Date.now(),
): Promise<{ changed: boolean; failed: FailedAction[] }> {
  const pending = record.pending ?? [];
  if (pending.length === 0) return { changed: false, failed: [] };
  const drop = new Set<string>();
  const failed: FailedAction[] = [];
  for (const p of pending) {
    if (now - p.sentAt > PENDING_MAX_AGE_MS) {
      drop.add(pendingKey(p));
      continue;
    }
    if (await pendingSettled(p, services.client, record.cid, view).catch(() => false)) {
      drop.add(pendingKey(p));
      continue;
    }
    if (p.txHash && !minedHashes.has(p.txHash.toLowerCase())) {
      const st = await services.txStatus(p.txHash);
      if (st.status === 'confirmed') minedHashes.add(p.txHash.toLowerCase());
      if (st.status === 'failed') {
        drop.add(pendingKey(p));
        failed.push({ action: p, reason: st.reason });
      }
    }
  }
  if (drop.size === 0) return { changed: false, failed };
  // Only the entries examined here: one added meanwhile (same key, newer) stays.
  const examined = (q: PendingAction) => pending.some((p) => p.sentAt === q.sentAt && pendingKey(p) === pendingKey(q));
  await updatePending(record, (list) => list.filter((q) => !(drop.has(pendingKey(q)) && examined(q))));
  return { changed: true, failed };
}

/**
 * Send one action and track it until the finalized state shows it. Resolves once it is pending
 * (mined at the head, or already there); throws the plain error of a refused or rejected action,
 * which is then not pending. A slow confirmation stays pending rather than failing: the tracker
 * keeps asking the relayer.
 */
export async function sendTracked(
  services: Pick<Services, 'submit' | 'waitTx'>,
  record: CeremonyRecord,
  action: Action,
  draft: PendingDraft,
  refresh: () => Promise<void>,
): Promise<void> {
  let txHash: Hex | undefined;
  try {
    txHash = await services.submit(action);
  } catch (err) {
    if (!alreadyAtHead(draft.kind, err)) throw err;
  }
  await addPending(record, { ...draft, txHash, sentAt: Date.now() });
  await refresh();
  if (txHash === undefined) return;
  try {
    await services.waitTx(txHash);
  } catch (err) {
    if (!(err instanceof TxRejectedError)) return;
    await removePending(record, draft);
    await refresh();
    throw err;
  }
}

/** True when a refused submission of `kind` means this device's own action is already at the head. */
export function alreadyAtHead(kind: PendingKind, err: unknown): boolean {
  const name = submitRevertName(err);
  return name !== undefined && (ALREADY_AT_HEAD[kind] ?? []).includes(name);
}

const WHAT: Record<PendingKind, string> = {
  create: 'creating the committee',
  addInvites: 'adding the invitations',
  join: 'joining the member list',
  close: 'locking the member list',
  deal: 'your contribution',
  finish: 'finishing the key',
  grant: 'the approval',
  partial: 'turning your key',
  open: 'opening the results',
  republish: 'republishing your unlock data',
};

/** Plain-language report of a rejected action (screens prefix nothing). */
export function failedText(f: FailedAction): string {
  const what = f.action.kind === 'finish' && f.action.abort ? 'calling the committee off' : WHAT[f.action.kind];
  const why = f.reason ? ` (${f.reason})` : '';
  return `The network did not accept ${what}${why}. Nothing changed — you can try again.`;
}
