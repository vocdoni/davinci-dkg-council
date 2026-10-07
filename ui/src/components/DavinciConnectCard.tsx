/**
 * "Connect to DAVINCI Elections" (docs/davinci-integration.md): the organizer types a fresh
 * one-use pairing code (never read from a URL), the app resolves it only at an Elections origin
 * pinned in config.json, runs the fail-closed deployment check (lib/davinci.ts §5) before any
 * grant, shows the organization by name, and only then signs the two permanent grants — the
 * adapter read on chain from the pinned registry and the creator from the pinned origin's
 * resolve. The generic Connections card (manual grants) stays untouched next to this.
 */

import { Phase, type CeremonyView, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { useState } from 'react';
import { useApp } from '../App';
import { prepareAllowAdapter, prepareAuthorizeCreator } from '../flows/organizer';
import { isAdapterAllowed, isCreatorAuthorized } from '../lib/chain';
import {
  BAD_CODE_SHAPE_TEXT,
  CODE_INVALID_TEXT,
  checkDeployment,
  completePairing,
  normalizePairingCode,
  PairingError,
  resolvePairing,
  returnLink,
  waitForGrants,
  type CompletionResult,
  type ResolvedPairing,
} from '../lib/davinci';
import { formatDate, shortId, thresholdSentence } from '../lib/format';
import { findPending, sendTracked, type PendingDraft } from '../lib/pending';
import { getRecord, putRecord, recordKey, withRecordLock, type CeremonyRecord } from '../lib/records';
import { useServices } from '../services';
import { ArrowRightIcon, ChevronDownIcon, LinkIcon } from './icons';
import { buttonClass } from './buttonClass';
import { Actions, Button, Card, Disclosure, Field, Note, Spinner } from './ui';

/** A resolved, deployment-checked code waiting for the organizer's confirmation. */
interface Confirming {
  code: string;
  origin: string;
  resolved: ResolvedPairing;
  /** `councilAdapter()` read on chain from the pinned registry — the address granted. */
  adapter: Hex;
}

interface Done {
  orgName: string;
  link: string;
  status: CompletionResult['status'];
  statusReason: string | null;
}

const grantDraft = (which: 'adapter' | 'creator', address: Hex): PendingDraft => ({
  kind: 'grant',
  grant: which,
  address,
});

export function DavinciConnectCard({ record, view }: { record: CeremonyRecord; view: CeremonyView }) {
  const services = useServices();
  const { mnemonic, refreshRecords } = useApp();
  const davinci = services.config.davinci;
  const [origin, setOrigin] = useState(davinci?.electionsOrigins[0] ?? '');
  const [code, setCode] = useState('');
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The code expired between the grants and the completion: the grants are in place. */
  const [expiredAfterGrants, setExpiredAfterGrants] = useState(false);

  if (!davinci || !mnemonic) return null;
  if (view.phase !== (Phase.Live as number)) {
    // Started from an Elections deep link: say where this step lives once the key is ready.
    if (!record.forDavinciElections || view.phase === (Phase.Aborted as number)) return null;
    return (
      <Card title="Connect to DAVINCI Elections" icon={<LinkIcon />}>
        <Note tone="info">
          This committee was started for DAVINCI Elections. Finish setting it up first — once the key is
          ready, you connect it to your organization here with a pairing code.
        </Note>
      </Card>
    );
  }

  const host = (o: string) => new URL(o).host;
  const fail = (err: unknown) => {
    if (err instanceof PairingError) {
      if (err.detail) console.warn(`DAVINCI pairing: ${err.detail}`);
      setError(err.message);
    } else {
      setError(
        `That did not work: ${err instanceof Error ? err.message : String(err)}. Nothing was broken — you can try again.`,
      );
    }
  };

  const start = async () => {
    setError(null);
    setExpiredAfterGrants(false);
    const normalized = normalizePairingCode(code);
    if (normalized === null) {
      setError(BAD_CODE_SHAPE_TEXT);
      return;
    }
    setBusy('Checking the code…');
    try {
      const resolved = await resolvePairing(origin, normalized);
      let adapter: Hex;
      try {
        adapter = await services.readDavinciAdapter();
      } catch (err) {
        if (err instanceof PairingError) throw err;
        throw new PairingError(
          'We could not check the connection on the network. Nothing was changed — try again in a moment.',
          err instanceof Error ? err.message : String(err),
        );
      }
      checkDeployment(resolved, services.config, adapter);
      setConfirming({ code: normalized, origin, resolved, adapter });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    if (!confirming) return;
    const { resolved, adapter } = confirming;
    setError(null);
    setBusy('Making the approvals…');
    try {
      const grants: { which: 'adapter' | 'creator'; address: Hex; granted: () => Promise<boolean> }[] = [
        { which: 'adapter', address: adapter, granted: () => isAdapterAllowed(services.client, record.cid, adapter) },
        {
          which: 'creator',
          address: resolved.creator,
          granted: () => isCreatorAuthorized(services.client, record.cid, resolved.creator),
        },
      ];
      for (const g of grants) {
        const draft = grantDraft(g.which, g.address);
        // Already granted — or already sent from this device (pending = waiting for the network,
        // not done) — means nothing to re-send; a repeat would only revert AlreadyListed.
        if (findPending(record, draft) !== undefined || (await g.granted().catch(() => false))) continue;
        const action =
          g.which === 'adapter'
            ? await prepareAllowAdapter(mnemonic, services.config, record.cid, g.address, record.accountIndex)
            : await prepareAuthorizeCreator(mnemonic, services.config, record.cid, g.address, record.accountIndex);
        await sendTracked(services, record, action, draft, refreshRecords);
      }
      // §6: complete only once BOTH grants show in the finalized state this app reads at — a
      // sent grant can still be unmined or reverted, and completion consumes the one-use code.
      setBusy('Waiting for the network to confirm the approvals — usually about 4 minutes…');
      await waitForGrants(async () => {
        const ok = await Promise.all(grants.map((g) => g.granted().catch(() => false)));
        return ok.every(Boolean);
      });
      setBusy('Telling DAVINCI Elections…');
      const completion = await completePairing(confirming.origin, confirming.code, record.cid);
      await withRecordLock(recordKey(record.chainId, record.manager, record.cid), async () => {
        const current = await getRecord(record.chainId, record.manager, record.cid);
        if (!current) return;
        const rest = (current.davinciConnections ?? []).filter(
          (c) => !(c.orgId === resolved.orgId && c.origin === confirming.origin),
        );
        await putRecord({
          ...current,
          davinciConnections: [
            ...rest,
            { orgId: resolved.orgId, orgName: resolved.orgName, origin: confirming.origin, connectedAt: Date.now() },
          ],
        });
      });
      await refreshRecords();
      setDone({
        orgName: resolved.orgName,
        link: returnLink(confirming.origin, completion.returnPath, resolved.orgId),
        status: completion.status,
        statusReason: completion.statusReason,
      });
      setConfirming(null);
      setCode('');
    } catch (err) {
      // The grants (if any were needed) are in place; only the report to Elections is missing.
      if (err instanceof PairingError && err.message === CODE_INVALID_TEXT) {
        setExpiredAfterGrants(true);
        setConfirming(null);
        setCode('');
      } else {
        fail(err);
      }
    } finally {
      setBusy(null);
    }
  };

  const connections = record.davinciConnections ?? [];

  if (done) {
    return (
      <Card title="Connect to DAVINCI Elections" icon={<LinkIcon />}>
        <Note tone={done.status === 'unusable' ? 'warn' : 'ok'}>
          <p className="font-semibold">Connected to {done.orgName} on DAVINCI Elections.</p>
          {done.status === 'forming' && (
            <p className="mt-1">
              DAVINCI Elections is double-checking the connection on its side; it finishes by itself within a
              few minutes. Nothing more to do here.
            </p>
          )}
          {done.status === 'unusable' && (
            <p className="mt-1">DAVINCI Elections reports this committee as called off, so it cannot be used.</p>
          )}
        </Note>
        <Actions className="mt-5">
          <a className={buttonClass('primary', 'lg')} href={done.link}>
            Done — back to DAVINCI Elections
            <ArrowRightIcon size={18} />
          </a>
          <Button variant="secondary" size="lg" onClick={() => setDone(null)}>
            Close
          </Button>
        </Actions>
        {done.statusReason && <Disclosure>status reason: {done.statusReason}</Disclosure>}
      </Card>
    );
  }

  if (confirming) {
    const { resolved } = confirming;
    return (
      <Card title="Connect to DAVINCI Elections" icon={<LinkIcon />}>
        <Note tone="warn">
          <p className="font-semibold">
            Connect committee {shortId(record.cid)} to organization “{resolved.orgName}” on DAVINCI Elections?
          </p>
          <p className="mt-1">
            This allows {resolved.orgName}’s votings to use this committee’s key. It cannot be undone for this
            committee.
          </p>
          <ul className="mt-3 space-y-1.5 rounded-md border border-warn-line bg-white/70 p-3 text-xs leading-relaxed text-ink-2">
            <li>
              Committee {shortId(record.cid)}: {view.n} members, {thresholdSentence(view.threshold, view.n)}.
              {/* A restored record's createdAt is the restore time, not the committee's creation. */}
              {!record.restored && <> Created {formatDate(Math.floor(record.createdAt / 1000))}.</>}
            </li>
            <li>Elections server: {host(confirming.origin)}</li>
            <li className="font-mono break-all">Its votings are created by account {resolved.creator}</li>
          </ul>
          <Disclosure>
            ceremony id {record.cid}
            <br />
            organization {resolved.orgId}
            <br />
            creator {resolved.creator}
            <br />
            adapter (from the pinned registry) {confirming.adapter}
            <br />
            registry {davinci.registry}
            <br />
            origin {confirming.origin}
          </Disclosure>
          <Actions className="mt-4">
            <Button disabled={busy !== null} onClick={() => void connect()}>
              Connect
            </Button>
            <Button
              variant="secondary"
              disabled={busy !== null}
              onClick={() => {
                setConfirming(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </Actions>
          {busy && (
            <div className="mt-3">
              <Spinner label={busy} />
            </div>
          )}
        </Note>
        {error && (
          <div className="mt-4">
            <Note tone="bad">{error}</Note>
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card title="Connect to DAVINCI Elections" icon={<LinkIcon />}>
      {connections.map((c) => (
        <div key={`${c.origin}:${c.orgId}`} className="mb-4">
          <Note tone="ok">
            Connected to {c.orgName} ({host(c.origin)}) on {formatDate(Math.floor(c.connectedAt / 1000))}.
          </Note>
        </div>
      ))}
      <p className="text-[15px] leading-relaxed text-ink-2">
        If your organization uses DAVINCI Elections, connect this committee so the organization’s votings can
        use its key. In DAVINCI Elections, open Committees → “Get a pairing code”, then type the code here.
        The code works once and only for a short while.
      </p>
      <div className="mt-5 space-y-4">
        {davinci.electionsOrigins.length > 1 && (
          <label className="block">
            <span className="label">Elections server</span>
            <span className="relative block">
              <select className="input appearance-none pr-10" value={origin} onChange={(e) => setOrigin(e.target.value)}>
                {davinci.electionsOrigins.map((o) => (
                  <option key={o} value={o}>
                    {host(o)}
                  </option>
                ))}
              </select>
              <ChevronDownIcon
                size={18}
                className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted"
              />
            </span>
          </label>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Field
              label="Pairing code"
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="off"
              className="font-mono tracking-wider uppercase placeholder:normal-case placeholder:tracking-normal"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <Button disabled={busy !== null || code.trim() === ''} onClick={() => void start()}>
            Continue
          </Button>
        </div>
      </div>
      {busy && (
        <div className="mt-4">
          <Spinner label={busy} />
        </div>
      )}
      {expiredAfterGrants && (
        <div className="mt-4">
          <Note tone="warn">
            The code ran out while the approvals were being made — the approvals themselves are done. Ask for
            a new code in DAVINCI Elections (Committees → Get a pairing code) and type it here; the steps
            already done are skipped.
          </Note>
        </div>
      )}
      {error && (
        <div className="mt-4">
          <Note tone="bad">{error}</Note>
        </div>
      )}
    </Card>
  );
}
