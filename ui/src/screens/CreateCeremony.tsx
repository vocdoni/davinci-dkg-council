/** Organizer: create-ceremony wizard (architecture §6.3 screen 1, protocol §8.1 schedule). */

import { generateMnemonic, PhaseMode, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../App';
import { RecoveryKitStep } from '../components/RecoveryKitStep';
import { Button, Card, Disclosure, Field, Note, Spinner } from '../components/ui';
import { buildKitForRecords, manifestFingerprint } from '../flows/kit';
import {
  ceremonyIdFor,
  prepareCreateCeremony,
  prepareTrackCeremony,
  type CreateCeremonyParams,
} from '../flows/organizer';
import { dateWithUtc, thresholdSentence } from '../lib/format';
import { alreadyAtHead } from '../lib/pending';
import { recordKey, putRecord, type CeremonyRecord } from '../lib/records';
import { useServices } from '../services';

/** datetime-local value for a timestamp, in local time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const toUnix = (local: string): number => Math.floor(new Date(local).getTime() / 1000);

/** A radio row with a label; native input, no component library. */
function Choice(props: { name: string; checked: boolean; onSelect: () => void; label: string }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="radio" name={props.name} className="mt-1" checked={props.checked} onChange={props.onSelect} />
      <span>{props.label}</span>
    </label>
  );
}

/** The chosen date echoed in UTC so remote members read the same instant. */
function UtcEcho({ local }: { local: string }) {
  const ts = toUnix(local);
  if (!Number.isFinite(ts)) return null;
  return <p className="mt-1 text-xs text-ink/60">That is {dateWithUtc(ts)}.</p>;
}

export function CreateCeremony() {
  const { mnemonic, saveMnemonic, refreshRecords } = useApp();
  const services = useServices();
  const navigate = useNavigate();
  // DAVINCI Elections deep link (docs/davinci-integration.md §9): cosmetic only. `label`
  // pre-fills the local display name; every other parameter is ignored — never an address,
  // never a return URL, and never a pairing code from a link.
  const [params] = useSearchParams();
  const forDavinci = params.get('davinci') === 'v1';

  const [step, setStep] = useState<'params' | 'kit' | 'review'>('params');
  const [name, setName] = useState(() =>
    forDavinci ? (params.get('label') ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) : '',
  );
  const [members, setMembers] = useState(5);
  const [threshold, setThreshold] = useState(3);
  const [dealingHours, setDealingHours] = useState(24);
  // Joining (§8.1 registration policy).
  const [joinMode, setJoinMode] = useState<'scheduled' | 'manual'>('scheduled');
  const [joinExpiry, setJoinExpiry] = useState(true);
  const [deadline, setDeadline] = useState(() => toLocalInput(Date.now() + 48 * 3600_000));
  // Results (§8.1 decryption policy).
  const [resultsMode, setResultsMode] = useState<'scheduled' | 'manual'>('manual');
  const [openAt, setOpenAt] = useState(() => toLocalInput(Date.now() + 90 * 24 * 3600_000));
  const [fallbackOn, setFallbackOn] = useState(true);
  const [fallbackAt, setFallbackAt] = useState(() => toLocalInput(Date.now() + 180 * 24 * 3600_000));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The root and ceremony id are fixed up front so the kit can include them.
  const [draftMnemonic] = useState(() => mnemonic ?? generateMnemonic());
  const [nonce] = useState(() => BigInt(Date.now()));
  const cid = useMemo(
    () => ceremonyIdFor(draftMnemonic, services.config, nonce),
    [draftMnemonic, services.config, nonce],
  );
  const draftRecord: CeremonyRecord = useMemo(
    () => ({
      key: recordKey(services.config.chainId, services.config.manager, cid),
      chainId: services.config.chainId,
      manager: services.config.manager,
      cid,
      role: 'organizer',
      name: name.trim() || undefined,
      nonce: nonce.toString(10),
      ...(forDavinci ? { forDavinciElections: true } : {}),
      createdAt: Date.now(),
    }),
    [services.config, cid, name, nonce, forDavinci],
  );
  const kit = useMemo(() => buildKitForRecords(draftMnemonic, [draftRecord]), [draftMnemonic, draftRecord]);

  const deadlineUsed = joinMode === 'scheduled' || joinExpiry;
  const deadlineTs = toUnix(deadline);
  const openAtTs = toUnix(openAt);
  const fallbackTs = toUnix(fallbackAt);
  const dealingSeconds = dealingHours * 3600;

  /** The exact §8.1 parameters the signed creation will carry. */
  const schedule: Omit<CreateCeremonyParams, 'threshold' | 'memberCount' | 'nonce'> = {
    registrationMode: joinMode === 'scheduled' ? PhaseMode.Scheduled : PhaseMode.Manual,
    registrationDeadline: deadlineUsed && Number.isFinite(deadlineTs) ? BigInt(deadlineTs) : 0n,
    dealingDuration: BigInt(dealingSeconds),
    decryptionMode: resultsMode === 'scheduled' ? PhaseMode.Scheduled : PhaseMode.Manual,
    decryptionOpenAt: resultsMode === 'scheduled' && Number.isFinite(openAtTs) ? BigInt(openAtTs) : 0n,
    manualDecryptionFallbackAt:
      resultsMode === 'manual' && fallbackOn && Number.isFinite(fallbackTs) ? BigInt(fallbackTs) : 0n,
  };

  const openingDate = resultsMode === 'scheduled' ? openAtTs : fallbackOn ? fallbackTs : undefined;
  const openingWhat = resultsMode === 'scheduled' ? 'opening date' : 'safety date';
  const paramsProblem =
    members < 2 || members > 16
      ? 'A committee has between 2 and 16 members.'
      : threshold < 1 || threshold > members
        ? 'The number needed to open must be between 1 and the committee size.'
        : deadlineUsed && (!Number.isFinite(deadlineTs) || deadlineTs * 1000 < Date.now() + 10 * 60_000)
          ? 'Give people at least 10 minutes to accept their invitations.'
          : resultsMode === 'scheduled' && (!Number.isFinite(openAtTs) || openAtTs * 1000 < Date.now())
            ? 'The results opening date must be in the future.'
            : resultsMode === 'manual' && fallbackOn && (!Number.isFinite(fallbackTs) || fallbackTs * 1000 < Date.now())
              ? 'The safety date must be in the future.'
              : deadlineUsed && openingDate !== undefined && openingDate <= deadlineTs + dealingSeconds
                ? `The ${openingWhat} must be after joining closes plus the contribution window.`
                : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // A lower bound of the creation block, so label scans of this committee's events start
      // there instead of at the deployment block (cosmetic; null when the read fails).
      const fromBlock = await services.client
        .finalizedAnchor()
        .then((a) => Number(a.blockNumber))
        .catch(() => undefined);
      const prepared = await prepareCreateCeremony(draftMnemonic, services.config, {
        threshold,
        memberCount: members,
        ...schedule,
        nonce,
      });
      let txHash: Hex | undefined;
      try {
        txHash = await services.submit(prepared.action);
      } catch (err) {
        // The id is this organizer's key + nonce: it exists at the head only if an earlier try landed.
        if (!alreadyAtHead('create', err)) throw err;
      }
      if (txHash !== undefined) await services.waitTx(txHash);
      // Best effort: register the committee with the deployment's relayers (/v1/track) so their
      // combine workers serve it from state. A failure is not an error — the dashboard retries.
      const tracked = await prepareTrackCeremony(draftMnemonic, services.config, prepared.cid)
        .then((request) => services.trackCeremony(request))
        .catch(() => false);
      // The dashboard shows "waiting for the network to confirm" until the finalized block has it.
      await putRecord({
        ...draftRecord,
        ...(fromBlock === undefined ? {} : { fromBlock }),
        ...(tracked ? { relayerTracked: true } : {}),
        kitExportFingerprint: manifestFingerprint(kit.manifest),
        pending: [{ kind: 'create', txHash, sentAt: Date.now() }],
      });
      await refreshRecords();
      navigate(`/c/${prepared.cid}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (step === 'params') {
    return (
      <div className="space-y-4">
        <Card title="Set up your committee">
          <div className="space-y-4">
            {forDavinci && (
              <Note tone="info">
                This committee is for DAVINCI Elections. Set it up as usual — once its key is ready, you
                connect it to your organization with a pairing code from DAVINCI Elections.
              </Note>
            )}
            <Field
              label="Name (only you see this)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="City council election 2026"
            />
            <Field
              label="How many people are in the committee?"
              type="number"
              min={2}
              max={16}
              value={members}
              onChange={(e) => setMembers(Number(e.target.value))}
            />
            <Field
              label="How many of them are needed to open the results?"
              type="number"
              min={1}
              max={members}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
            <Note tone="info">
              With these numbers, {thresholdSentence(threshold, members)}. If fewer than {threshold} members can
              still take part, results can never be opened.
            </Note>

            <fieldset className="space-y-2">
              <legend className="mb-1 block text-sm font-medium">How does joining end?</legend>
              <Choice
                name="joinMode"
                checked={joinMode === 'scheduled'}
                onSelect={() => setJoinMode('scheduled')}
                label="Joining closes on a date I pick"
              />
              <Choice
                name="joinMode"
                checked={joinMode === 'manual'}
                onSelect={() => setJoinMode('manual')}
                label="I'll close joining myself when everyone is in"
              />
              {joinMode === 'manual' && (
                <label className="ml-6 flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={joinExpiry}
                    onChange={(e) => setJoinExpiry(e.target.checked)}
                  />
                  <span>…or close automatically on a date, if enough people joined by then</span>
                </label>
              )}
              {deadlineUsed ? (
                <div className="ml-6">
                  <Field
                    label={joinMode === 'scheduled' ? 'Joining closes on' : 'Close automatically on'}
                    type="datetime-local"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                  />
                  <UtcEcho local={deadline} />
                </div>
              ) : (
                <Note tone="info">
                  There is no automatic cutoff: if not enough people join, nothing happens until you act.
                </Note>
              )}
            </fieldset>

            <label className="block">
              <span className="mb-1 block text-sm font-medium">
                After the list is locked, how long do members get to contribute?
              </span>
              <select
                className="w-full rounded-lg border border-ink/20 px-3 py-2 text-sm"
                value={dealingHours}
                onChange={(e) => setDealingHours(Number(e.target.value))}
              >
                <option value={1}>1 hour</option>
                <option value={6}>6 hours</option>
                <option value={24}>24 hours</option>
                <option value={72}>3 days</option>
              </select>
            </label>

            <fieldset className="space-y-2">
              <legend className="mb-1 block text-sm font-medium">When can the results be opened?</legend>
              <Choice
                name="resultsMode"
                checked={resultsMode === 'scheduled'}
                onSelect={() => setResultsMode('scheduled')}
                label="From a date I pick — nobody needs me on the day"
              />
              <Choice
                name="resultsMode"
                checked={resultsMode === 'manual'}
                onSelect={() => setResultsMode('manual')}
                label="I'll open the results myself when the time comes"
              />
              {resultsMode === 'scheduled' && (
                <div className="ml-6">
                  <Field
                    label="Results can be opened from"
                    type="datetime-local"
                    value={openAt}
                    onChange={(e) => setOpenAt(e.target.value)}
                  />
                  <UtcEcho local={openAt} />
                </div>
              )}
              {resultsMode === 'manual' && (
                <>
                  <label className="ml-6 flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={fallbackOn}
                      onChange={(e) => setFallbackOn(e.target.checked)}
                    />
                    <span>…or automatically on a safety date, in case I never do</span>
                  </label>
                  {fallbackOn ? (
                    <div className="ml-6">
                      <Field
                        label="If I have not opened them by"
                        type="datetime-local"
                        value={fallbackAt}
                        onChange={(e) => setFallbackAt(e.target.value)}
                      />
                      <UtcEcho local={fallbackAt} />
                      <p className="mt-1 text-xs text-ink/60">
                        The safety date protects everyone if you lose access or disappear: from that day the
                        members can open the results without you.
                      </p>
                    </div>
                  ) : (
                    <Note tone="warn">
                      Without a safety date, the results can never be opened if you lose access or disappear.
                      Most committees should leave it on.
                    </Note>
                  )}
                </>
              )}
            </fieldset>
          </div>
          {paramsProblem && (
            <div className="mt-3">
              <Note tone="warn">{paramsProblem}</Note>
            </div>
          )}
          <div className="mt-4">
            <Button disabled={paramsProblem !== null} onClick={() => setStep(mnemonic ? 'review' : 'kit')}>
              Continue
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
        onDone={async () => {
          // Rejects (and stays on this step) unless the key is committed to this device's storage.
          await saveMnemonic(draftMnemonic);
          setStep('review');
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card title="Ready to create">
        <ul className="space-y-2 text-sm">
          <li>
            <strong>{members} members</strong>, and {thresholdSentence(threshold, members)}.
          </li>
          <li>
            {joinMode === 'scheduled'
              ? `Joining closes on ${dateWithUtc(deadlineTs)}.`
              : joinExpiry
                ? `You close joining yourself — or it closes automatically on ${dateWithUtc(deadlineTs)} if enough people joined.`
                : 'You close joining yourself. There is no automatic cutoff.'}
          </li>
          <li>
            {resultsMode === 'scheduled'
              ? `Results can be opened from ${dateWithUtc(openAtTs)}.`
              : fallbackOn
                ? `You open the results yourself — or they unlock automatically on ${dateWithUtc(fallbackTs)} if you have not.`
                : 'You open the results yourself. There is no automatic date: only you can open them.'}
          </li>
          <li>
            Creating takes a few seconds. You hand out the invitation links on the next screen — nothing is sent
            to anyone yet.
          </li>
        </ul>
        <Disclosure>
          ceremony id {cid}
          <br />
          nonce {nonce.toString(10)}
          <br />
          registrationMode {schedule.registrationMode} deadline {schedule.registrationDeadline.toString(10)} dealing{' '}
          {schedule.dealingDuration.toString(10)}s
          <br />
          decryptionMode {schedule.decryptionMode} openAt {schedule.decryptionOpenAt.toString(10)} fallback{' '}
          {schedule.manualDecryptionFallbackAt.toString(10)}
        </Disclosure>
        {error && (
          <div className="mt-3">
            <Note tone="bad">That did not work: {error}. Nothing was created — you can try again.</Note>
          </div>
        )}
        <div className="mt-4 flex items-center gap-3">
          <Button disabled={busy} onClick={() => void submit()}>
            Create the committee
          </Button>
          {busy && <Spinner label="Creating — a few seconds…" />}
        </div>
      </Card>
    </div>
  );
}
