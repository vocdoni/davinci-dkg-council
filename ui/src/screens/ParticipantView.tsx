/**
 * Participant screens: invite onboarding (join), contribute (deal) and
 * unlock (partial decryption), per architecture §6.3 and protocol §8–§9.
 */

import { accountFromSecret, generateMnemonic, Phase, type CeremonyView, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../App';
import { KitCard } from '../components/KitCard';
import { RecoveryKitStep } from '../components/RecoveryKitStep';
import { Button, Card, ConfirmingNote, Disclosure, Note, ProgressBar, Spinner } from '../components/ui';
import { buildKitForRecords, manifestFingerprint } from '../flows/kit';
import { abortAction, finalizeAction } from '../flows/organizer';
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
  type CeremonySnapshot,
  type RequestSummary,
} from '../flows/participant';
import { getJoinedParticipants } from '../lib/chain';
import { bitCount, formatDate, identityCode, shortId, thresholdSentence, timeLeft, voteName } from '../lib/format';
import { usePoll } from '../lib/hooks';
import { getVoteLabels, putRecord, recordKey, updateRecord, type CeremonyRecord } from '../lib/records';
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
    return <ProgressBar value={ratio} label="Fetching the checking files — a few seconds on most connections…" />;
  }
  return <Spinner label="Doing the math — a few seconds. Keep this tab open." />;
}

// --- join flow (invite link) ---

export function JoinFlow({ cid, invite }: { cid: Hex; invite: { inviteId: number; secret: bigint } }) {
  const services = useServices();
  const { mnemonic, saveMnemonic, refreshRecords } = useApp();
  const [view, setView] = useState<CeremonyView | null>(null);
  const [inviteState, setInviteState] = useState<'checking' | 'ok' | 'used' | 'invalid'>('checking');
  const [step, setStep] = useState<'explain' | 'kit' | 'joining'>('explain');
  const [error, setError] = useState<string | null>(null);
  const [draftMnemonic] = useState(() => mnemonic ?? generateMnemonic());

  const poll = usePoll(
    async () => {
      setView(await services.client.getCeremony(cid));
    },
    8000,
    [cid],
  );

  useEffect(() => {
    void (async () => {
      try {
        const info = await services.client.getInvite(cid, invite.inviteId);
        const capAddress = accountFromSecret(invite.secret).address;
        if (info.key.toLowerCase() !== capAddress.toLowerCase()) setInviteState('invalid');
        else if (info.consumed) setInviteState('used');
        else setInviteState('ok');
      } catch {
        setInviteState('invalid');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, invite.inviteId]);

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

  const join = async () => {
    setStep('joining');
    setError(null);
    try {
      const action = await prepareJoin(draftMnemonic, services.config, cid, invite);
      const tx = await services.submit(action);
      await services.waitTx(tx);
      const fresh = await services.client.getCeremony(cid);
      const joined = await getJoinedParticipants(services.client, cid, fresh.joinedCount);
      const mine = participantKeys(draftMnemonic, services.config, cid).auth.address.toLowerCase();
      const index = joined.findIndex((p) => p.auth.toLowerCase() === mine) + 1;
      await putRecord({
        ...draftRecord,
        participantIndex: index > 0 ? index : undefined,
        kitExportFingerprint: manifestFingerprint(kit.manifest),
        // One-time prompt: the kit saved a minute ago predates this new role.
        kitJoinNudge: true,
      });
      await refreshRecords(); // re-renders into ParticipantView
    } catch (err) {
      setError(errText(err));
    }
  };

  if (!view) {
    if (poll.confirming) return <ConfirmingNote />;
    return poll.error ? (
      <Note tone="bad">We could not reach the public record: {poll.error}</Note>
    ) : (
      <Spinner label="Opening your invitation…" />
    );
  }
  // The invite link can arrive before the network confirmed the committee.
  if (view.phase === Phase.None) return <ConfirmingNote />;
  if (inviteState === 'invalid') {
    return <Note tone="bad">This invitation is not valid for this committee. Ask for a fresh link.</Note>;
  }
  if (inviteState === 'used') {
    return (
      <Note tone="warn">
        This invitation was already used. If that was you on another device, use your recovery kit to restore
        your key here.
      </Note>
    );
  }
  if (view.phase !== Phase.Registration) {
    return <Note tone="warn">The joining period for this committee is over.</Note>;
  }

  if (step === 'explain') {
    return (
      <div className="space-y-4">
        <Card title="You are invited to hold a key">
          <p className="text-sm leading-relaxed">
            A group of {view.inviteCount} people will jointly hold the key that locks an election’s results.
            Once ready, {thresholdSentence(view.threshold, view.inviteCount)} — never one person alone.
          </p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
            <li>Create your key on this device and save a recovery kit (about two minutes).</li>
            <li>Join the member list — one click.</li>
            <li>Later, when the list is locked, come back once to add your part of the key.</li>
          </ol>
          <p className="mt-3 text-sm text-ink/70">
            Nothing to install, nothing to pay. Join before {formatDate(Number(view.registrationDeadline))} (
            {timeLeft(Number(view.registrationDeadline))}).
          </p>
          <div className="mt-4">
            <Button onClick={() => setStep('kit')} disabled={inviteState === 'checking'}>
              Create my key
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (step === 'kit') {
    return (
      <RecoveryKitStep
        kit={kit}
        onDone={() => {
          void saveMnemonic(draftMnemonic).then(() => void join());
        }}
      />
    );
  }

  return (
    <Card title="Joining…">
      {error ? (
        <>
          <Note tone="bad">That did not work: {error}.</Note>
          <div className="mt-3">
            <Button onClick={() => void join()}>Try again</Button>
          </div>
        </>
      ) : (
        <Spinner label="Adding you to the member list — a few seconds…" />
      )}
    </Card>
  );
}

// --- contribute card (§8.3) ---

function ContributeCard({ record, view }: { record: CeremonyRecord; view: CeremonyView }) {
  const services = useServices();
  const { mnemonic, refreshRecords } = useApp();
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
    () => (mnemonic ? participantKeys(mnemonic, services.config, record.cid) : null),
    [mnemonic, services.config, record.cid],
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
      const prepared = await prepareDealing(mnemonic, services, record.cid, record.approvedRosterHash, setProgress);
      setProgress(null);
      const tx = await services.submit(prepared.action);
      await services.waitTx(tx);
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
    if (record.liveMode && approved && !dealt && !busyRef.current && !refusal && !error) void contribute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.liveMode, approved, dealt]);

  if (!mnemonic) {
    return (
      <Card title="Add your part of the key">
        <Note tone="warn">Your key is not on this device. Restore it from your recovery kit first.</Note>
      </Card>
    );
  }
  if (refusal) {
    return (
      <Card title="Add your part of the key">
        <RefusalNote reasons={refusal} />
      </Card>
    );
  }
  if (!snapshot) {
    return (
      <Card title="Add your part of the key">
        {error ? <Note tone="bad">We could not read the member list: {error}</Note> : <Spinner label="Reading the locked member list…" />}
      </Card>
    );
  }
  if (dealt) {
    const done = bitCount(view.qualBitmap);
    return (
      <Card title="Your contribution is in">
        <p className="text-sm" aria-live="polite">
          {done === view.n
            ? `All ${view.n} contributions are in. Next, someone presses “Finish the key” — anyone can, it takes a few seconds.`
            : `${done} of ${view.n} members have contributed. Nothing more for you to do here — we are waiting for the others.`}
        </p>
      </Card>
    );
  }

  return (
    <Card title="Add your part of the key">
      <p className="mb-2 text-sm leading-relaxed">
        The member list is now locked. These {snapshot.roster.n} people — and no one else — will hold the key.
        You see codes, not names. Read your code aloud to the group (call or message) and listen to theirs. If
        every code matches a person you know, approve. If one doesn’t, don’t approve — tell whoever runs the
        committee.
      </p>
      <ul className="mb-3 divide-y divide-ink/10 rounded-lg border border-ink/10">
        {snapshot.roster.authAddresses.map((addr, i) => {
          const code = identityCode(addr, snapshot.roster.memberKeys[i] ?? { x: 0n, y: 1n });
          const you = memberIndex === i + 1;
          return (
            <li key={addr} className="flex flex-wrap items-center justify-between px-3 py-2 text-sm">
              <span>
                Member {i + 1} {you && <strong>(you)</strong>}
              </span>
              <span className="font-mono text-xs">{code}</span>
              {you && <span className="w-full text-xs text-ink/60">Your code — share it so the others can check it’s you.</span>}
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
        <div className="mt-4">
          <Button onClick={() => void approve()}>These are the right people — I approve this list</Button>
          <p className="mt-2 text-xs text-ink/60">Nothing is sent yet; approving only unlocks the next step.</p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {progress ? (
            <ProveProgressView progress={progress} />
          ) : (
            <Button disabled={busy} onClick={() => void contribute()}>
              {busy ? 'Working…' : error ? 'Try again' : 'Add my contribution now'}
            </Button>
          )}
          {error && <Note tone="bad">That did not work: {error}.</Note>}
          <p className="text-xs text-ink/60">
            This fetches two checking files and does a few seconds of math on this device, then sends the
            result.
          </p>
        </div>
      )}
    </Card>
  );
}

// --- finalize / abort (permissionless) ---

export function FinishCard({ record, view }: { record: CeremonyRecord; view: CeremonyView }) {
  const services = useServices();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const triedRef = useRef(false);
  const canFinalize = finalizeEligible(view, nowSec());
  const canAbort = abortEligible(view, nowSec());

  const run = async (abort: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      const tx = await services.submit(abort ? abortAction(record.cid) : finalizeAction(record.cid));
      await services.waitTx(tx);
    } catch (err) {
      // Losing the race to another member is success, not failure.
      const fresh = await services.client.getCeremony(record.cid).catch(() => null);
      if (!abort && fresh?.phase === (Phase.Live as number)) {
        setNote({ tone: 'ok', text: 'Already done — the key is finished.' });
      } else if (abort && fresh?.phase === (Phase.Aborted as number)) {
        setNote({ tone: 'ok', text: 'Already done — the committee was called off.' });
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
    if (record.liveMode && canFinalize && !triedRef.current) {
      triedRef.current = true;
      void run(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.liveMode, canFinalize]);

  if (!canFinalize && !canAbort) return null;
  return (
    <Card title={canFinalize ? 'Finish the key' : 'This committee looks stuck'}>
      <p className="mb-3 text-sm">
        {canFinalize
          ? 'Enough contributions are in. Anyone can press this; it takes a few seconds.'
          : 'The deadline passed without enough contributions. Anyone can call it off so people stop waiting.'}
      </p>
      <Button disabled={busy} onClick={() => void run(!canFinalize)}>
        {busy ? 'Working…' : canFinalize ? 'Finish the key' : 'Call it off'}
      </Button>
      {note && (
        <div className="mt-3">
          <Note tone={note.tone}>{note.text}</Note>
        </div>
      )}
    </Card>
  );
}

// --- unlock card (§9.3) ---

function UnlockCard({ record }: { record: CeremonyRecord }) {
  const services = useServices();
  const { mnemonic } = useApp();
  const [requests, setRequests] = useState<RequestSummary[] | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [refusals, setRefusals] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<ProveProgress | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef(false);

  usePoll(
    async () => {
      setRequests(await listRequests(services, record.cid, record.participantIndex));
      setLabels(await getVoteLabels(record.chainId, record.manager, record.cid));
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
      const prepared = await preparePartial(mnemonic, services, record.cid, requestId, setProgress, {
        processId: r.processId,
      });
      if ((prepared.processId ?? '').toLowerCase() !== (r.processId ?? '').toLowerCase()) {
        throw new FlowRefusal(['the vote this request belongs to changed while we were checking — nothing was sent']);
      }
      setProgress(null);
      const tx = await services.submit(prepared.action);
      await services.waitTx(tx);
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

  // Live mode: auto-unlock pending requests whose vote binding is verified
  // (checks always re-run inside preparePartial).
  useEffect(() => {
    if (!record.liveMode || busyRef.current || !requests) return;
    const next = requests.find(
      (r) =>
        !r.ready &&
        !r.myPartialDone &&
        r.partialCount < r.threshold &&
        r.processId &&
        !refusals[r.requestId] &&
        !errors[r.requestId],
    );
    if (next) void unlock(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.liveMode, requests]);

  return (
    <Card title="Unlock requests">
      {!requests ? (
        <Spinner label="Checking for votes that need unlocking…" />
      ) : requests.length === 0 ? (
        <p className="text-sm text-ink/70">
          No vote has asked to be opened yet. When one does, it appears here.
        </p>
      ) : (
        <ul className="space-y-4">
          {requests.map((r, i) => (
            <li key={r.requestId} className="rounded-lg border border-ink/10 p-3">
              <p className="text-sm font-medium">
                {r.processId
                  ? voteName(labels[r.processId.toLowerCase()], i + 1, r.processId)
                  : `Request ${shortId(r.requestId)}`}
              </p>
              <p className="mt-1 text-sm text-ink/70">
                {r.ready
                  ? `Open — results: ${(r.values ?? []).map((v) => v.toString(10)).join(', ')}. The numbers are in the ballot’s answer order; the voting system shows what each one means.`
                  : `${r.partialCount} of the ${r.threshold} needed members have turned their key${r.myPartialDone ? '.' : ' — your turn.'}`}
              </p>
              {!r.ready && r.myPartialDone && <p className="mt-1 text-sm text-ok">You have done your part.</p>}
              {!r.ready && !r.myPartialDone && (
                <div className="mt-2 space-y-2">
                  {busyId === r.requestId && progress ? (
                    <ProveProgressView progress={progress} />
                  ) : (
                    <Button disabled={busyId !== null} onClick={() => void unlock(r)}>
                      {busyId === r.requestId ? 'Working…' : 'Check and turn my key'}
                    </Button>
                  )}
                  <p className="text-xs text-ink/60">
                    We first check that this request is genuine; if anything is off, nothing is revealed.
                  </p>
                </div>
              )}
              {refusals[r.requestId] && <div className="mt-2"><RefusalNote reasons={refusals[r.requestId] as string[]} /></div>}
              {errors[r.requestId] && (
                <div className="mt-2">
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
      )}
    </Card>
  );
}

// --- the assembled participant page ---

export function ParticipantView({ record }: { record: CeremonyRecord }) {
  const services = useServices();
  const { refreshRecords } = useApp();
  const [view, setView] = useState<CeremonyView | null>(null);
  const poll = usePoll(
    async () => {
      setView(await services.client.getCeremony(record.cid));
    },
    8000,
    [record.cid],
  );

  if (!view) {
    if (poll.confirming) return <ConfirmingNote />;
    return poll.error ? (
      <Note tone="bad">We could not reach the public record: {poll.error}</Note>
    ) : (
      <Spinner label="Opening your committee…" />
    );
  }
  // We hold a role here, but the committee is not visible at the network's
  // confirmed height yet (fresh create or restore): a wait, not an error.
  if (view.phase === Phase.None) return <ConfirmingNote />;

  const toggleLive = async () => {
    await updateRecord(record.chainId, record.manager, record.cid, { liveMode: !record.liveMode });
    await refreshRecords();
  };

  return (
    <div className="space-y-4">
      <Card title={record.name || 'Your committee'}>
        <p className="text-sm leading-relaxed">{phaseSentence(view)}</p>
        {view.phase === Phase.Registration && (
          <p className="mt-1 text-sm text-ink/70">
            You are on the list. The organizer locks it once everyone joined (
            {timeLeft(Number(view.registrationDeadline))}).
          </p>
        )}
        {view.phase === Phase.Dealing && (
          <p className="mt-1 text-sm text-ink/70">
            Contributions close {formatDate(Number(view.dealingDeadline))} ({timeLeft(Number(view.dealingDeadline))}).
          </p>
        )}
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={record.liveMode ?? false} onChange={() => void toggleLive()} />
          <span>
            {view.phase === Phase.Live || record.approvedRosterHash
              ? 'Keep this tab open and turn my key automatically when a genuine unlock request arrives.'
              : 'Keep this tab open and do each step for me when it is my turn. We still wait for your explicit approval of the member list.'}
          </span>
        </label>
      </Card>

      {view.phase === Phase.Dealing && <ContributeCard record={record} view={view} />}
      {view.phase === Phase.Dealing && <FinishCard record={record} view={view} />}
      {view.phase === Phase.Registration && <FinishCard record={record} view={view} />}
      {view.phase === Phase.Live && <UnlockCard record={record} />}
      {view.phase === Phase.Aborted && (
        <Note tone="warn">This committee was called off. If a new one starts, you will get a fresh invitation.</Note>
      )}

      <KitCard record={record} />
    </div>
  );
}
