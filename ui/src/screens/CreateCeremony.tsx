/** Organizer: create-ceremony wizard (architecture §6.3 screen 1, protocol §8.1 schedule). */

import { generateMnemonic, PhaseMode, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../App';
import { Page } from '../components/Layout';
import { LifecycleSteps } from '../components/Lifecycle';
import { organizerSteps } from '../lib/lifecycle';
import { RecoveryKitStep } from '../components/RecoveryKitStep';
import { CalendarIcon, ChevronDownIcon, KeyIcon, UnlockIcon, UserPlusIcon, UsersIcon } from '../components/icons';
import { Actions, Button, Card, Disclosure, Fact, Field, KeyDots, Note, PageHeader, Spinner } from '../components/ui';
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

/** A radio option drawn as a selectable card; native input, no component library. */
function Choice(props: { name: string; checked: boolean; onSelect: () => void; label: string }) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3.5 text-[15px] leading-snug transition-colors ${
        props.checked ? 'border-ink bg-white ring-1 ring-ink' : 'border-line bg-white hover:border-line-strong'
      }`}
    >
      <input
        type="radio"
        name={props.name}
        className="mt-0.5 size-4 shrink-0 accent-ink"
        checked={props.checked}
        onChange={props.onSelect}
      />
      <span className={props.checked ? 'font-medium text-ink' : 'text-ink-2'}>{props.label}</span>
    </label>
  );
}

/** A checkbox with its sentence. */
function Check(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-[15px] leading-snug text-ink-2">
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-ink"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}

/** A form section inside a wizard card: a small heading and its controls. */
function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Card title={title} icon={icon}>
      <div className="space-y-5">{children}</div>
    </Card>
  );
}

/** The chosen date echoed in UTC so remote members read the same instant. */
function UtcEcho({ local }: { local: string }) {
  const ts = toUnix(local);
  if (!Number.isFinite(ts)) return null;
  return <p className="hint">That is {dateWithUtc(ts)}.</p>;
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

  const total = mnemonic ? 2 : 3;
  const lifecycle = (
    <div className="card px-4 py-5 sm:px-7">
      <LifecycleSteps steps={organizerSteps({ davinci: Boolean(services.config.davinci), connected: false, resultsOpen: false })} />
    </div>
  );

  if (step === 'params') {
    return (
      <Page>
        {lifecycle}
        <PageHeader eyebrow={`New committee · Step 1 of ${total}`} title="Set up your committee">
          Choose how many people hold the key, how joining ends and when the results may be opened. Nothing is
          sent until the last step.
        </PageHeader>
        {forDavinci && (
          <Note tone="info">
            This committee is for DAVINCI Elections. Set it up as usual — once its key is ready, you
            connect it to your organization with a pairing code from DAVINCI Elections.
          </Note>
        )}

        <Section title="Members" icon={<UsersIcon />}>
          <Field
            label="Name (only you see this)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="City council election 2026"
          />
          <div className="grid gap-5 sm:grid-cols-2">
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
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-wash/70 px-4 py-3.5 sm:flex-row sm:items-center">
            <KeyDots t={threshold} n={members} />
            <p className="text-sm leading-relaxed text-ink-2">
              With these numbers, {thresholdSentence(threshold, members)}. If fewer than {threshold} members can
              still take part, results can never be opened.
            </p>
          </div>
        </Section>

        <Section title="Joining" icon={<UserPlusIcon />}>
          <fieldset className="space-y-2.5">
            <legend className="label">How does joining end?</legend>
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
          </fieldset>
          {joinMode === 'manual' && (
            <Check
              checked={joinExpiry}
              onChange={setJoinExpiry}
              label="…or close automatically on a date, if enough people joined by then"
            />
          )}
          {deadlineUsed ? (
            <div>
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
          <label className="block">
            <span className="label">After the list is locked, how long do members get to contribute?</span>
            <span className="relative block">
              <select
                className="input appearance-none pr-10"
                value={dealingHours}
                onChange={(e) => setDealingHours(Number(e.target.value))}
              >
                <option value={1}>1 hour</option>
                <option value={6}>6 hours</option>
                <option value={24}>24 hours</option>
                <option value={72}>3 days</option>
              </select>
              <ChevronDownIcon size={18} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
            </span>
          </label>
        </Section>

        <Section title="Opening the results" icon={<UnlockIcon />}>
          <fieldset className="space-y-2.5">
            <legend className="label">When can the results be opened?</legend>
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
          </fieldset>
          {resultsMode === 'scheduled' && (
            <div>
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
              <Check
                checked={fallbackOn}
                onChange={setFallbackOn}
                label="…or automatically on a safety date, in case I never do"
              />
              {fallbackOn ? (
                <div>
                  <Field
                    label="If I have not opened them by"
                    type="datetime-local"
                    value={fallbackAt}
                    onChange={(e) => setFallbackAt(e.target.value)}
                  />
                  <UtcEcho local={fallbackAt} />
                  <p className="hint">
                    The safety date protects everyone if you lose access or disappear: from that day the members
                    can open the results without you.
                  </p>
                </div>
              ) : (
                <Note tone="warn">
                  Without a safety date, the results can never be opened if you lose access or disappear. Most
                  committees should leave it on.
                </Note>
              )}
            </>
          )}
        </Section>

        {paramsProblem && <Note tone="warn">{paramsProblem}</Note>}
        <Actions className="sm:justify-end">
          <Button size="lg" disabled={paramsProblem !== null} onClick={() => setStep(mnemonic ? 'review' : 'kit')}>
            Continue
          </Button>
        </Actions>
      </Page>
    );
  }

  if (step === 'kit') {
    return (
      <Page>
        {lifecycle}
        <PageHeader eyebrow={`New committee · Step 2 of ${total}`} title="Your organizer key">
          This device now makes the key you run the committee with. Keep its recovery kit before anything is
          sent: it is the only way back in if this device is lost.
        </PageHeader>
        <RecoveryKitStep
          kit={kit}
          onDone={async () => {
            // Rejects (and stays on this step) unless the key is committed to this device's storage.
            await saveMnemonic(draftMnemonic);
            setStep('review');
          }}
        />
      </Page>
    );
  }

  return (
    <Page>
      {lifecycle}
      <PageHeader eyebrow={`New committee · Step ${total} of ${total}`} title="Ready to create">
        Check the details below before creating the committee.
      </PageHeader>
      <Card>
        {name.trim() && <p className="mb-4 text-lg font-semibold tracking-tight text-ink">{name.trim()}</p>}
        <ul className="divide-y divide-line">
          <Fact icon={<UsersIcon />}>
            <strong className="font-semibold">{members} members</strong>, and {thresholdSentence(threshold, members)}.
          </Fact>
          <Fact icon={<UserPlusIcon />}>
            {joinMode === 'scheduled'
              ? `Joining closes on ${dateWithUtc(deadlineTs)}.`
              : joinExpiry
                ? `You close joining yourself — or it closes automatically on ${dateWithUtc(deadlineTs)} if enough people joined.`
                : 'You close joining yourself. There is no automatic cutoff.'}
          </Fact>
          <Fact icon={<CalendarIcon />}>
            After the list is locked, members have{' '}
            {dealingHours === 72 ? '3 days' : `${dealingHours} ${dealingHours === 1 ? 'hour' : 'hours'}`} to add their
            part.
          </Fact>
          <Fact icon={<UnlockIcon />}>
            {resultsMode === 'scheduled'
              ? `Results can be opened from ${dateWithUtc(openAtTs)}.`
              : fallbackOn
                ? `You open the results yourself — or they unlock automatically on ${dateWithUtc(fallbackTs)} if you have not.`
                : 'You open the results yourself. There is no automatic date: only you can open them.'}
          </Fact>
          <Fact icon={<KeyIcon />}>
            Creating takes a few seconds. You hand out the invitation links on the next screen — nothing is sent
            to anyone yet.
          </Fact>
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
          <div className="mt-5">
            <Note tone="bad">That did not work: {error}. Nothing was created — you can try again.</Note>
          </div>
        )}
        <div className="mt-6 flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-center">
          <Button size="lg" className="w-full sm:w-auto" disabled={busy} onClick={() => void submit()}>
            Create the committee
          </Button>
          {busy && <Spinner label="Creating — a few seconds…" />}
        </div>
      </Card>
    </Page>
  );
}
