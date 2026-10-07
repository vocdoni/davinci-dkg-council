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
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../App';
import { DavinciConnectCard } from '../components/DavinciConnectCard';
import { KitCard } from '../components/KitCard';
import { QrCode } from '../components/QrCode';
import { Button, Card, ConfirmingNote, CopyButton, Disclosure, Field, Note, Spinner } from '../components/ui';
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
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          className="w-36 rounded border border-ink/15 px-2 py-1 text-sm"
          placeholder={`Person ${inviteId + 1}`}
          aria-label={`Name for invitation ${inviteId + 1} (stays on this device)`}
          value={label}
          onChange={(e) => onLabel(e.target.value)}
        />
        <span className={used ? 'text-ok' : 'text-ink/60'}>{used ? 'joined' : 'not joined yet'}</span>
        {joined && <span className="font-mono text-xs text-ink/60">{identityCode(joined.auth, joined.key)}</span>}
        {link && (open || action) && (
          <Button variant="secondary" className="ml-auto" onClick={() => setOpen((v) => !v)}>
            {open ? 'Close' : action}
          </Button>
        )}
      </div>
      {open && link && (
        <div className="mt-3 space-y-3 rounded-lg bg-paper p-3">
          <p className="break-all font-mono text-xs">{link}</p>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={link} label="Copy the link" />
            {'share' in navigator && (
              <Button variant="secondary" onClick={() => void navigator.share({ url: link }).catch(() => undefined)}>
                Share…
              </Button>
            )}
            <a
              className="rounded-lg bg-accent-soft px-4 py-2.5 text-sm font-semibold text-accent hover:opacity-80"
              href={`mailto:?subject=${encodeURIComponent('Invitation: help hold an election key')}&body=${encodeURIComponent(mailBody)}`}
            >
              Send by email
            </a>
          </div>
          <QrCode text={link} />
          <p className="text-xs text-ink/60">
            {used
              ? 'They already joined — send the same link again to remind them of the next step.'
              : 'Each link works for one person, once. Send it over a channel you trust.'}
          </p>
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

  return (
    <Card title="People">
      <p className="mb-2 text-sm text-ink/70">
        {Number(view.joinedCount)} of {view.inviteCount} invited people have joined. Names you type here stay on
        this device. The code next to each person lets you double-check who joined: it must match the code that
        person reads to you.
      </p>
      <ul className="divide-y divide-ink/10 rounded-lg border border-ink/10">
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
        <div className="mt-4">
          <ConfirmingNote lead="You locked the member list." />
        </div>
      )}
      {view.phase === (Phase.Registration as number) && mnemonic && !locking && (
        <div className="mt-4 space-y-4">
          {adding && <ConfirmingNote lead="You added invitations; their links appear here once confirmed." />}
          <div className="flex flex-wrap items-end gap-2">
            <Field
              label="Add more invitations"
              type="number"
              min={1}
              max={MAX_N - view.inviteCount}
              value={addCount}
              onChange={(e) => setAddCount(Number(e.target.value))}
            />
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
              Add
            </Button>
          </div>

          {!manualReg ? (
            <p className="text-sm text-ink/70">
              Joining closes by itself on {dateWithUtc(Number(view.registrationDeadline))} — no step for you
              here, as long as at least {view.threshold} people joined by then.
            </p>
          ) : !review ? (
            <div>
              <Button disabled={!canClose || busy} onClick={() => void startReview()}>
                Everyone is in — lock the member list
              </Button>
              {!canClose && (
                <p className="mt-2 text-xs text-ink/60">
                  You need at least {view.threshold} joined members before locking the list.
                </p>
              )}
            </div>
          ) : (
            <Note tone="warn">
              <p className="font-semibold">Lock the list with these {review.count} members?</p>
              <ul className="mt-2 space-y-1">
                {review.members.map((p, i) => (
                  <li key={p.auth} className="font-mono text-xs">
                    {i + 1}.{' '}
                    {p.inviteId !== undefined
                      ? labels[p.inviteId] || `Person ${p.inviteId + 1}`
                      : `Member ${i + 1}`}{' '}
                    — {identityCode(p.auth, p.key)}
                  </li>
                ))}
              </ul>
              <p className="mt-2">No one else can join afterwards; members then add their contributions.</p>
              {reviewStale ? (
                <div className="mt-3 space-y-2">
                  <p className="font-semibold">
                    The member list changed since you reviewed it — please review it again before locking.
                  </p>
                  <div className="flex gap-2">
                    <Button disabled={busy} onClick={() => void startReview()}>
                      Review the new list
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>
                      Not yet
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex gap-2">
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
                </div>
              )}
            </Note>
          )}
        </div>
      )}
      {error && (
        <div className="mt-3">
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
    <Card title="The shared key">
      {view.phase === (Phase.Dealing as number) && (
        <>
          <p className="text-sm" aria-live="polite">
            {done === view.n
              ? `All ${view.n} contributions are in — finish the key below.`
              : `${done} of ${view.n} members have added their contribution (${timeLeft(Number(view.dealingDeadline))}). Remind the missing ones with their link above.`}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {joined.map((p, i) => (
              <li key={p.auth}>
                {(p.inviteId !== undefined && labels[p.inviteId]) || `Member ${i + 1}`} —{' '}
                {p.dealt ? 'contributed' : 'waiting'}
              </li>
            ))}
          </ul>
        </>
      )}
      {view.phase === (Phase.Live as number) && (
        <>
          <p className="text-sm text-ink/80">
            The key is ready: {thresholdSentence(view.threshold, view.n)}.
          </p>
          <div className="mt-2">
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
    <Card title="Organizer record">
      <p className="mb-3 text-sm leading-relaxed">
        The names you typed, which invitation each person used and the vote names exist only on this device.
        Save them to a file and keep it with your recovery kit — months from now, or on another device, load it
        here. The file holds no keys and no invitation links, but it does hold the names: keep it private.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void save()}>
          Save the organizer record
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
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
        <div className="mt-3">
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
    <Card title="Connections">
      <p className="mb-3 text-sm text-ink/70">
        Whoever runs the voting system (for example DAVINCI) will send you two long addresses. Paste each one
        exactly as you received it: the voting system connection that may ask this committee to open results,
        and the election organizer allowed to use this key.
      </p>
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
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
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
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
        <div className="mt-3">
          <Note tone="warn">
            <p className="font-semibold">This approval is permanent — it can never be taken back.</p>
            <p className="mt-1">
              {pending.which === 'adapter'
                ? 'Once approved, this voting system can ask the committee to open results for as long as the committee exists.'
                : 'Once allowed, this election organizer can use this key for as long as the committee exists.'}{' '}
              Make sure the address is exactly the one you were given:
            </p>
            <p className="mt-2 break-all font-mono text-xs">{pending.address}</p>
            <div className="mt-3">
              <Field
                label={`To confirm, type its last 6 characters (${tail.slice(0, 2)}…)`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
            <div className="mt-3 flex gap-2">
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
            </div>
          </Note>
        </div>
      )}
      {sentGrants.map((p) => (
        <div key={pendingKey(p)} className="mt-3">
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
        <div className="mt-3">
          <Note tone="ok">
            {lastSent.grant === 'adapter'
              ? 'Done — this voting system can now ask the committee to open results.'
              : 'Done — this election organizer can now use the key.'}
          </Note>
        </div>
      )}
      {note && (
        <div className="mt-3">
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
      <Card title="The results are open">
        <p className="text-sm text-ink/80">
          {policy.manualOpenedAt !== 0n
            ? `You opened the results on ${formatDate(Number(policy.manualOpenedAt))}. The members can now unlock every vote using this key.`
            : 'The safety date passed, so the results opened by themselves. The members can now unlock every vote using this key.'}
        </p>
      </Card>
    );
  }
  return (
    <Card title="Open the results">
      <p className="text-sm text-ink/80">
        Votes using this key stay locked until you open the results
        {policy.manualDecryptionFallbackAt !== 0n
          ? ` — or until ${dateWithUtc(Number(policy.manualDecryptionFallbackAt))}, when they open by themselves as a safety measure`
          : ''}
        .
      </p>
      {opening ? (
        <div className="mt-3">
          <ConfirmingNote lead="You opened the results." />
        </div>
      ) : !mnemonic ? (
        <p className="mt-2 text-sm text-ink/60">
          Your organizer key is not on this device — restore it from your recovery kit to open the results.
        </p>
      ) : !confirming ? (
        <div className="mt-3">
          <Button onClick={() => setConfirming(true)}>Open the results now</Button>
        </div>
      ) : (
        <div className="mt-3">
          <Note tone="warn">
            <p className="font-semibold">Opening the results cannot be undone.</p>
            <p className="mt-1">
              From this moment on, the committee members can reveal the results of every vote using this key —
              current and future ones. If voting is still going on, wait.
            </p>
            <div className="mt-3 flex gap-2">
              <Button disabled={busy} onClick={() => void open()}>
                {busy ? 'Working…' : 'I understand — open the results'}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                Not yet
              </Button>
            </div>
          </Note>
        </div>
      )}
      {error && (
        <div className="mt-3">
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
    <Card title="Votes using this key">
      {!requests ? (
        <Spinner label="Checking…" />
      ) : requests.length === 0 ? (
        <p className="text-sm text-ink/70">No vote has asked to be opened yet.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {requests.map((r, i) => {
            const pid = r.processId?.toLowerCase();
            return (
              <li key={r.requestId} className="rounded-lg border border-ink/10 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">
                    {r.processId
                      ? voteName(labels[pid as string] ?? titles[pid as string], i + 1, r.processId)
                      : `Request ${shortId(r.requestId)}`}
                  </p>
                  {pid && (
                    <input
                      className="w-40 rounded border border-ink/15 px-2 py-1 text-sm"
                      placeholder="Name this vote"
                      aria-label={`Name for vote ${i + 1} (stays on this device)`}
                      value={labels[pid] ?? ''}
                      onChange={(e) => {
                        setLabels((m) => ({ ...m, [pid]: e.target.value }));
                        void setVoteLabel(record.chainId, record.manager, record.cid, pid, e.target.value);
                      }}
                    />
                  )}
                </div>
                <p className="mt-1 text-ink/70">
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
    if (poll.confirming) return <ConfirmingNote />;
    return poll.error ? (
      <Note tone="bad">We could not reach the public record: {poll.error}</Note>
    ) : (
      <Spinner label="Opening your committee…" />
    );
  }
  // We hold the organizer record, but the committee is not at the network's
  // confirmed height yet (fresh create; the views revert UnknownCeremony()):
  // a wait, not an error — unless the network rejected the creation.
  if (view === null) {
    const created = findPending(record, { kind: 'create' }) !== undefined;
    return (
      <div className="space-y-4">
        {failures}
        {!failed.some((f) => f.action.kind === 'create') && (
          <ConfirmingNote lead={created ? 'Your committee was created.' : undefined} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {failures}
      <Card title={record.name || 'Your committee'}>
        <p className="text-sm leading-relaxed">{phaseSentence(view)}</p>
        {view.phase === (Phase.Registration as number) && (
          <p className="mt-1 text-sm text-ink/70">
            {view.registrationDeadline === 0n
              ? 'You close joining yourself once everyone is in.'
              : `Joining closes ${formatDate(Number(view.registrationDeadline))} (${timeLeft(Number(view.registrationDeadline))}).`}
          </p>
        )}
        {policy && view.phase === (Phase.Live as number) && !policy.decryptionOpen && (
          <p className="mt-1 text-sm text-ink/70">
            {policy.decryptionMode === (PhaseMode.Scheduled as number)
              ? `Results can be opened from ${dateWithUtc(Number(policy.decryptionOpenAt))}.`
              : policy.manualDecryptionFallbackAt !== 0n
                ? `Results open when you say so — or on ${dateWithUtc(Number(policy.manualDecryptionFallbackAt))} at the latest.`
                : 'Results open only when you say so.'}
          </p>
        )}
      </Card>
      {!mnemonic && (
        <Note tone="warn">
          Your organizer key is not on this device — restore it from your recovery kit to manage this
          committee. You can still watch its progress.
        </Note>
      )}
      {policy && <PeopleCard record={record} view={view} joined={joined} policy={policy} />}
      <KeyCard record={record} view={view} joined={joined} />
      {policy && <FinishCard record={record} view={view} policy={policy} />}
      <DavinciConnectCard record={record} view={view} />
      {policy && view.phase === (Phase.Live as number) && (
        <ResultsCard record={record} view={view} policy={policy} />
      )}
      {/* Raw connections stay visible when there is no pairing card — they are then the only path. */}
      {view.phase === (Phase.Live as number) && !(services.config.davinci && mnemonic) && (
        <AccessCard record={record} failed={failed} />
      )}
      {policy &&
        view.phase === (Phase.Live as number) &&
        (policy.decryptionMode === (PhaseMode.Manual as number) || Boolean(services.config.davinci && mnemonic)) && (
          <details className="rounded-xl border border-ink/10 bg-white p-4 sm:p-6">
            <summary className="cursor-pointer select-none text-base font-semibold">Advanced</summary>
            <p className="mt-2 text-sm text-ink/70">
              Rarely needed, and some of it is permanent. For a committee made for DAVINCI Elections, the
              pairing card above is the connection you want.
            </p>
            <div className="mt-3 space-y-4">
              <OpenResultsCard record={record} policy={policy} />
              {services.config.davinci && mnemonic && <AccessCard record={record} failed={failed} />}
            </div>
          </details>
        )}
      {view.phase === (Phase.Aborted as number) && (
        <Note tone="warn">This committee was called off. Start a new one when your group is ready.</Note>
      )}
      <OrganizerRecordCard record={record} view={view} policy={policy} />
      <KitCard record={record} />
    </div>
  );
}
