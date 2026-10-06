/** Re-download / re-print the recovery kit; nudges when the manifest grew. */

import { printableSheet, serializeKit } from '@vocdoni/davinci-dkg-council-sdk';
import { useMemo, useState } from 'react';
import { useApp } from '../App';
import { buildKitForRecords, kitFileName, manifestFingerprint } from '../flows/kit';
import { downloadTextFile, printTextSheet } from '../lib/download';
import { KEEP_WORDS_UNTIL_RESULTS } from '../lib/storage';
import { updateRecord, type CeremonyRecord } from '../lib/records';
import { Button, Card, Note } from './ui';

export function KitCard({ record }: { record: CeremonyRecord }) {
  const { mnemonic, records, refreshRecords } = useApp();
  const [printError, setPrintError] = useState<string | null>(null);
  const kit = useMemo(() => {
    if (!mnemonic) return null;
    try {
      const extras = record.approvedRosterHash ? { [record.key]: { rosterHash: record.approvedRosterHash } } : {};
      return buildKitForRecords(mnemonic, records, extras);
    } catch {
      return null;
    }
  }, [mnemonic, records, record]);

  if (!mnemonic || !kit) {
    return (
      <Card title="Recovery kit">
        <Note tone="warn">
          Your key is not on this device. Restore it from your recovery kit first (menu on the start page).
        </Note>
      </Card>
    );
  }

  const fingerprint = manifestFingerprint(kit.manifest);
  // Three distinct prompts, never a generic cry-wolf (UX review P0-1): a
  // device with no saved kit (restored from words), the one-time nudge after
  // joining, and a manifest that genuinely covers more than the saved kit.
  const neverSaved = record.kitExportFingerprint === undefined;
  const joinNudge = !neverSaved && record.kitJoinNudge === true;
  const stale = !neverSaved && !joinNudge && record.kitExportFingerprint !== fingerprint;
  const markExported = async () => {
    await updateRecord(record.chainId, record.manager, record.cid, {
      kitExportFingerprint: fingerprint,
      kitJoinNudge: false,
    });
    await refreshRecords();
  };

  return (
    <Card title="Recovery kit">
      {neverSaved && (
        <div className="mb-3">
          <Note tone="info">This device has no saved kit yet. Download one now in case you lose this browser.</Note>
        </div>
      )}
      {joinNudge && (
        <div className="mb-3">
          <Note tone="warn">
            You joined this committee after saving your kit. Save it once more so your kit knows about your new
            role — then you’re done.
          </Note>
        </div>
      )}
      {stale && (
        <div className="mb-3">
          <Note tone="warn">Your saved kit does not cover everything on this device yet — save a fresh copy.</Note>
        </div>
      )}
      <p className="mb-3 text-sm leading-relaxed">{KEEP_WORDS_UNTIL_RESULTS}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            downloadTextFile(kitFileName(), serializeKit(kit));
            void markExported();
          }}
        >
          Download the kit file
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            if (printTextSheet('Council recovery words', printableSheet(kit.private.mnemonic))) {
              setPrintError(null);
              void markExported();
            } else {
              setPrintError('Printing did not open on this device — download the file instead.');
            }
          }}
        >
          Print the words
        </Button>
      </div>
      {printError && (
        <div className="mt-3">
          <Note tone="bad">{printError}</Note>
        </div>
      )}
    </Card>
  );
}
