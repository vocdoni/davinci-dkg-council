/**
 * Organizer dashboard (architecture §6.3): status, people (invited → joined →
 * contributed, with local-only name labels and shareable invite links), key
 * progress, access control and results.
 */

import {
  MAX_N,
  Phase,
  PhaseMode,
  type Action,
  type CeremonyView,
  type Hex,
  type PhasePolicyView,
} from '@vocdoni/davinci-dkg-council-sdk';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../App';
import { DavinciConnectCard } from '../components/DavinciConnectCard';
import { KitCard } from '../components/KitCard';
import { QrCode } from '../components/QrCode';
import { Dashboard, Page } from '../components/Layout';
import { CommitteeHeader, LifecycleSteps } from '../components/Lifecycle';
import { organizerSteps } from '../lib/lifecycle';
import {
  BallotIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  DownloadIcon,
  FileIcon,
  KeyIcon,
  LinkIcon,
  LockIcon,
  MailIcon,
  PlusIcon,
  SettingsIcon,
  ShareIcon,
  UnlockIcon,
  UploadIcon,
  UsersIcon,
} from '../components/icons';
import { EmptyState, ResultValues, VoteBadge } from '../components/Votes';
import { buttonClass } from '../components/buttonClass';
import {
  Actions,
  Badge,
  Button,
  Card,
  ConfirmingNote,
  CopyButton,
  Disclosure,
  Field,
  KeyDots,
  Loading,
  Meter,
  Note,
  Spinner,
} from '../components/ui';
import {
  organizerInviteLink,
  prepareAddInvites,
  prepareAllowAdapter,
  prepareAuthorizeCreator,
  prepareCloseRegistration,
  prepareOpenDecryption,
  prepareTrackCeremony,
} from '../flows/organizer';
import { listRequests, type RequestSummary } from '../flows/participant';
import {
  getJoinedParticipants,
  inviteLinkage,
  readCeremony,
  type JoinedParticipant,
  type ManagerEvent,
} from '../lib/chain';
import {
  exportOrganizerRecord,
  importOrganizerRecord,
  organizerRecordFileName,
  parseOrganizerRecord,
} from '../lib/organizerRecord';
import { downloadTextFile } from '../lib/download';
import { readReleaseStatus } from '../lib/release';
import {
  bitCount,
  dateWithUtc,
  formatDate,
  identityCode,
  shortId,
  thresholdSentence,
  timeLeft,
  voteName,
} from '../lib/format';
import { usePoll } from '../lib/hooks';
import {
  failedText,
  findPending,
  pendingKey,
  sendTracked,
  settlePending,
  type FailedAction,
  type PendingDraft,
} from '../lib/pending';
import {
  getInviteMapping,
  getLabels,
  getVoteLabels,
  putInviteMapping,
  setLabel,
  setVoteLabel,
  updateRecord,
  type CeremonyRecord,
  type LabelMap,
  type VoteLabelMap,
} from '../lib/records';
import { useServices, type Services } from '../services';
import { FinishCard } from './ParticipantView';
import { phaseSentence } from './ViewerView';

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

/** One dashboard card with a stable key, so the page can order the cards by phase. */
type Block = [string, ReactNode];

interface Joined {
  auth: Hex;
  key: { x: bigint; y: bigint };
  /** Authenticated: this member's contribution is in. */
  dealt: boolean;
  /** Label-only linkage from cross-checked join events; may be unknown. */
  inviteId?: number;
}

/**
 * Which invite each member joined with (labels only): this committee's join events, scanned in
 * bounded, resumable ranges from its creation block when this device recorded one (else the
 * deployment block) and cross-checked against authenticated state. A scan that fails or has not
 * reached the head yet leaves some members without a name; it never blocks anything.
 */
async function joinLinkage(
  services: Services,
  record: CeremonyRecord,
  people: JoinedParticipant[],
  view: CeremonyView,
): Promise<Map<number, number>> {
  const settled = settledLinkage.get(record.key);
  if (settled) return settled;
  // Links found earlier (or loaded from an organizer record) come first: the join events are
  // history a provider may stop serving. Both go through the same cross-check.
  const stored = await getInviteMapping(record.chainId, record.manager, record.cid).catch(() => []);
  const storedEvents: ManagerEvent[] = stored.map((m) => ({
    eventName: 'ParticipantJoined',
    args: { cid: record.cid, index: m.index, auth: m.auth, inviteId: m.inviteId },
  }));
  const fromBlock = record.fromBlock !== undefined ? BigInt(record.fromBlock) : undefined;
  const events = await services
    .joinedEvents(record.cid, fromBlock)
    .then((r) => r.events)
    .catch(() => [] as ManagerEvent[]);
  const linkage = inviteLinkage([...storedEvents, ...events], record.cid, people, view);
  const links = [...linkage].map(([index, inviteId]) => ({ index, auth: people[index - 1]?.auth as Hex, inviteId }));
  const known = new Set(stored.map((m) => `${m.index}:${m.auth.toLowerCase()}:${m.inviteId}`));
  if (links.some((l) => !known.has(`${l.index}:${l.auth.toLowerCase()}:${l.inviteId}`))) {
    await putInviteMapping(record.chainId, record.manager, record.cid, links).catch(() => undefined);
  }
  // The list is locked and every member is linked: nothing left to scan for.
  if (view.phase !== (Phase.Registration as number) && linkage.size === people.length) {
    settledLinkage.set(record.key, linkage);
  }
  return linkage;
}

/** Committees whose every member is linked to an invitation after the list was locked. */
const settledLinkage = new Map<string, Map<number, number>>();

function InviteRow({
  record,
  view,
  inviteId,
  joined,
  label,
  onLabel,
}: {
  record: CeremonyRecord;
  view: CeremonyView;
  inviteId: number;
  joined: Joined | undefined;
  label: string;
  onLabel: (v: string) => void;
}) {
  const services = useServices();
  const { mnemonic } = useApp();
  const [open, setOpen] = useState(false);
  const used = ((view.consumedInvites >> BigInt(inviteId)) & 1n) === 1n;
  // The button exists only while this person has a pending step (review P1-4):
  // joining during Registration, contributing during Dealing. Afterwards the
  // row is just name + code + "joined".
  const action = !used
    ? view.phase === (Phase.Registration as number)
      ? 'Invite'
      : null
    : view.phase === (Phase.Dealing as number) && joined && !joined.dealt
      ? 'Remind to contribute'
      : null;
  const link = mnemonic
    ? organizerInviteLink(mnemonic, services.config, record.cid, inviteId, window.location.origin)
    : null;
  const mailBody = link
    ? `You are invited to help hold the key that protects an election's results.\n\nOpen this link to join (takes about two minutes):\n${link}\n\nThe link is personal — please don't forward it.`
    : '';

  return (
    <li className="px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={`order-1 flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
            used ? 'bg-ink text-white' : 'border border-line bg-wash text-muted'
          }`}
          aria-hidden="true"
        >
          {used ? <CheckIcon size={16} strokeWidth={2.25} /> : inviteId + 1}
        </span>
        <input
          className="input order-2 min-w-0 flex-1 py-2 sm:w-48 sm:flex-none"
          placeholder={`Person ${inviteId + 1}`}
          aria-label={`Name for invitation ${inviteId + 1} (stays on this device)`}
          value={label}
          onChange={(e) => onLabel(e.target.value)}
        />
        <span className="order-4 flex w-full flex-wrap items-center gap-2 pl-12 sm:order-3 sm:w-auto sm:pl-0">
          <Badge tone={used ? 'ok' : 'neutral'} dot>
            {used ? 'joined' : 'not joined yet'}
          </Badge>
          {joined && <span className="code-chip">{identityCode(joined.auth, joined.key)}</span>}
        </span>
        {link && (open || action) && (
          <Button
            variant={open ? 'ghost' : 'secondary'}
            size="sm"
            className="order-3 sm:order-4 sm:ml-auto"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Close' : action}
          </Button>
        )}
      </div>
      {open && link && (
        <div className="mt-3 flex flex-col gap-5 rounded-xl border border-line bg-paper p-4 sm:flex-row sm:p-5">
          <div className="min-w-0 flex-1 space-y-3">
            <p className="eyebrow">Personal invitation link</p>
            <p className="rounded-md border border-line bg-white px-3 py-2.5 font-mono text-xs leading-relaxed break-all text-ink-2">
              {link}
            </p>
            <Actions>
              <CopyButton text={link} label="Copy the link" />
              {'share' in navigator && (
                <Button variant="secondary" onClick={() => void navigator.share({ url: link }).catch(() => undefined)}>
                  <ShareIcon size={17} />
                  Share…
                </Button>
              )}
              <a
                className={buttonClass('secondary')}
                href={`mailto:?subject=${encodeURIComponent('Invitation: help hold an election key')}&body=${encodeURIComponent(mailBody)}`}
              >
                <MailIcon size={17} />
                Send by email
              </a>
            </Actions>
            <p className="text-[13px] leading-relaxed text-muted">
              {used
                ? 'They already joined — send the same link again to remind them of the next step.'
                : 'Each link works for one person, once. Send it over a channel you trust.'}
            </p>
          </div>
          <div className="mx-auto w-44 shrink-0 rounded-lg border border-line bg-white p-2 sm:mx-0 sm:self-start">
            <QrCode text={link} label={`QR code of invitation ${inviteId + 1}`} />
          </div>
        </div>
      )}
    </li>
  );
}

/** The member list frozen at one finalized anchor for the lock confirmation. */
interface Review {
  count: number;
  members: Joined[];
}

function PeopleCard({
  record,
  view,
  joined,
  policy,
}: {
  record: CeremonyRecord;
  view: CeremonyView;
  joined: Joined[];
  policy: PhasePolicyView;
}) {
  const services = useServices();
  const { mnemonic, refreshRecords } = useApp();
  /** Only a Manual-joining committee is locked by the organizer (§8.1). */
  const manualReg = policy.registrationMode === (PhaseMode.Manual as number);
  const [labels, setLabels] = useState<LabelMap>({});
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addCount, setAddCount] = useState(1);

  usePoll(
    async () => {
      setLabels(await getLabels(record.chainId, record.manager, record.cid));
    },
    60_000,
    [record.key],
  );

  const byInvite = new Map(joined.filter((p) => p.inviteId !== undefined).map((p) => [p.inviteId as number, p]));
  const canClose = view.phase === (Phase.Registration as number) && view.joinedCount >= view.threshold;
  // The confirmation is only valid for the exact list the organizer reviewed;
  // any joined-count change on chain invalidates it (the signed action binds
  // participantCount, so signing the frozen count binds the frozen list).
  const reviewStale = review !== null && Number(view.joinedCount) !== review.count;

  // Sent from this device, not yet in the finalized view the card shows.
  const locking = findPending(record, { kind: 'close' });
  const adding = findPending(record, { kind: 'addInvites' });

  const run = async (make: () => Promise<Action>, draft: PendingDraft) => {
    setBusy(true);
    setError(null);
    try {
      await sendTracked(services, record, await make(), draft, refreshRecords);
      setReview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // One atomic snapshot: count and member list read at the same finalized
  // anchor, so a member joining mid-read can never appear in the signed count
  // without appearing in the reviewed list (or vice versa).
  const startReview = async () => {
    setBusy(true);
    setError(null);
    try {
      const client = services.client;
      const anchor = await client.finalizedAnchor();
      const v = await client.getCeremony(record.cid, anchor);
      if (v.phase !== (Phase.Registration as number)) {
        throw new Error('this committee is no longer open for joining');
      }
      const people = await getJoinedParticipants(client, record.cid, Number(v.joinedCount), anchor);
      // Labels only: a missing link shows the member without a name, never blocks the review.
      const linkage = await joinLinkage(services, record, people, v);
      setReview({
        count: Number(v.joinedCount),
        members: people.map((p, i) => ({ ...p, inviteId: linkage.get(i + 1) })),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const joinedCount = Number(view.joinedCount);
  return (
    <Card
      title="People"
      icon={<UsersIcon />}
      aside={
        <span className="text-sm font-medium text-ink-2 tabular-nums">
          {joinedCount}/{view.inviteCount} joined
        </span>
      }
    >
      <p className="text-sm leading-relaxed text-muted">
        {Number(view.joinedCount)} of {view.inviteCount} invited people have joined. Names you type here stay on
        this device. The code next to each person lets you double-check who joined: it must match the code that
        person reads to you.
      </p>
      <Meter value={view.inviteCount > 0 ? joinedCount / view.inviteCount : 0} />
      <ul className="mt-5 divide-y divide-line rounded-lg border border-line">
        {Array.from({ length: view.inviteCount }, (_, inviteId) => (
          <InviteRow
            key={inviteId}
            record={record}
            view={view}
            inviteId={inviteId}
            joined={byInvite.get(inviteId)}
            label={labels[inviteId] ?? ''}
            onLabel={(v) => {
              setLabels((m) => ({ ...m, [inviteId]: v }));
              void setLabel(record.chainId, record.manager, record.cid, inviteId, v);
            }}
          />
        ))}
      </ul>

      {view.phase === (Phase.Registration as number) && mnemonic && locking && (
        <div className="mt-5">
          <ConfirmingNote lead="You locked the member list." />
        </div>
      )}
      {view.phase === (Phase.Registration as number) && mnemonic && !locking && (
        <div className="mt-5 space-y-5">
          {adding && <ConfirmingNote lead="You added invitations; their links appear here once confirmed." />}
          <div className="flex items-end gap-2">
            <div className="w-40">
              <Field
                label="Add more invitations"
                type="number"
                min={1}
                max={MAX_N - view.inviteCount}
                value={addCount}
                onChange={(e) => setAddCount(Number(e.target.value))}
              />
            </div>
            <Button
              variant="secondary"
              disabled={
                busy ||
                adding !== undefined ||
                view.inviteCount >= MAX_N ||
                addCount < 1 ||
                view.inviteCount + addCount > MAX_N
              }
              onClick={() =>
                void run(
                  () =>
                    prepareAddInvites(
                      mnemonic,
                      services.config,
                      record.cid,
                      view.inviteCount,
                      addCount,
                      record.accountIndex,
                    ),
                  { kind: 'addInvites', inviteCount: view.inviteCount + addCount },
                )
              }
            >
              <PlusIcon size={17} />
              Add
            </Button>
          </div>

          <div className="border-t border-line pt-5">
            {!manualReg ? (
              <p className="flex gap-2.5 text-sm leading-relaxed text-ink-2">
                <ClockIcon size={18} className="mt-0.5 text-muted" />
                <span>
                  Joining closes by itself on {dateWithUtc(Number(view.registrationDeadline))} — no step for you
                  here, as long as at least {view.threshold} people joined by then.
                </span>
              </p>
            ) : !review ? (
              <div>
                <Button
                  size="lg"
                  className="w-full sm:w-auto"
                  disabled={!canClose || busy}
                  onClick={() => void startReview()}
                >
                  <LockIcon size={18} />
                  Everyone is in — lock the member list
                </Button>
                {!canClose && (
                  <p className="hint">You need at least {view.threshold} joined members before locking the list.</p>
                )}
              </div>
            ) : (
              <Note tone="warn">
                <p className="font-semibold">Lock the list with these {review.count} members?</p>
                <ol className="mt-3 space-y-1.5 rounded-md border border-warn-line bg-white/70 p-3">
                  {review.members.map((p, i) => (
                    <li key={p.auth} className="font-mono text-xs leading-relaxed">
                      {i + 1}.{' '}
                      {p.inviteId !== undefined
                        ? labels[p.inviteId] || `Person ${p.inviteId + 1}`
                        : `Member ${i + 1}`}{' '}
                      — {identityCode(p.auth, p.key)}
                    </li>
                  ))}
                </ol>
                <p className="mt-3">No one else can join afterwards; members then add their contributions.</p>
                {reviewStale ? (
                  <div className="mt-3 space-y-3">
                    <p className="font-semibold">
                      The member list changed since you reviewed it — please review it again before locking.
                    </p>
                    <Actions>
                      <Button disabled={busy} onClick={() => void startReview()}>
                        Review the new list
                      </Button>
                      <Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>
                        Not yet
                      </Button>
                    </Actions>
                  </div>
                ) : (
                  <Actions className="mt-4">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            prepareCloseRegistration(
                              mnemonic,
                              services.config,
                              record.cid,
                              review.count,
                              record.accountIndex,
                            ),
                          { kind: 'close' },
                        )
                      }
                    >
                      {busy ? 'Working…' : 'Yes, lock it'}
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>
                      Not yet
                    </Button>
                  </Actions>
                )}
              </Note>
            )}
          </div>
        </div>
      )}
      {error && (
        <div className="mt-4">
          <Note tone="bad">That did not work: {error}.</Note>
        </div>
      )}
    </Card>
  );
}

function KeyCard({ record, view, joined }: { record: CeremonyRecord; view: CeremonyView; joined: Joined[] }) {
  const [labels, setLabels] = useState<LabelMap>({});
  usePoll(
    async () => {
      setLabels(await getLabels(record.chainId, record.manager, record.cid));
    },
    60_000,
    [record.key],
  );
  if (view.phase < (Phase.Dealing as number)) return null;
  const done = bitCount(view.qualBitmap);
  return (
    <Card
      title="The shared key"
      icon={<KeyIcon />}
      aside={
        view.phase === (Phase.Dealing as number) ? (
          <span className="text-sm font-medium text-ink-2 tabular-nums">
            {done}/{view.n} in
          </span>
        ) : undefined
      }
    >
      {view.phase === (Phase.Dealing as number) && (
        <>
          <p className="text-[15px] leading-relaxed text-ink-2" aria-live="polite">
            {done === view.n
              ? `All ${view.n} contributions are in — finish the key below.`
              : `${done} of ${view.n} members have added their contribution (${timeLeft(Number(view.dealingDeadline))}). Remind the missing ones with their link above.`}
          </p>
          <Meter value={view.n > 0 ? done / view.n : 0} />
          <ul className="mt-5 divide-y divide-line rounded-lg border border-line">
            {joined.map((p, i) => (
              <li key={p.auth} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 truncate font-medium text-ink">
                  {(p.inviteId !== undefined && labels[p.inviteId]) || `Member ${i + 1}`}
                </span>
                {p.dealt ? (
                  <Badge tone="ok" dot>
                    contributed
                  </Badge>
                ) : (
                  <Badge tone="neutral" dot>
                    waiting
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {view.phase === (Phase.Live as number) && (
        <>
          <div className="flex flex-col gap-3 rounded-lg border border-ok-line bg-ok-soft px-4 py-3.5 sm:flex-row sm:items-center">
            <KeyDots t={view.threshold} n={view.n} />
            <p className="text-[15px] font-medium text-ink">
              The key is ready: {thresholdSentence(view.threshold, view.n)}.
            </p>
          </div>
          <div className="mt-4">
            <Note tone="info">
              {view.n - view.threshold === 0
                ? `Every one of the ${view.n} members is needed: if a single one loses their twelve words, the results can never be opened.`
                : `The committee can afford to lose at most ${view.n - view.threshold} of its ${view.n} members: if more lose their twelve words, the results can never be opened.`}{' '}
              A few weeks before the opening date, ask each member to open this committee and use “Check my
              words”, and to tell you it worked.
            </Note>
          </div>
          <Disclosure>
            public key x {view.pkX.toString(10)}
            <br />
            public key y {view.pkY.toString(10)}
          </Disclosure>
        </>
      )}
    </Card>
  );
}

/**
 * Export / import of the organizer record (lib/organizerRecord.ts): the names, invitation links
 * and vote names that exist only on this device, plus the public facts to find the committee again.
 */
function OrganizerRecordCard({
  record,
  view,
  policy,
}: {
  record: CeremonyRecord;
  view: CeremonyView;
  policy: PhasePolicyView | null;
}) {
  const services = useServices();
  const { refreshRecords } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setNote(null);
    try {
      const release = await readReleaseStatus(services.client).catch(() => undefined);
      const file = await exportOrganizerRecord(record, services.config, {
        view,
        policy: policy ?? undefined,
        release,
        appUrl: window.location.origin,
      });
      downloadTextFile(organizerRecordFileName(record.cid), `${JSON.stringify(file, null, 2)}\n`);
    } catch (err) {
      setNote({ tone: 'bad', text: `That did not work: ${err instanceof Error ? err.message : String(err)}.` });
    }
  };

  const load = async (f: File) => {
    setBusy(true);
    setNote(null);
    try {
      const counts = await importOrganizerRecord(parseOrganizerRecord(await f.text()), record);
      settledLinkage.delete(record.key);
      await refreshRecords();
      setNote({
        tone: 'ok',
        text: `Loaded ${counts.names} ${counts.names === 1 ? 'name' : 'names'}, ${counts.links} invitation ${
          counts.links === 1 ? 'link' : 'links'
        } and ${counts.votes} vote ${counts.votes === 1 ? 'name' : 'names'}. They show up here within a minute.`,
      });
    } catch (err) {
      setNote({ tone: 'bad', text: `That did not work: ${err instanceof Error ? err.message : String(err)}.` });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Card title="Organizer record" icon={<FileIcon />}>
      <p className="text-sm leading-relaxed text-muted">
        The names you typed, which invitation each person used and the vote names exist only on this device.
        Save them to a file and keep it with your recovery kit — months from now, or on another device, load it
        here. The file holds no keys and no invitation links, but it does hold the names: keep it private.
      </p>
      <div className="mt-4 flex flex-col gap-2 [&>.btn]:w-full">
        <Button variant="secondary" onClick={() => void save()}>
          <DownloadIcon size={17} />
          Save the organizer record
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
          <UploadIcon size={17} />
          {busy ? 'Loading…' : 'Load a saved record'}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label="Organizer record file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void load(f);
          }}
        />
      </div>
      {note && (
        <div className="mt-4">
          <Note tone={note.tone}>{note.text}</Note>
        </div>
      )}
    </Card>
  );
}

/** A grant pending its explicit confirmation (grants can never be taken back). */
interface PendingGrant {
  which: 'adapter' | 'creator';
  address: Hex;
}

const grantDraft = (which: 'adapter' | 'creator', address: string): PendingDraft => ({
  kind: 'grant',
  grant: which,
  address: address as Hex,
});

function AccessCard({ record, failed }: { record: CeremonyRecord; failed: FailedAction[] }) {
  const services = useServices();
  const { mnemonic, refreshRecords } = useApp();
  const [adapter, setAdapter] = useState('');
  const [creator, setCreator] = useState('');
  const [pending, setPending] = useState<PendingGrant | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  /** The last grant sent from this page: "Done" once the finalized state shows it. */
  const [lastSent, setLastSent] = useState<PendingDraft | null>(null);

  if (!mnemonic) return null;
  const tail = pending ? pending.address.slice(-6) : '';
  const typedOk = typed.trim().toLowerCase() === tail.toLowerCase();
  const sentGrants = (record.pending ?? []).filter((p) => p.kind === 'grant');
  const grantPending = (which: 'adapter' | 'creator', address: string) =>
    findPending(record, grantDraft(which, address)) !== undefined;
  const lastDone =
    lastSent !== null &&
    findPending(record, lastSent) === undefined &&
    !failed.some((f) => pendingKey(f.action) === pendingKey(lastSent));

  const confirm = async () => {
    if (!pending || !typedOk) return;
    setBusy(true);
    setNote(null);
    setLastSent(null);
    try {
      const make =
        pending.which === 'adapter'
          ? () => prepareAllowAdapter(mnemonic, services.config, record.cid, pending.address, record.accountIndex)
          : () => prepareAuthorizeCreator(mnemonic, services.config, record.cid, pending.address, record.accountIndex);
      const draft = grantDraft(pending.which, pending.address);
      await sendTracked(services, record, await make(), draft, refreshRecords);
      setLastSent(draft);
      setPending(null);
      setTyped('');
    } catch (err) {
      setNote({ tone: 'bad', text: `That did not work: ${err instanceof Error ? err.message : String(err)}.` });
    } finally {
      setBusy(false);
    }
  };

  const startGrant = (which: 'adapter' | 'creator', address: string) => {
    setNote(null);
    setTyped('');
    setPending({ which, address: address as Hex });
  };

  return (
    <Card title="Connections" icon={<LinkIcon />}>
      <p className="text-sm leading-relaxed text-muted">
        Whoever runs the voting system (for example DAVINCI) will send you two long addresses. Paste each one
        exactly as you received it: the voting system connection that may ask this committee to open results,
        and the election organizer allowed to use this key.
      </p>
      <div className="mt-5 space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Field label="Voting system connection" placeholder="0x…" value={adapter} onChange={(e) => setAdapter(e.target.value)} />
          </div>
          <Button
            variant="secondary"
            disabled={!isAddress(adapter) || busy || pending !== null || grantPending('adapter', adapter)}
            onClick={() => startGrant('adapter', adapter)}
          >
            Approve…
          </Button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Field label="Election organizer" placeholder="0x…" value={creator} onChange={(e) => setCreator(e.target.value)} />
          </div>
          <Button
            variant="secondary"
            disabled={!isAddress(creator) || busy || pending !== null || grantPending('creator', creator)}
            onClick={() => startGrant('creator', creator)}
          >
            Allow…
          </Button>
        </div>
      </div>
      {pending && (
        <div className="mt-5">
          <Note tone="warn">
            <p className="font-semibold">This approval is permanent — it can never be taken back.</p>
            <p className="mt-1">
              {pending.which === 'adapter'
                ? 'Once approved, this voting system can ask the committee to open results for as long as the committee exists.'
                : 'Once allowed, this election organizer can use this key for as long as the committee exists.'}{' '}
              Make sure the address is exactly the one you were given:
            </p>
            <p className="mt-2 rounded-md border border-warn-line bg-white/70 px-3 py-2 font-mono text-xs break-all">
              {pending.address}
            </p>
            <div className="mt-3">
              <Field
                label={`To confirm, type its last 6 characters (${tail.slice(0, 2)}…)`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
            <Actions className="mt-4">
              <Button disabled={!typedOk || busy} onClick={() => void confirm()}>
                {busy ? 'Working…' : 'I checked the address — approve it forever'}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setPending(null);
                  setTyped('');
                }}
              >
                Cancel
              </Button>
            </Actions>
          </Note>
        </div>
      )}
      {sentGrants.map((p) => (
        <div key={pendingKey(p)} className="mt-4">
          <ConfirmingNote
            lead={
              p.grant === 'adapter'
                ? `You approved the voting system connection ${shortId(p.address ?? '')}.`
                : `You allowed the election organizer ${shortId(p.address ?? '')}.`
            }
          />
        </div>
      ))}
      {lastDone && (
        <div className="mt-4">
          <Note tone="ok">
            {lastSent.grant === 'adapter'
              ? 'Done — this voting system can now ask the committee to open results.'
              : 'Done — this election organizer can now use the key.'}
          </Note>
        </div>
      )}
      {note && (
        <div className="mt-4">
          <Note tone={note.tone}>{note.text}</Note>
        </div>
      )}
    </Card>
  );
}

/** Manual decryption (§8.7): the organizer's one-way switch that lets members open results. */
function OpenResultsCard({ record, policy }: { record: CeremonyRecord; policy: PhasePolicyView }) {
  const services = useServices();
  const { mnemonic, refreshRecords } = useApp();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Sent from this device, not in the finalized state yet. */
  const opening = findPending(record, { kind: 'open' });

  if (policy.decryptionMode !== (PhaseMode.Manual as number)) return null;
  const opened = policy.manualOpenedAt !== 0n || policy.decryptionOpen;

  const open = async () => {
    if (!mnemonic) return;
    setBusy(true);
    setError(null);
    try {
      // The signed instruction is short-lived and built only now, at the moment of opening.
      const action = await prepareOpenDecryption(mnemonic, services.config, record.cid, record.accountIndex);
      await sendTracked(services, record, action, { kind: 'open' }, refreshRecords);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (opened) {
    return (
      <Card title="The results are open" icon={<UnlockIcon />}>
        <p className="text-[15px] leading-relaxed text-ink-2">
          {policy.manualOpenedAt !== 0n
            ? `You opened the results on ${formatDate(Number(policy.manualOpenedAt))}. The members can now unlock every vote using this key.`
            : 'The safety date passed, so the results opened by themselves. The members can now unlock every vote using this key.'}
        </p>
      </Card>
    );
  }
  return (
    <Card title="Open the results" icon={<LockIcon />}>
      <p className="text-[15px] leading-relaxed text-ink-2">
        Votes using this key stay locked until you open the results
        {policy.manualDecryptionFallbackAt !== 0n
          ? ` — or until ${dateWithUtc(Number(policy.manualDecryptionFallbackAt))}, when they open by themselves as a safety measure`
          : ''}
        .
      </p>
      {opening ? (
        <div className="mt-4">
          <ConfirmingNote lead="You opened the results." />
        </div>
      ) : !mnemonic ? (
        <p className="mt-3 text-sm text-muted">
          Your organizer key is not on this device — restore it from your recovery kit to open the results.
        </p>
      ) : !confirming ? (
        <div className="mt-5">
          <Button className="w-full sm:w-auto" onClick={() => setConfirming(true)}>
            <UnlockIcon size={18} />
            Open the results now
          </Button>
        </div>
      ) : (
        <div className="mt-5">
          <Note tone="warn">
            <p className="font-semibold">Opening the results cannot be undone.</p>
            <p className="mt-1">
              From this moment on, the committee members can reveal the results of every vote using this key —
              current and future ones. If voting is still going on, wait.
            </p>
            <Actions className="mt-4">
              <Button disabled={busy} onClick={() => void open()}>
                {busy ? 'Working…' : 'I understand — open the results'}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                Not yet
              </Button>
            </Actions>
          </Note>
        </div>
      )}
      {error && (
        <div className="mt-4">
          <Note tone="bad">That did not work: {error}. Nothing was opened — you can try again.</Note>
        </div>
      )}
    </Card>
  );
}

function ResultsCard({
  record,
  view,
  policy,
}: {
  record: CeremonyRecord;
  view: CeremonyView;
  policy: PhasePolicyView;
}) {
  const services = useServices();
  const [requests, setRequests] = useState<RequestSummary[] | null>(null);
  const [labels, setLabels] = useState<VoteLabelMap>({});
  /** DAVINCI process titles by id (display only, hash-verified in lib/voteMeta.ts). */
  const [titles, setTitles] = useState<Record<string, string>>({});
  usePoll(
    async () => {
      const list = await listRequests(services, record.cid);
      setRequests(list);
      setLabels(await getVoteLabels(record.chainId, record.manager, record.cid));
      if (services.voteTitle) {
        for (const pid of list.flatMap((r) => (r.processId ? [r.processId.toLowerCase()] : []))) {
          void services.voteTitle(pid as Hex).then((t) => {
            if (t) setTitles((m) => (m[pid] === t ? m : { ...m, [pid]: t }));
          });
        }
      }
    },
    10_000,
    [record.cid],
  );
  return (
    <Card title="Votes using this key" icon={<BallotIcon />}>
      {!requests ? (
        <Spinner label="Checking…" />
      ) : requests.length === 0 ? (
        <EmptyState icon={<BallotIcon />}>No vote has asked to be opened yet.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {requests.map((r, i) => {
            const pid = r.processId?.toLowerCase();
            return (
              <li key={r.requestId} className="rounded-lg border border-line p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 font-semibold break-words text-ink">
                    {r.processId
                      ? voteName(labels[pid as string] ?? titles[pid as string], i + 1, r.processId)
                      : `Request ${shortId(r.requestId)}`}
                  </p>
                  <VoteBadge
                    ready={r.ready}
                    notSubmitted={r.notSubmitted}
                    gateOpen={policy.decryptionOpen}
                    turned={r.partialCount}
                    needed={view.threshold}
                  />
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">
                  {r.ready
                    ? `Open — results: ${(r.values ?? []).map((v) => v.toString(10)).join(', ')}. The numbers are in the ballot’s answer order; the voting system shows what each one means.`
                    : r.notSubmitted
                      ? 'Waiting for the voting system to send in the locked results.'
                      : !policy.decryptionOpen
                        ? policy.decryptionMode === (PhaseMode.Scheduled as number)
                          ? `Locked until ${dateWithUtc(Number(policy.decryptionOpenAt))}.`
                          : 'Locked — open the results from the Advanced section below to let the members act.'
                        : `${r.partialCount} of the ${view.threshold} needed members have turned their key.`}
                </p>
                {r.ready && <ResultValues values={r.values ?? []} />}
                {pid && (
                  <input
                    className="input mt-3 py-2 sm:max-w-64"
                    placeholder="Name this vote"
                    aria-label={`Name for vote ${i + 1} (stays on this device)`}
                    value={labels[pid] ?? ''}
                    onChange={(e) => {
                      setLabels((m) => ({ ...m, [pid]: e.target.value }));
                      void setVoteLabel(record.chainId, record.manager, record.cid, pid, e.target.value);
                    }}
                  />
                )}
                <Disclosure>
                  request {r.requestId}
                  {r.processId && (
                    <>
                      <br />
                      vote {r.processId}
                    </>
                  )}
                </Disclosure>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function OrganizerView({ record }: { record: CeremonyRecord }) {
  const services = useServices();
  const { mnemonic, refreshRecords } = useApp();
  /** Undefined before the first read; null while the finalized block does not hold the committee. */
  const [view, setView] = useState<CeremonyView | null | undefined>(undefined);
  const [policy, setPolicy] = useState<PhasePolicyView | null>(null);
  const [joined, setJoined] = useState<Joined[]>([]);
  const [failed, setFailed] = useState<FailedAction[]>([]);
  const trackTried = useRef(false);
  const poll = usePoll(
    async () => {
      const v = await readCeremony(services.client, record.cid);
      setView(v);
      if (v !== null) setPolicy(await services.client.getPolicy(record.cid));
      const settled = await settlePending(services, record, v);
      if (settled.failed.length > 0) setFailed((f) => [...f, ...settled.failed]);
      if (settled.changed) await refreshRecords();
      if (v && v.joinedCount > 0) {
        const people = await getJoinedParticipants(services.client, record.cid, Number(v.joinedCount));
        const linkage = await joinLinkage(services, record, people, v);
        setJoined(people.map((p, i) => ({ ...p, inviteId: linkage.get(i + 1) })));
      }
    },
    8000,
    [record.cid],
  );

  // Retry the relayer registration (/v1/track) a creation left unconfirmed: once per open of
  // this dashboard, best effort, flagged on the record only when every relayer confirmed
  // (withRecordLock keeps this write from losing a concurrent pending-entry write).
  useEffect(() => {
    if (trackTried.current || record.relayerTracked || !mnemonic || !view) return;
    if (view.phase === (Phase.Aborted as number)) return;
    trackTried.current = true;
    void prepareTrackCeremony(mnemonic, services.config, record.cid, record.accountIndex)
      .then((request) => services.trackCeremony(request))
      .then(async (tracked) => {
        if (!tracked) return;
        await updateRecord(record.chainId, record.manager, record.cid, { relayerTracked: true });
        await refreshRecords();
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view == null]);

  const failures = failed.map((f) => (
    <Note key={`${pendingKey(f.action)}:${f.action.sentAt}`} tone="bad">
      {failedText(f)}
    </Note>
  ));

  if (view === undefined) {
    if (poll.confirming) {
      return (
        <Page>
          <ConfirmingNote />
        </Page>
      );
    }
    return (
      <Page>
        {poll.error ? (
          <Note tone="bad">We could not reach the public record: {poll.error}</Note>
        ) : (
          <Loading label="Opening your committee…" />
        )}
      </Page>
    );
  }
  // We hold the organizer record, but the committee is not at the network's
  // confirmed height yet (fresh create; the views revert UnknownCeremony()):
  // a wait, not an error — unless the network rejected the creation.
  if (view === null) {
    const created = findPending(record, { kind: 'create' }) !== undefined;
    return (
      <Page>
        {failures}
        {!failed.some((f) => f.action.kind === 'create') && (
          <div className="card space-y-5 p-5 sm:p-7">
            <div>
              <p className="eyebrow">Organizer</p>
              <p className="mt-1.5 text-2xl leading-tight font-semibold tracking-tight text-ink">
                {record.name || 'New committee'}
              </p>
            </div>
            <ConfirmingNote lead={created ? 'Your committee was created.' : undefined} />
            <div className="border-t border-line pt-5">
              <LifecycleSteps
                steps={organizerSteps({ davinci: Boolean(services.config.davinci), connected: false, resultsOpen: false })}
              />
            </div>
          </div>
        )}
      </Page>
    );
  }

  const davinci = Boolean(services.config.davinci);
  const resultsOpen = policy?.decryptionOpen ?? false;
  const live = view.phase === (Phase.Live as number);
  // The cards in the order that puts the next thing to do first (phase by phase).
  const people: Block = ['people', policy && <PeopleCard record={record} view={view} joined={joined} policy={policy} />];
  const key: Block = ['key', <KeyCard record={record} view={view} joined={joined} />];
  const finish: Block = ['finish', policy && <FinishCard record={record} view={view} policy={policy} />];
  const connect: Block = ['connect', <DavinciConnectCard record={record} view={view} />];
  const results: Block = ['results', policy && live && <ResultsCard record={record} view={view} policy={policy} />];
  const aborted: Block = [
    'aborted',
    <Note tone="warn">This committee was called off. Start a new one when your group is ready.</Note>,
  ];
  // Raw connections stay visible when there is no pairing card — they are then the only path.
  const access: Block = [
    'access',
    live && !(services.config.davinci && mnemonic) && <AccessCard record={record} failed={failed} />,
  ];
  const advanced: Block = [
    'advanced',
    policy &&
      live &&
      (policy.decryptionMode === (PhaseMode.Manual as number) || Boolean(services.config.davinci && mnemonic)) && (
        <details className="card group p-5 sm:p-7">
          <summary className="flex cursor-pointer items-center gap-3.5 select-none">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-wash text-ink">
              <SettingsIcon />
            </span>
            <span className="flex-1 text-[17px] font-semibold tracking-tight text-ink">Advanced</span>
            <ChevronDownIcon size={20} className="text-muted transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Rarely needed, and some of it is permanent. For a committee made for DAVINCI Elections, the pairing
            card above is the connection you want.
          </p>
          <div className="mt-5 space-y-5">
            <OpenResultsCard record={record} policy={policy} />
            {services.config.davinci && mnemonic && <AccessCard record={record} failed={failed} />}
          </div>
        </details>
      ),
  ];
  return (
    <Dashboard
      header={
        <>
          {failures}
          <CommitteeHeader
            eyebrow={
              <>
                Organizer · <span className="font-mono tracking-normal normal-case">{shortId(record.cid)}</span>
              </>
            }
            title={record.name || 'Your committee'}
            view={view}
            resultsOpen={resultsOpen}
            steps={
              view.phase === (Phase.Aborted as number)
                ? undefined
                : organizerSteps({
                    view,
                    davinci,
                    connected: (record.davinciConnections ?? []).length > 0,
                    resultsOpen,
                  })
            }
          >
            <p>{phaseSentence(view)}</p>
            {view.phase === (Phase.Registration as number) && (
              <p className="flex gap-2 text-muted">
                <ClockIcon size={18} className="mt-0.5" />
                <span>
                  {view.registrationDeadline === 0n
                    ? 'You close joining yourself once everyone is in.'
                    : `Joining closes ${formatDate(Number(view.registrationDeadline))} (${timeLeft(Number(view.registrationDeadline))}).`}
                </span>
              </p>
            )}
            {policy && view.phase === (Phase.Live as number) && !policy.decryptionOpen && (
              <p className="flex gap-2 text-muted">
                <LockIcon size={18} className="mt-0.5" />
                <span>
                  {policy.decryptionMode === (PhaseMode.Scheduled as number)
                    ? `Results can be opened from ${dateWithUtc(Number(policy.decryptionOpenAt))}.`
                    : policy.manualDecryptionFallbackAt !== 0n
                      ? `Results open when you say so — or on ${dateWithUtc(Number(policy.manualDecryptionFallbackAt))} at the latest.`
                      : 'Results open only when you say so.'}
                </span>
              </p>
            )}
          </CommitteeHeader>
          {!mnemonic && (
            <Note tone="warn">
              Your organizer key is not on this device — restore it from your recovery kit to manage this
              committee. You can still watch its progress.
            </Note>
          )}
        </>
      }
      main={
        <>
          {(view.phase === (Phase.Live as number)
            ? [connect, results, key, people, access, advanced]
            : view.phase === (Phase.Dealing as number)
              ? [finish, key, people, connect]
              : view.phase === (Phase.Aborted as number)
                ? [aborted, people, key]
                : [finish, people, connect]
          ).map(([k, node]) => (
            <Fragment key={k}>{node}</Fragment>
          ))}
        </>
      }
      aside={
        <>
          <KitCard record={record} />
          <OrganizerRecordCard record={record} view={view} policy={policy} />
        </>
      }
    />
  );
}
