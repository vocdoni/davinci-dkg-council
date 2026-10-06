/**
 * Organizer dashboard (architecture §6.3): status, people (invited → joined →
 * contributed, with local-only name labels and shareable invite links), key
 * progress, access control and results.
 */

import { MAX_N, Phase, type Action, type CeremonyView, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { useState } from 'react';
import { useApp } from '../App';
import { KitCard } from '../components/KitCard';
import { QrCode } from '../components/QrCode';
import { Button, Card, ConfirmingNote, CopyButton, Disclosure, Field, Note, Spinner } from '../components/ui';
import {
  organizerInviteLink,
  prepareAddInvites,
  prepareAllowAdapter,
  prepareAuthorizeCreator,
  prepareCloseRegistration,
} from '../flows/organizer';
import { listRequests, type RequestSummary } from '../flows/participant';
import { getJoinedParticipants, inviteLinkage, readCeremony } from '../lib/chain';
import { bitCount, formatDate, identityCode, shortId, thresholdSentence, timeLeft, voteName } from '../lib/format';
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
  getLabels,
  getVoteLabels,
  setLabel,
  setVoteLabel,
  type CeremonyRecord,
  type LabelMap,
  type VoteLabelMap,
} from '../lib/records';
import { useServices } from '../services';
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

function PeopleCard({ record, view, joined }: { record: CeremonyRecord; view: CeremonyView; joined: Joined[] }) {
  const services = useServices();
  const { mnemonic, refreshRecords } = useApp();
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
      const linkage = await services
        .getEvents(BigInt(services.config.deploymentBlock))
        .then((events) => inviteLinkage(events, record.cid, people, v))
        .catch(() => new Map<number, number>());
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
                  () => prepareAddInvites(mnemonic, services.config, record.cid, view.inviteCount, addCount),
                  { kind: 'addInvites', inviteCount: view.inviteCount + addCount },
                )
              }
            >
              Add
            </Button>
          </div>

          {!review ? (
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
                        () => prepareCloseRegistration(mnemonic, services.config, record.cid, review.count),
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
          ? () => prepareAllowAdapter(mnemonic, services.config, record.cid, pending.address)
          : () => prepareAuthorizeCreator(mnemonic, services.config, record.cid, pending.address);
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

function ResultsCard({ record, view }: { record: CeremonyRecord; view: CeremonyView }) {
  const services = useServices();
  const [requests, setRequests] = useState<RequestSummary[] | null>(null);
  const [labels, setLabels] = useState<VoteLabelMap>({});
  usePoll(
    async () => {
      setRequests(await listRequests(services, record.cid));
      setLabels(await getVoteLabels(record.chainId, record.manager, record.cid));
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
                    {r.processId ? voteName(labels[pid as string], i + 1, r.processId) : `Request ${shortId(r.requestId)}`}
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
  const [joined, setJoined] = useState<Joined[]>([]);
  const [failed, setFailed] = useState<FailedAction[]>([]);
  const poll = usePoll(
    async () => {
      const v = await readCeremony(services.client, record.cid);
      setView(v);
      const settled = await settlePending(services, record, v);
      if (settled.failed.length > 0) setFailed((f) => [...f, ...settled.failed]);
      if (settled.changed) await refreshRecords();
      if (v && v.joinedCount > 0) {
        const people = await getJoinedParticipants(services.client, record.cid, Number(v.joinedCount));
        const linkage = await services
          .getEvents(BigInt(services.config.deploymentBlock))
          .then((events) => inviteLinkage(events, record.cid, people, v))
          .catch(() => new Map<number, number>());
        setJoined(people.map((p, i) => ({ ...p, inviteId: linkage.get(i + 1) })));
      }
    },
    8000,
    [record.cid],
  );

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
            Joining closes {formatDate(Number(view.registrationDeadline))} ({timeLeft(Number(view.registrationDeadline))}).
          </p>
        )}
      </Card>
      {!mnemonic && (
        <Note tone="warn">
          Your organizer key is not on this device — restore it from your recovery kit to manage this
          committee. You can still watch its progress.
        </Note>
      )}
      <PeopleCard record={record} view={view} joined={joined} />
      <KeyCard record={record} view={view} joined={joined} />
      <FinishCard record={record} view={view} />
      {view.phase === (Phase.Live as number) && <AccessCard record={record} failed={failed} />}
      {view.phase === (Phase.Live as number) && <ResultsCard record={record} view={view} />}
      {view.phase === (Phase.Aborted as number) && (
        <Note tone="warn">This committee was called off. Start a new one when your group is ready.</Note>
      )}
      <KitCard record={record} />
    </div>
  );
}
