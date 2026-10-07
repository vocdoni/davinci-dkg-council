/**
 * Restore (protocol §5.3): from a recovery-kit file or from the twelve words
 * alone. Either way identities are re-derived from the root and authenticated
 * against chain registration state (`verifyRestoredIdentity`) — the kit's own
 * records are only a corruption check, never trusted. A kit whose root
 * differs from the one already on this device never overwrites it silently:
 * the user must explicitly switch, which archives the old root and its
 * records intact.
 */

import {
  kitEntryIdentity,
  normalizeCeremonyId,
  parseKit,
  rehearseEntry,
  restoreFromKit,
  rootFromMnemonic,
  type Hex,
  type KitManifestEntry,
} from '@vocdoni/davinci-dkg-council-sdk';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../App';
import { Page } from '../components/Layout';
import { FileIcon, KeyIcon, UploadIcon } from '../components/icons';
import { Actions, Button, Card, Field, Note, PageHeader } from '../components/ui';
import { manifestEntryFor, manifestFingerprint } from '../flows/kit';
import { shortId } from '../lib/format';
import { putRecord, recordKey, type CeremonyRecord } from '../lib/records';
import { useDeployments } from '../services';

const normalizeWords = (m: string) => m.trim().toLowerCase().split(/\s+/).join(' ');
const ZERO_ADDRESS = ('0x' + '0'.repeat(40)) as Hex;

interface PendingSwitch {
  mnemonic: string;
  records: CeremonyRecord[];
  notes: string[];
}

export function Restore() {
  const { mnemonic: currentMnemonic, saveMnemonic, switchRoot, refreshRecords } = useApp();
  // Kits and committee links of every deployment this copy serves (current + legacy managers).
  const deployments = useDeployments();
  const { config } = deployments.current;
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingSwitch | null>(null);
  const [words, setWords] = useState('');
  const [link, setLink] = useState('');

  /** The services of the entry's deployment, when this copy serves it. */
  const servicesFor = (e: KitManifestEntry) =>
    Number(e.chainId) === config.chainId ? deployments.forManager(e.manager) : undefined;

  const commitRecords = async (restored: CeremonyRecord[], notes: string[]) => {
    for (const record of restored) await putRecord(record);
    await refreshRecords();
    setWarnings(notes);
    setSuccess(true); // "Your key is back" — shown briefly before the start page.
    setTimeout(() => navigate('/'), notes.length === 0 ? 2000 : 4000);
  };

  /**
   * Store the restored root — unless a *different* root already lives here,
   * in which case nothing is written until the user explicitly switches.
   */
  const finish = async (newMnemonic: string, restored: CeremonyRecord[], notes: string[]) => {
    if (currentMnemonic && normalizeWords(currentMnemonic) !== normalizeWords(newMnemonic)) {
      setPending({ mnemonic: newMnemonic, records: restored, notes });
      return;
    }
    await saveMnemonic(newMnemonic);
    await commitRecords(restored, notes);
  };

  const confirmSwitch = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await switchRoot(pending.mnemonic);
      await commitRecords(pending.records, pending.notes);
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (file: File) => {
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const kit = parseKit(await file.text());
      const { root, manifest } = restoreFromKit(kit);
      const notes: string[] = [];
      const restored: CeremonyRecord[] = [];
      for (const entry of manifest) {
        const services = servicesFor(entry);
        if (!services) {
          notes.push(
            `${shortId(entry.ceremonyId)}: was made with a different copy of this app — open the link you were given for that committee.`,
          );
          continue;
        }
        // Corruption check against the kit's own records.
        if (!rehearseEntry(root, entry).ok) {
          throw new Error('the keys in this kit do not match its own records — the file may be damaged');
        }
        // Authentication against chain registration state (§5.3).
        const identity = kitEntryIdentity(root, entry);
        const verdict = await services.client.verifyRestoredIdentity(identity);
        if (!verdict.ok) {
          notes.push(
            `${shortId(entry.ceremonyId)}: the public record does not recognize this role (${verdict.mismatches.join('; ')}) — left out.`,
          );
          continue;
        }
        restored.push({
          key: recordKey(config.chainId, entry.manager, entry.ceremonyId as Hex),
          chainId: config.chainId,
          manager: entry.manager,
          cid: entry.ceremonyId as Hex,
          role: entry.role,
          // The index the identity was just authenticated with: every later key derivation and
          // kit export for this record must use it too.
          ...(entry.accountIndex !== 0 ? { accountIndex: entry.accountIndex } : {}),
          participantIndex: verdict.participantIndex,
          restored: true,
          createdAt: Date.now(),
        });
      }
      if (restored.length === 0) {
        setWarnings(notes);
        throw new Error('nothing in this kit could be restored here');
      }
      // The person restored *from* a kit, so this device is covered — no
      // "save your kit" banner. Words-only restores leave it unset on purpose.
      const fp = manifestFingerprint(restored.map((r) => manifestEntryFor(kit.private.mnemonic, r)));
      await finish(
        kit.private.mnemonic,
        restored.map((r) => ({ ...r, kitExportFingerprint: fp })),
        notes,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Words-only restore: twelve words + the committee link or code. */
  const restoreWords = async () => {
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const entered = normalizeWords(words);
      let root;
      try {
        root = rootFromMnemonic(entered);
      } catch {
        throw new Error('those do not look like a valid set of twelve recovery words');
      }
      const match = link.match(/0x[0-9a-fA-F]{24}/);
      if (!match) throw new Error('that link does not contain a committee code');
      const cid = normalizeCeremonyId(match[0]);
      const restored: CeremonyRecord[] = [];
      // The link names no deployment: ask each one this copy serves, current first.
      search: for (const d of deployments.list) {
        const services = deployments.forManager(d.manager);
        if (!services) continue;
        const manager = d.manager.toLowerCase() as Hex;
        for (const role of ['participant', 'organizer'] as const) {
          // kitEntryIdentity derives everything from the root and this context;
          // the placeholder address is never used.
          const identity = kitEntryIdentity(root, {
            role,
            chainId: String(config.chainId),
            manager,
            ceremonyId: cid,
            accountIndex: 0,
            authAddress: ZERO_ADDRESS,
          });
          const verdict = await services.client.verifyRestoredIdentity(identity).catch(() => null);
          if (verdict?.ok) {
            restored.push({
              key: recordKey(config.chainId, manager, cid),
              chainId: config.chainId,
              manager,
              cid,
              role,
              participantIndex: verdict.participantIndex,
              restored: true,
              createdAt: Date.now(),
            });
            break search;
          }
        }
      }
      if (restored.length === 0) {
        throw new Error('the public record does not recognize these words for that committee');
      }
      await finish(entered, restored, []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (pending) {
    return (
      <Page>
        <PageHeader eyebrow="Restore" title="This device already holds a different key" />
        <Card>
          <Note tone="warn">
            <p className="font-semibold">The kit you opened holds a different key than the one on this device.</p>
            <p className="mt-1">
              You can keep what you have (nothing changes), or switch to the restored key. Switching sets the
              current key and its committees aside — they are kept, not deleted, and the matching recovery kit
              brings them back — but this device then acts only with the restored key.
            </p>
          </Note>
          <Actions className="mt-5">
            <Button variant="secondary" disabled={busy} onClick={() => setPending(null)}>
              Keep what I have
            </Button>
            <Button disabled={busy} onClick={() => void confirmSwitch()}>
              {busy ? 'Working…' : 'Switch to the restored key'}
            </Button>
          </Actions>
          {error && (
            <div className="mt-4">
              <Note tone="bad">That did not work: {error}.</Note>
            </div>
          )}
        </Card>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader eyebrow="Restore" title="Bring your key back">
        Using a new device, or cleared this browser? Your recovery kit rebuilds your key here. Nothing secret is
        sent anywhere: the key is checked against the public record.
      </PageHeader>
      {success && <Note tone="ok">Your key is back. You can act for this committee again.</Note>}
      <Card title="Restore from a recovery kit" icon={<FileIcon />}>
        <p className="text-[15px] leading-relaxed text-ink-2">
          Pick the kit file you saved earlier. We re-create your keys from it and check them against the public
          record; nothing secret is sent anywhere. This takes a few seconds.
        </p>
        <div className="mt-5">
          <Button size="lg" className="w-full sm:w-auto" disabled={busy} onClick={() => fileRef.current?.click()}>
            <UploadIcon size={18} />
            {busy ? 'Checking…' : 'Open the kit file'}
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void restore(f);
          }}
        />
        {error && (
          <div className="mt-4">
            <Note tone="bad">That did not work: {error}.</Note>
          </div>
        )}
        {warnings.map((w) => (
          <div key={w} className="mt-4">
            <Note tone="warn">{w}</Note>
          </div>
        ))}
      </Card>
      <div className="flex items-center gap-4 text-xs font-medium tracking-[0.08em] text-faint uppercase" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <Card title="No file? Use your twelve words" icon={<KeyIcon />}>
        <p className="text-[15px] leading-relaxed text-ink-2">
          Type the twelve words from your printed sheet and paste the committee link (or its code) from your
          invitation or from whoever runs the committee. We rebuild your key and check it against the public
          record.
        </p>
        <label className="mt-5 block">
          <span className="label">Your twelve words</span>
          <textarea
            className="input font-mono"
            rows={3}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-label="Your twelve recovery words"
            placeholder="word1 word2 word3 …"
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
        </label>
        <div className="mt-4">
          <Field
            label="Committee link or code"
            placeholder="https://… or 0x…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
        </div>
        <div className="mt-5">
          <Button
            size="lg"
            className="w-full sm:w-auto"
            disabled={busy || words.trim() === '' || link.trim() === ''}
            onClick={() => void restoreWords()}
          >
            {busy ? 'Checking…' : 'Rebuild my key'}
          </Button>
        </div>
      </Card>
    </Page>
  );
}
