/** Organizer: create-ceremony wizard (architecture §6.3 screen 1). */

import { generateMnemonic, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../App';
import { RecoveryKitStep } from '../components/RecoveryKitStep';
import { Button, Card, Disclosure, Field, Note, Spinner } from '../components/ui';
import { buildKitForRecords, manifestFingerprint } from '../flows/kit';
import { ceremonyIdFor, prepareCreateCeremony } from '../flows/organizer';
import { formatDate, thresholdSentence } from '../lib/format';
import { alreadyAtHead } from '../lib/pending';
import { recordKey, putRecord, type CeremonyRecord } from '../lib/records';
import { useServices } from '../services';

/** datetime-local value for a timestamp, in local time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CreateCeremony() {
  const { mnemonic, saveMnemonic, refreshRecords } = useApp();
  const services = useServices();
  const navigate = useNavigate();

  const [step, setStep] = useState<'params' | 'kit' | 'review'>('params');
  const [name, setName] = useState('');
  const [members, setMembers] = useState(5);
  const [threshold, setThreshold] = useState(3);
  const [deadline, setDeadline] = useState(() => toLocalInput(Date.now() + 48 * 3600_000));
  const [dealingHours, setDealingHours] = useState(24);
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
      createdAt: Date.now(),
    }),
    [services.config, cid, name, nonce],
  );
  const kit = useMemo(() => buildKitForRecords(draftMnemonic, [draftRecord]), [draftMnemonic, draftRecord]);

  const deadlineMs = new Date(deadline).getTime();
  const paramsProblem =
    members < 2 || members > 16
      ? 'A committee has between 2 and 16 members.'
      : threshold < 1 || threshold > members
        ? 'The number needed to open must be between 1 and the committee size.'
        : !Number.isFinite(deadlineMs) || deadlineMs < Date.now() + 10 * 60_000
          ? 'Give people at least 10 minutes to accept their invitations.'
          : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepareCreateCeremony(draftMnemonic, services.config, {
        threshold,
        memberCount: members,
        registrationDeadline: BigInt(Math.floor(deadlineMs / 1000)),
        dealingDuration: BigInt(dealingHours * 3600),
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
      // The dashboard shows "waiting for the network to confirm" until the finalized block has it.
      await putRecord({
        ...draftRecord,
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
            <Field
              label="Everyone must accept their invitation before"
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
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
        onDone={() => {
          void saveMnemonic(draftMnemonic).then(() => setStep('review'));
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
          <li>Invitations must be accepted before {formatDate(Math.floor(deadlineMs / 1000))}.</li>
          <li>
            Creating takes a few seconds. You hand out the invitation links on the next screen — nothing is sent
            to anyone yet.
          </li>
        </ul>
        <Disclosure>
          ceremony id {cid}
          <br />
          nonce {nonce.toString(10)}
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
