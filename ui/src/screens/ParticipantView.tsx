/**
 * Participant screens: invite onboarding (join), contribute (deal) and
 * unlock (partial decryption), per architecture §6.3 and protocol §8–§9.
 */

import {
  accountFromSecret,
  generateMnemonic,
  Phase,
  PhaseMode,
  type CeremonyView,
  type Hex,
  type PhasePolicyView,
} from '@vocdoni/davinci-dkg-council-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../App';
import { KitCard } from '../components/KitCard';
import { OpeningReminder } from '../components/OpeningReminder';
import { RecoveryKitStep } from '../components/RecoveryKitStep';
import { StorageNote } from '../components/StorageNote';
import { Dashboard, Page } from '../components/Layout';
import { CommitteeHeader, LifecycleSteps } from '../components/Lifecycle';
import { memberSteps } from '../lib/lifecycle';
import { AlertIcon, ArrowRightIcon, BallotIcon, CheckIcon, ClockIcon, KeyIcon, LockIcon, UserPlusIcon } from '../components/icons';
import { EmptyState, ResultValues, VoteBadge } from '../components/Votes';
import {
  Button,
  Card,
  ConfirmingNote,
  Disclosure,
  KeyDots,
  Loading,
  Meter,
  Note,
  PageHeader,
  ProgressBar,
  Spinner,
} from '../components/ui';
import { buildKitForRecords, manifestFingerprint } from '../flows/kit';
import { abortAction, finalizeAction, scheduledCloseAction } from '../flows/organizer';
import {
  abortEligible,
  fetchSnapshot,
  finalizeEligible,
  FlowRefusal,
  listRequests,
  myMemberIndex,
  participantKeys,
  prepareDealing,
  prepareJoin,
  preparePartial,
  prepareRepublish,
  scheduledCloseEligible,
  toScheduleState,
  type CeremonySnapshot,
  type RequestSummary,
} from '../flows/participant';
import { participantIndexOf, readCeremony, republishCheck, type RepublishState } from '../lib/chain';
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
  alreadyAtHead,
  failedText,
  findPending,
  pendingKey,
  sendTracked,
  settlePending,
  type FailedAction,
} from '../lib/pending';
import { mayHaveLanded } from '../lib/relayerErrors';
import { deleteRecord, getVoteLabels, putRecord, recordKey, updateRecord, type CeremonyRecord } from '../lib/records';
import { KEEP_WORDS_UNTIL_RESULTS } from '../lib/storage';
import { useServices, type ProveProgress } from '../services';
import { phaseSentence } from './ViewerView';

const nowSec = () => Math.floor(Date.now() / 1000);

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function RefusalNote({ reasons }: { reasons: string[] }) {
  return (
    <Note tone="bad">
      <p className="font-semibold">We checked and refused — nothing was sent:</p>
      <ul className="mt-1 list-disc pl-5">
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </Note>
  );
}

function ProveProgressView({ progress }: { progress: ProveProgress | null }) {
  if (!progress) return null;
  if (progress.stage === 'download') {
    const ratio =
      progress.totalBytes && progress.loadedBytes ? progress.loadedBytes / progress.totalBytes : null;
    return (
      <div className="rounded-lg border border-info-line bg-info-soft px-4 py-3.5">
        <ProgressBar value={ratio} label="Fetching the checking files — a few seconds on most connections…" />
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-lg border border-info-line bg-info-soft px-4 py-3.5">
      <Spinner label="Doing the math — a few seconds. Keep this tab open." />
      <ProgressBar value={null} />
    </div>
  );
}

// --- join flow (invite link) ---

export function JoinFlow({ cid, invite }: { cid: Hex; invite: { inviteId: number; secret: bigint } }) {
  const services = useServices();
  const { mnemonic, saveMnemonic, refreshRecords } = useApp();
  /** Undefined before the first read; null while the finalized block does not hold the committee. */
  const [view, setView] = useState<CeremonyView | null | undefined>(undefined);
  const [inviteState, setInviteState] = useState<'checking' | 'ok' | 'used' | 'invalid'>('checking');
  const [step, setStep] = useState<'explain' | 'kit' | 'joining'>('explain');
  const [error, setError] = useState<string | null>(null);
  const [draftMnemonic] = useState(() => mnemonic ?? generateMnemonic());

  const draftRecord: CeremonyRecord = useMemo(
    () => ({
      key: recordKey(services.config.chainId, services.config.manager, cid),
      chainId: services.config.chainId,
      manager: services.config.manager,
      cid,
      role: 'participant',
      inviteId: invite.inviteId,
      createdAt: Date.now(),
    }),
    [services.config, cid, invite.inviteId],
  );
  const kit = useMemo(() => buildKitForRecords(draftMnemonic, [draftRecord]), [draftMnemonic, draftRecord]);

  const poll = usePoll(
    async () => {
      const v = await readCeremony(services.client, cid);
      setView(v);
      // The invitation is checked once the committee is visible: before that its views revert.
      if (v !== null && inviteState === 'checking') {
        try {
          const info = await services.client.getInvite(cid, invite.inviteId);
          const capAddress = accountFromSecret(invite.secret).address;
          if (info.key.toLowerCase() !== capAddress.toLowerCase()) setInviteState('invalid');
          else if (info.consumed) {
            // "Already used" may mean used by *this device* — a join that landed while the
            // local record (or the answer) was lost. If this device's key is on the member
            // list, write the record back and resume the member view instead of dead-ending.
            const index = mnemonic
              ? await participantIndexOf(
                  services.client,
                  cid,
                  participantKeys(mnemonic, services.config, cid).auth.address,
                ).catch(() => 0)
              : 0;
            if (index > 0) {
              await putRecord({ ...draftRecord, participantIndex: index });
              await refreshRecords(); // re-renders into ParticipantView
              return;
            }
            setInviteState('used');
          } else setInviteState('ok');
        } catch {
          setInviteState('invalid');
        }
      }
    },
    8000,
    [cid, invite.inviteId],
  );

  const join = async () => {
    setStep('joining');
    setError(null);
    try {
      const action = await prepareJoin(draftMnemonic, services.config, cid, invite);
      // Persist the role BEFORE sending (the kit saved a moment ago already covers this record,
      // so no fresh save prompt): a reload — or a lost answer — lands in the member view, which
      // tracks the pending join, instead of back at a consumed invite link.
      const entry = {
        kind: 'join' as const,
        sentAt: Date.now(),
        address: participantKeys(draftMnemonic, services.config, cid).auth.address,
      };
      await putRecord({ ...draftRecord, kitExportFingerprint: manifestFingerprint(kit.manifest), pending: [entry] });
      try {
        const txHash = await services.submit(action);
        await updateRecord(draftRecord.chainId, draftRecord.manager, cid, { pending: [{ ...entry, txHash }] });
      } catch (err) {
        // Already on the list at the head (an earlier try whose answer was lost): success. A
        // lost answer may have carried the join anyway: keep the record — the member view keeps
        // checking and settles it either way. Only a definitive refusal leaves nothing behind.
        if (!alreadyAtHead('join', err) && !mayHaveLanded(err)) {
          await deleteRecord(draftRecord.chainId, draftRecord.manager, cid);
          throw err;
        }
      }
      // The member index is filled in by ParticipantView once the finalized state shows the join.
      await refreshRecords(); // re-renders into ParticipantView
    } catch (err) {
      setError(errText(err));
    }
  };

  const steps = (
    <div className="card px-3 py-5 sm:px-7">
      <LifecycleSteps steps={memberSteps({})} />
    </div>
  );

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
          <Loading label="Opening your invitation…" />
        )}
      </Page>
    );
  }
  // The invite link can arrive before the network confirmed the committee.
  if (view === null) {
    return (
      <Page>
        <ConfirmingNote lead="This committee was created moments ago." />
      </Page>
    );
  }
  if (inviteState === 'invalid') {
    return (
      <Page>
        <Note tone="bad">This invitation is not valid for this committee. Ask for a fresh link.</Note>
      </Page>
    );
  }
  if (inviteState === 'used') {
    return (
      <Page>
        <Note tone="warn">
          This invitation was already used. If that was you on another device, use your recovery kit to restore
          your key here.
        </Note>
      </Page>
    );
  }
  if (view.phase !== Phase.Registration) {
    return (
      <Page>
        <Note tone="warn">The joining period for this committee is over.</Note>
      </Page>
    );
  }

  if (step === 'explain') {
    return (
      <Page>
        {steps}
        <section className="card overflow-hidden">
          <div className="p-6 sm:p-9">
            <p className="eyebrow">Invitation · Step 1 of 3</p>
            <h1 className="mt-3 text-[28px] leading-tight font-semibold tracking-tight text-ink sm:text-[34px]">
              You are invited to hold a key
            </h1>
            <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-ink-2">
              A group of {view.inviteCount} people will jointly hold the key that locks an election’s results.
              Once ready, {thresholdSentence(view.threshold, view.inviteCount)} — never one person alone.
            </p>
            <div className="mt-5 flex items-center gap-3 text-sm text-muted">
              <KeyDots t={view.threshold} n={view.inviteCount} />
              <span>
                {view.threshold} of {view.inviteCount} needed
              </span>
            </div>
          </div>
          <div className="border-t border-line bg-paper/70 p-6 sm:p-9">
            <ol className="grid gap-5 sm:grid-cols-3">
              {[
                'Create your key on this device and save a recovery kit (about two minutes).',
                'Join the member list — one click.',
                'Later, when the list is locked, come back once to add your part of the key.',
              ].map((text, i) => (
                <li key={text} className="flex gap-3 text-[15px] leading-relaxed text-ink-2 sm:flex-col">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-medium text-white">
                    {i + 1}
                  </span>
                  <span>{text}</span>
                </li>
              ))}
            </ol>
            <p className="mt-6 flex gap-2 text-sm leading-relaxed text-muted">
              <ClockIcon size={18} className="mt-0.5" />
              <span>
                Nothing to install, nothing to pay.{' '}
                {view.registrationDeadline === 0n
                  ? 'The organizer closes joining once everyone is in — join soon.'
                  : `Join before ${formatDate(Number(view.registrationDeadline))} (${timeLeft(Number(view.registrationDeadline))}).`}
              </span>
            </p>
            <div className="mt-6">
              <Button
                size="lg"
                className="w-full sm:w-auto"
                onClick={() => setStep('kit')}
                disabled={inviteState === 'checking'}
              >
                Create my key
                <ArrowRightIcon size={18} />
              </Button>
            </div>
          </div>
        </section>
      </Page>
    );
  }

  if (step === 'kit') {
    return (
      <Page>
        {steps}
        <PageHeader eyebrow="Invitation · Step 2 of 3" title="Your key">
          This device now makes your key. Keep its recovery kit before you join: it is the only way back in if
          this device is lost.
        </PageHeader>
        <RecoveryKitStep
          kit={kit}
          onDone={async () => {
            // Rejects (and stays on this step) unless the key is committed to this device's storage.
            await saveMnemonic(draftMnemonic);
            void join();
          }}
        />
      </Page>
    );
  }

  return (
    <Page>
      {steps}
      <Card title="Joining…" icon={<UserPlusIcon />}>
        {error ? (
          <>
            <Note tone="bad">That did not work: {error}.</Note>
            <div className="mt-4">
              <Button onClick={() => void join()}>Try again</Button>
            </div>
          </>
        ) : (
          <Spinner label="Adding you to the member list — a few seconds…" />
        )}
      </Card>
    </Page>
  );
}

// --- contribute card (§8.3) ---

function ContributeCard({ record, view }: { record: CeremonyRecord; view: CeremonyView }) {
  const services = useServices();
  const { mnemonic, refreshRecords } = useApp();
  /** Sent from this device, not in the finalized view yet. */
  const sent = findPending(record, { kind: 'deal' }) !== undefined;
  const [snapshot, setSnapshot] = useState<CeremonySnapshot | null>(null);
  const [refusal, setRefusal] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProveProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    setSnapshot(null);
    setRefusal(null);
    fetchSnapshot(services.client, record.cid).then(setSnapshot, (err: unknown) => {
      if (err instanceof FlowRefusal) setRefusal(err.reasons);
      else setError(errText(err));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.cid, view.rosterHash]);

  const keys = useMemo(
    () => (mnemonic ? participantKeys(mnemonic, services.config, record.cid, record.accountIndex) : null),
    [mnemonic, services.config, record.cid, record.accountIndex],
  );
  const memberIndex = useMemo(() => {
    if (!snapshot || !keys) return null;
    try {
      return myMemberIndex(keys, snapshot);
    } catch {
      return null;
    }
  }, [snapshot, keys]);

  const dealt = memberIndex !== null && ((view.qualBitmap >> (memberIndex - 1)) & 1) === 1;
  const approved =
    snapshot !== null && record.approvedRosterHash?.toLowerCase() === snapshot.rosterHash.toLowerCase();

  const approve = async () => {
    if (!snapshot) return;
    await updateRecord(record.chainId, record.manager, record.cid, { approvedRosterHash: snapshot.rosterHash });
    await refreshRecords();
  };

  const contribute = async () => {
    if (busyRef.current || !mnemonic || !record.approvedRosterHash) return;
    busyRef.current = true;
    setBusy(true);
    setRefusal(null);
    setError(null);
    try {
      const prepared = await prepareDealing(
        mnemonic,
        services,
        record.cid,
        record.approvedRosterHash,
        setProgress,
        record.accountIndex,
      );
      setProgress(null);
      await sendTracked(
        services,
        record,
        prepared.action,
        { kind: 'deal', memberIndex: prepared.dealerIndex },
        refreshRecords,
      );
    } catch (err) {
      if (err instanceof FlowRefusal) setRefusal(err.reasons);
      else setError(errText(err));
    } finally {
      setProgress(null);
      setBusy(false);
      busyRef.current = false;
    }
  };

  // Live mode: auto-contribute ONLY for a roster hash already approved on this device.
  useEffect(() => {
    if (record.liveMode && approved && !dealt && !sent && !busyRef.current && !refusal && !error) void contribute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.liveMode, approved, dealt, sent]);

  if (!mnemonic) {
    return (
      <Card title="Add your part of the key" icon={<KeyIcon />}>
        <Note tone="warn">Your key is not on this device. Restore it from your recovery kit first.</Note>
      </Card>
    );
  }
  if (refusal) {
    return (
      <Card title="Add your part of the key" icon={<KeyIcon />}>
        <RefusalNote reasons={refusal} />
      </Card>
    );
  }
  if (sent && !dealt) {
    return (
      <Card title="Your contribution was sent" icon={<KeyIcon />}>
        <ConfirmingNote lead="Your part of the key is on its way." />
      </Card>
    );
  }
  if (!snapshot) {
    return (
      <Card title="Add your part of the key" icon={<KeyIcon />}>
        {error ? <Note tone="bad">We could not read the member list: {error}</Note> : <Spinner label="Reading the locked member list…" />}
      </Card>
    );
  }
  if (dealt) {
    const done = bitCount(view.qualBitmap);
    return (
      <Card title="Your contribution is in" icon={<CheckIcon className="text-ok" />}>
        <p className="text-[15px] leading-relaxed text-ink-2" aria-live="polite">
          {done === view.n
            ? `All ${view.n} contributions are in. Next, someone presses “Finish the key” — anyone can, it takes a few seconds.`
            : `${done} of ${view.n} members have contributed. Nothing more for you to do here — we are waiting for the others.`}
        </p>
        <Meter value={view.n > 0 ? done / view.n : 0} />
        <p className="mt-4 text-sm leading-relaxed font-medium text-ink">{KEEP_WORDS_UNTIL_RESULTS}</p>
      </Card>
    );
  }

  return (
    <Card title="Add your part of the key" icon={<KeyIcon />}>
      <p className="text-[15px] leading-relaxed text-ink-2">
        The member list is now locked. These {snapshot.roster.n} people — and no one else — will hold the key.
        You see codes, not names. Read your code aloud to the group (call or message) and listen to theirs. If
        every code matches a person you know, approve. If one doesn’t, don’t approve — tell whoever runs the
        committee.
      </p>
      <ul className="mt-5 divide-y divide-line rounded-lg border border-line">
        {snapshot.roster.authAddresses.map((addr, i) => {
          const code = identityCode(addr, snapshot.roster.memberKeys[i] ?? { x: 0n, y: 1n });
          const you = memberIndex === i + 1;
          return (
            <li
              key={addr}
              className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm ${you ? 'bg-wash/70' : ''}`}
            >
              <span className="flex items-center gap-3">
                <span
                  className={`flex size-8 items-center justify-center rounded-full text-xs font-semibold ${
                    you ? 'bg-ink text-white' : 'border border-line bg-wash text-muted'
                  }`}
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <span className="font-medium text-ink">
                  Member {i + 1} {you && <strong className="font-semibold">(you)</strong>}
                </span>
              </span>
              <span className="code-chip text-[13px]">{code}</span>
              {you && (
                <span className="w-full pl-11 text-xs text-muted">Your code — share it so the others can check it’s you.</span>
              )}
            </li>
          );
        })}
      </ul>
      <Disclosure>
        roster hash {snapshot.rosterHash}
        <br />
        context {snapshot.view.ctx}
      </Disclosure>
      {!approved ? (
        <div className="mt-6 border-t border-line pt-6">
          <Button size="lg" className="w-full sm:w-auto" onClick={() => void approve()}>
            These are the right people — I approve this list
          </Button>
          <p className="hint">Nothing is sent yet; approving only unlocks the next step.</p>
        </div>
      ) : (
        <div className="mt-6 space-y-4 border-t border-line pt-6">
          {progress ? (
            <ProveProgressView progress={progress} />
          ) : (
            <Button size="lg" className="w-full sm:w-auto" disabled={busy} onClick={() => void contribute()}>
              {busy ? 'Working…' : error ? 'Try again' : 'Add my contribution now'}
            </Button>
          )}
          {error && <Note tone="bad">That did not work: {error}.</Note>}
          <p className="text-[13px] leading-relaxed text-muted">
            This fetches two checking files and does a few seconds of math on this device, then sends the
            result.
          </p>
        </div>
      )}
    </Card>
  );
}

// --- finalize / abort (permissionless) ---

export function FinishCard({
  record,
  view,
  policy,
}: {
  record: CeremonyRecord;
  view: CeremonyView;
  policy: PhasePolicyView;
}) {
  const services = useServices();
  const { refreshRecords } = useApp();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const triedRef = useRef(false);
  const state = toScheduleState(view, policy);
  const canFinalize = finalizeEligible(state, nowSec());
  // §8.3: the deadline passed with enough members — anyone may close joining now.
  const canClose = !canFinalize && scheduledCloseEligible(state, nowSec());
  const canAbort = !canFinalize && !canClose && abortEligible(state, nowSec());
  /** Sent from this device, or already done at the head by someone else: waiting for finality. */
  const finishing = findPending(record, { kind: 'finish' });
  const closing = findPending(record, { kind: 'close' });

  const run = async (step: 'finalize' | 'abort' | 'close') => {
    setBusy(true);
    setNote(null);
    try {
      if (step === 'close') {
        await sendTracked(services, record, scheduledCloseAction(record.cid), { kind: 'close' }, refreshRecords);
      } else {
        await sendTracked(
          services,
          record,
          step === 'abort' ? abortAction(record.cid) : finalizeAction(record.cid),
          { kind: 'finish', abort: step === 'abort' },
          refreshRecords,
        );
      }
    } catch (err) {
      // Losing the race to another member is success, not failure.
      const fresh = await services.client.getCeremony(record.cid).catch(() => null);
      if (step === 'finalize' && fresh?.phase === (Phase.Live as number)) {
        setNote({ tone: 'ok', text: 'Already done — the key is finished.' });
      } else if (step === 'abort' && fresh?.phase === (Phase.Aborted as number)) {
        setNote({ tone: 'ok', text: 'Already done — the committee was called off.' });
      } else if (step === 'close' && fresh !== null && fresh.phase !== (Phase.Registration as number)) {
        setNote({ tone: 'ok', text: 'Already done — the member list is locked.' });
      } else {
        setNote({
          tone: 'warn',
          text: `That did not go through (${errText(err)}). Someone else may have done it already.`,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!record.liveMode || triedRef.current) return;
    if (canFinalize && !finishing) {
      triedRef.current = true;
      void run('finalize');
    } else if (canClose && !closing) {
      triedRef.current = true;
      void run('close');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.liveMode, canFinalize, canClose]);

  if (!canFinalize && !canAbort && !canClose) return null;
  if (finishing) {
    return (
      <Card title={finishing.abort ? 'Calling it off' : 'Finishing the key'} icon={<KeyIcon />}>
        <ConfirmingNote
          lead={finishing.abort ? 'The committee is being called off.' : 'The key is being finished.'}
        />
      </Card>
    );
  }
  if (canClose) {
    if (closing) {
      return (
        <Card title="Closing the joining period" icon={<LockIcon />}>
          <ConfirmingNote lead="The member list is being locked." />
        </Card>
      );
    }
    return (
      <Card title="The joining period is over" icon={<LockIcon />}>
        <p className="text-[15px] leading-relaxed text-ink-2">
          The joining date passed and enough people are in. Anyone can lock the list now; it takes a few
          seconds.
        </p>
        <div className="mt-5">
          <Button size="lg" className="w-full sm:w-auto" disabled={busy} onClick={() => void run('close')}>
            {busy ? 'Working…' : 'Lock the member list'}
          </Button>
        </div>
        {note && (
          <div className="mt-4">
            <Note tone={note.tone}>{note.text}</Note>
          </div>
        )}
      </Card>
    );
  }
  return (
    <Card
      title={canFinalize ? 'Finish the key' : 'This committee looks stuck'}
      icon={canFinalize ? <KeyIcon /> : <AlertIcon className="text-warn" />}
    >
      <p className="text-[15px] leading-relaxed text-ink-2">
        {canFinalize
          ? 'Enough contributions are in. Anyone can press this; it takes a few seconds.'
          : 'The deadline passed without enough contributions. Anyone can call it off so people stop waiting.'}
      </p>
      <div className="mt-5">
        <Button
          size="lg"
          variant={canFinalize ? 'primary' : 'danger'}
          className="w-full sm:w-auto"
          disabled={busy}
          onClick={() => void run(canFinalize ? 'finalize' : 'abort')}
        >
          {busy ? 'Working…' : canFinalize ? 'Finish the key' : 'Call it off'}
        </Button>
      </div>
      {note && (
        <div className="mt-4">
          <Note tone={note.tone}>{note.text}</Note>
        </div>
      )}
    </Card>
  );
}

// --- unlock card (§9.3) ---

/** Why the results cannot be opened yet (§8.7), in plain language. */
function lockedSentence(policy: PhasePolicyView): string {
  if (policy.decryptionMode === (PhaseMode.Scheduled as number)) {
    return `the results are locked until ${dateWithUtc(Number(policy.decryptionOpenAt))}`;
  }
  return policy.manualDecryptionFallbackAt !== 0n
    ? `the results stay locked until the organizer opens them — or until ${dateWithUtc(
        Number(policy.manualDecryptionFallbackAt),
      )}, whichever comes first`
    : 'the results stay locked until the organizer opens them';
}

function UnlockCard({ record, policy }: { record: CeremonyRecord; policy: PhasePolicyView }) {
  const services = useServices();
  const { mnemonic, refreshRecords } = useApp();
  // The contract's own view of the §8.7 gate at the finalized block — never this device's clock.
  const gateOpen = policy.decryptionOpen;
  /** Turned on this device, not in the finalized state yet. */
  const turning = (r: RequestSummary) => findPending(record, { kind: 'partial', requestId: r.requestId }) !== undefined;
  const republishing = (r: RequestSummary) =>
    findPending(record, { kind: 'republish', requestId: r.requestId }) !== undefined;
  const [requests, setRequests] = useState<RequestSummary[] | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  /** DAVINCI process titles by id (display only, hash-verified in lib/voteMeta.ts). */
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [needRepub, setNeedRepub] = useState<Record<string, RepublishState>>({});
  const [refusals, setRefusals] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<ProveProgress | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef(false);

  usePoll(
    async () => {
      const list = await listRequests(services, record.cid, record.participantIndex);
      setRequests(list);
      setLabels(await getVoteLabels(record.chainId, record.manager, record.cid));
      if (services.voteTitle) {
        for (const pid of list.flatMap((r) => (r.processId ? [r.processId.toLowerCase()] : []))) {
          void services.voteTitle(pid as Hex).then((t) => {
            if (t) setTitles((m) => (m[pid] === t ? m : { ...m, [pid]: t }));
          });
        }
      }
      // §10.4: a vote stuck at the threshold with our part admitted but its data
      // unavailable or mismatched can be finished by republishing that data. A
      // provider that refuses old records makes it unverifiable, never hidden;
      // only a failed authenticated read leaves the button off.
      if (record.participantIndex !== undefined) {
        const repub: Record<string, RepublishState> = {};
        for (const r of list) {
          if (!r.ready && r.myPartialDone && r.partialCount >= r.threshold) {
            repub[r.requestId] = await republishCheck(
              services.client,
              record.cid,
              r.requestId,
              r.fieldCount,
              record.participantIndex,
            ).then(
              (c) => c.state,
              () => 'not-needed' as const,
            );
          }
        }
        setNeedRepub(repub);
      }
    },
    10_000,
    [record.cid, record.participantIndex],
  );

  const unlock = async (r: RequestSummary) => {
    const requestId = r.requestId;
    if (busyRef.current || !mnemonic) return;
    busyRef.current = true;
    setBusyId(requestId);
    setRefusals((m) => ({ ...m, [requestId]: undefined as never }));
    setErrors((m) => ({ ...m, [requestId]: undefined as never }));
    try {
      // The user approved *this* vote; preparePartial refuses if the
      // authenticated binding names any other.
      const prepared = await preparePartial(
        mnemonic,
        services,
        record.cid,
        requestId,
        setProgress,
        { processId: r.processId },
        record.accountIndex,
      );
      if ((prepared.processId ?? '').toLowerCase() !== (r.processId ?? '').toLowerCase()) {
        throw new FlowRefusal(['the vote this request belongs to changed while we were checking — nothing was sent']);
      }
      setProgress(null);
      await sendTracked(
        services,
        record,
        prepared.action,
        { kind: 'partial', requestId, memberIndex: prepared.participantIndex },
        refreshRecords,
      );
      setRequests(await listRequests(services, record.cid, record.participantIndex));
    } catch (err) {
      if (err instanceof FlowRefusal) setRefusals((m) => ({ ...m, [requestId]: err.reasons }));
      else setErrors((m) => ({ ...m, [requestId]: errText(err) }));
    } finally {
      setProgress(null);
      setBusyId(null);
      busyRef.current = false;
    }
  };

  // §10.4: rebuild and republish this member's already-admitted unlock data.
  const republish = async (r: RequestSummary) => {
    const requestId = r.requestId;
    if (busyRef.current || !mnemonic) return;
    busyRef.current = true;
    setBusyId(requestId);
    setRefusals((m) => ({ ...m, [requestId]: undefined as never }));
    setErrors((m) => ({ ...m, [requestId]: undefined as never }));
    try {
      const prepared = await prepareRepublish(mnemonic, services, record.cid, requestId, record.accountIndex);
      await sendTracked(
        services,
        record,
        prepared.action,
        {
          kind: 'republish',
          requestId,
          memberIndex: prepared.participantIndex,
          fieldCount: r.fieldCount,
          publishedBlock: prepared.publishedBlock.toString(10),
        },
        refreshRecords,
      );
    } catch (err) {
      if (err instanceof FlowRefusal) setRefusals((m) => ({ ...m, [requestId]: err.reasons }));
      else setErrors((m) => ({ ...m, [requestId]: errText(err) }));
    } finally {
      setBusyId(null);
      busyRef.current = false;
    }
  };

  // Live mode: auto-unlock pending requests whose vote binding is verified
  // (checks always re-run inside preparePartial). Never before the gate is
  // open, and never for a vote that has not submitted its results.
  useEffect(() => {
    if (!record.liveMode || !gateOpen || busyRef.current || !requests) return;
    const next = requests.find(
      (r) =>
        !r.ready &&
        !r.notSubmitted &&
        !r.myPartialDone &&
        !turning(r) &&
        r.partialCount < r.threshold &&
        r.processId &&
        !refusals[r.requestId] &&
        !errors[r.requestId],
    );
    if (next) void unlock(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.liveMode, gateOpen, requests]);

  return (
    <Card title="Unlock requests" icon={<BallotIcon />}>
      {!requests ? (
        <Spinner label="Checking for votes that need unlocking…" />
      ) : requests.length === 0 ? (
        <EmptyState icon={<BallotIcon />}>No vote has asked to be opened yet. When one does, it appears here.</EmptyState>
      ) : (
        <>
          {!gateOpen && requests.some((r) => !r.ready && !r.notSubmitted) && (
            <div className="mb-4">
              <Note tone="info">
                Right now {lockedSentence(policy)}. The date is a rule every member’s device checks against
                the public record before turning a key — committee members who ignore it could still act
                early, so it relies on them honoring it.
              </Note>
            </div>
          )}
          <ul className="space-y-3">
            {requests.map((r, i) => (
              <li key={r.requestId} className="rounded-lg border border-line p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 font-semibold break-words text-ink">
                    {r.processId
                      ? voteName(labels[r.processId.toLowerCase()] ?? titles[r.processId.toLowerCase()], i + 1, r.processId)
                      : `Request ${shortId(r.requestId)}`}
                  </p>
                  <VoteBadge
                    ready={r.ready}
                    notSubmitted={r.notSubmitted}
                    gateOpen={gateOpen}
                    turned={r.partialCount}
                    needed={r.threshold}
                  />
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">
                  {r.ready
                    ? `Open — results: ${(r.values ?? []).map((v) => v.toString(10)).join(', ')}. The numbers are in the ballot’s answer order; the voting system shows what each one means.`
                    : r.notSubmitted
                      ? 'This vote has not sent in its locked results yet — there is nothing for you to do. It becomes unlockable once the voting system submits them.'
                      : !gateOpen
                        ? `Waiting — ${lockedSentence(policy)}.`
                        : `${r.partialCount} of the ${r.threshold} needed members have turned their key${r.myPartialDone ? '.' : ' — your turn.'}`}
                </p>
                {r.ready && <ResultValues values={r.values ?? []} />}
                {!r.ready && !r.notSubmitted && r.myPartialDone && (
                  <p className="mt-3 flex items-center gap-2 text-sm font-medium text-ok">
                    <CheckIcon size={16} strokeWidth={2.25} />
                    <span>You have done your part.</span>
                  </p>
                )}
                {gateOpen && !r.ready && !r.notSubmitted && !r.myPartialDone && turning(r) && (
                  <div className="mt-3">
                    <ConfirmingNote lead="You turned your key." />
                  </div>
                )}
                {gateOpen && !r.ready && !r.notSubmitted && !r.myPartialDone && !turning(r) && (
                  <div className="mt-4 space-y-2.5">
                    {busyId === r.requestId && progress ? (
                      <ProveProgressView progress={progress} />
                    ) : (
                      <Button className="w-full sm:w-auto" disabled={busyId !== null} onClick={() => void unlock(r)}>
                        <KeyIcon size={18} />
                        {busyId === r.requestId ? 'Working…' : 'Check and turn my key'}
                      </Button>
                    )}
                    <p className="text-[13px] leading-relaxed text-muted">
                      We first check that this request is genuine; if anything is off, nothing is revealed.
                    </p>
                  </div>
                )}
                {gateOpen &&
                  !r.ready &&
                  r.myPartialDone &&
                  (needRepub[r.requestId] === 'missing' || needRepub[r.requestId] === 'unverifiable') &&
                  !republishing(r) && (
                    <div className="mt-4 space-y-2.5">
                      <Button className="w-full sm:w-auto" disabled={busyId !== null} onClick={() => void republish(r)}>
                        {busyId === r.requestId ? 'Working…' : 'Help finish opening the results'}
                      </Button>
                      <p className="text-[13px] leading-relaxed text-muted">
                        {needRepub[r.requestId] === 'missing'
                          ? 'Your part went through, but the copy the others need to finish is missing.'
                          : 'Your part went through, but this device cannot check whether the copy the others need to finish is still available (the public record’s older entries are not served here). If the results do not open, send it again.'}{' '}
                        This re-sends exactly what you published before — nothing new is revealed.
                      </p>
                    </div>
                  )}
                {!r.ready && republishing(r) && (
                  <div className="mt-3">
                    <ConfirmingNote lead="Your unlock data was re-sent." />
                  </div>
                )}
                {refusals[r.requestId] && (
                  <div className="mt-3">
                    <RefusalNote reasons={refusals[r.requestId] as string[]} />
                  </div>
                )}
                {errors[r.requestId] && (
                  <div className="mt-3">
                    <Note tone="bad">That did not work: {errors[r.requestId]}. You can try again.</Note>
                  </div>
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
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// --- the assembled participant page ---

export function ParticipantView({ record }: { record: CeremonyRecord }) {
  const services = useServices();
  const { mnemonic, refreshRecords } = useApp();
  /** Undefined before the first read; null while the finalized block does not hold the committee. */
  const [view, setView] = useState<CeremonyView | null | undefined>(undefined);
  const [policy, setPolicy] = useState<PhasePolicyView | null>(null);
  const [failed, setFailed] = useState<FailedAction[]>([]);
  const poll = usePoll(
    async () => {
      const v = await readCeremony(services.client, record.cid);
      setView(v);
      if (v !== null) setPolicy(await services.client.getPolicy(record.cid));
      const settled = await settlePending(services, record, v);
      if (settled.failed.length > 0) setFailed((f) => [...f, ...settled.failed]);
      let changed = settled.changed;
      // A fresh join learns its member index once the finalized state lists it (authenticated).
      if (v && record.participantIndex === undefined && mnemonic && v.joinedCount > 0) {
        const auth = participantKeys(mnemonic, services.config, record.cid, record.accountIndex).auth.address;
        const index = await participantIndexOf(services.client, record.cid, auth);
        if (index > 0) {
          await updateRecord(record.chainId, record.manager, record.cid, { participantIndex: index });
          changed = true;
        }
      }
      if (changed) await refreshRecords();
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
  // We hold a role here, but the committee is not at the network's confirmed
  // height yet (the views revert UnknownCeremony()): a wait, not an error.
  if (view === null) {
    return (
      <Page>
        {failures}
        <ConfirmingNote />
      </Page>
    );
  }
  const joining = findPending(record, { kind: 'join' }) !== undefined;
  const dealt =
    record.participantIndex !== undefined && ((view.qualBitmap >> (record.participantIndex - 1)) & 1) === 1;

  const toggleLive = async () => {
    await updateRecord(record.chainId, record.manager, record.cid, { liveMode: !record.liveMode });
    await refreshRecords();
  };

  return (
    <Dashboard
      header={
        <>
          {failures}
          <CommitteeHeader
            eyebrow={
              <>
                Member · <span className="font-mono tracking-normal normal-case">{shortId(record.cid)}</span>
              </>
            }
            title={record.name || 'Your committee'}
            view={view}
            resultsOpen={policy?.decryptionOpen ?? false}
            steps={view.phase === Phase.Aborted ? undefined : memberSteps({ view, dealt })}
            footer={
              <label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-ink-2">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-ink"
                  checked={record.liveMode ?? false}
                  onChange={() => void toggleLive()}
                />
                <span>
                  {view.phase === Phase.Live || record.approvedRosterHash
                    ? 'Keep this tab open and turn my key automatically when a genuine unlock request arrives.'
                    : 'Keep this tab open and do each step for me when it is my turn. We still wait for your explicit approval of the member list.'}
                </span>
              </label>
            }
          >
            <p>{phaseSentence(view)}</p>
            {view.phase === Phase.Registration && joining && <ConfirmingNote lead="You joined the member list." />}
            {view.phase === Phase.Registration && !joining && record.participantIndex !== undefined && (
              <p className="flex gap-2 text-muted">
                <CheckIcon size={18} className="mt-0.5 text-ok" />
                <span>
                  {view.registrationDeadline === 0n
                    ? 'You are on the list. The organizer locks it once everyone joined.'
                    : `You are on the list. Joining closes ${formatDate(Number(view.registrationDeadline))} (${timeLeft(Number(view.registrationDeadline))}).`}
                </span>
              </p>
            )}
            {view.phase === Phase.Registration && !joining && record.participantIndex === undefined && (
              <Note tone="warn">
                We cannot see you on the member list yet. Open your invitation link again to join — if you already
                did, it resumes where you left off.
              </Note>
            )}
            {view.phase === Phase.Dealing && (
              <p className="flex gap-2 text-muted">
                <ClockIcon size={18} className="mt-0.5" />
                <span>
                  Contributions close {formatDate(Number(view.dealingDeadline))} ({timeLeft(Number(view.dealingDeadline))}).
                </span>
              </p>
            )}
          </CommitteeHeader>
        </>
      }
      main={
        <>
          {view.phase === Phase.Dealing && <ContributeCard record={record} view={view} />}
          {policy && view.phase === Phase.Dealing && <FinishCard record={record} view={view} policy={policy} />}
          {policy && view.phase === Phase.Registration && <FinishCard record={record} view={view} policy={policy} />}
          {policy && view.phase === Phase.Live && <UnlockCard record={record} policy={policy} />}
          {policy && view.phase === Phase.Live && <OpeningReminder cid={record.cid} name={record.name} policy={policy} />}
          {view.phase === Phase.Aborted && (
            <Note tone="warn">This committee was called off. If a new one starts, you will get a fresh invitation.</Note>
          )}
          {view.phase === Phase.Registration && !joining && record.participantIndex !== undefined && (
            <WaitingCard />
          )}
        </>
      }
      aside={
        <>
          <StorageNote />
          <KitCard record={record} />
        </>
      }
    />
  );
}

/** Between joining and the locked list there is nothing to do: say so, and what comes next. */
function WaitingCard() {
  return (
    <Card title="Nothing to do right now" icon={<ClockIcon />}>
      <p className="text-[15px] leading-relaxed text-ink-2">
        When the member list is locked, come back to this page once to add your part of the key. It takes a
        minute and happens on this device. Bookmark this page, or open your invitation link again.
      </p>
    </Card>
  );
}
