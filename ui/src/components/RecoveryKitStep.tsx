/**
 * Forced recovery-kit save + rehearsal (protocol §5.3, architecture §6.3).
 *
 * The user must save the kit (file and/or printed words) and then prove it by
 * re-entering the full twelve words or re-importing the file; either path
 * re-derives the root and compares it with the kit's. Only then does `onDone`
 * fire. Skipping is not offered, and a failed print never counts as saved.
 */

import { parseKit, printableSheet, serializeKit, type KitFile } from '@vocdoni/davinci-dkg-council-sdk';
import { useMemo, useRef, useState } from 'react';
import { kitFileName, mnemonicMatchesKit } from '../flows/kit';
import { downloadTextFile, printTextSheet } from '../lib/download';
import { KEEP_WORDS_UNTIL_RESULTS } from '../lib/storage';
import { Button, Card, Note } from './ui';

export function WordGrid({ words, hidden }: { words: string[]; hidden?: Set<number> }) {
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {words.map((w, i) => (
        <li key={i} className="rounded-lg bg-paper px-3 py-2 font-mono text-sm">
          <span className="mr-2 text-ink/40">{i + 1}.</span>
          {hidden?.has(i) ? '••••••' : w}
        </li>
      ))}
    </ol>
  );
}

/**
 * `onDone` stores the key on this device (and may continue the flow); its rejection — a storage
 * write that never committed — keeps the person on the check step with the error, so a key is
 * never treated as saved before the browser confirmed it.
 */
export function RecoveryKitStep({ kit, onDone }: { kit: KitFile; onDone: () => void | Promise<void> }) {
  const words = useMemo(() => kit.private.mnemonic.split(' '), [kit]);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [entered, setEntered] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [storing, setStoring] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const done = () => {
    setStoring(true);
    setError(null);
    void Promise.resolve()
      .then(onDone)
      .catch((err: unknown) => {
        setError(
          `This device could not store your key (${err instanceof Error ? err.message : String(err)}). Nothing was sent. Free some space or allow this site to store data, then check again.`,
        );
      })
      .finally(() => setStoring(false));
  };

  const checkWords = () => {
    if (mnemonicMatchesKit(entered, kit)) done();
    else setError('Those words do not rebuild the same key. Check your sheet word by word and try again.');
  };

  const checkFile = (file: File) => {
    void file.text().then((text) => {
      try {
        const parsed = parseKit(text);
        if (!mnemonicMatchesKit(parsed.private.mnemonic, kit)) {
          setError('That file holds a different recovery kit. Pick the one you just saved.');
          return;
        }
        done();
      } catch {
        setError('That file is not a readable recovery kit. Pick the one you just saved.');
      }
    });
  };

  if (!checking) {
    return (
      <Card title="Save your recovery kit">
        <p className="mb-3 text-sm leading-relaxed">
          These twelve words are the only way back into your role if this device is lost. Save the file, or print
          the sheet — ideally both. Keep them private: anyone holding them can act as you. And if too many
          members lose their words, the committee can never open its results — no one can.
        </p>
        <p className="mb-3 text-sm font-medium leading-relaxed">{KEEP_WORDS_UNTIL_RESULTS}</p>
        <WordGrid words={words} />
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            onClick={() => {
              downloadTextFile(kitFileName(), serializeKit(kit));
              setSaved(true);
              setSaveError(null);
            }}
          >
            Download the kit file
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              if (printTextSheet('Council recovery words', printableSheet(kit.private.mnemonic))) {
                setSaved(true);
                setSaveError(null);
              } else {
                setSaveError('Printing did not open on this device — download the file instead.');
              }
            }}
          >
            Print the words
          </Button>
        </div>
        <p className="mt-2 text-xs text-ink/60">
          The kit is a small file — keep it with your documents, e.g. in your backed-up folder.
        </p>
        {saveError && (
          <div className="mt-3">
            <Note tone="bad">{saveError}</Note>
          </div>
        )}
        <div className="mt-4">
          <Button disabled={!saved} onClick={() => setChecking(true)}>
            I saved it — check me
          </Button>
          {!saved && <p className="mt-2 text-xs text-ink/60">Save or print first; there is no skipping this.</p>}
        </div>
      </Card>
    );
  }

  return (
    <Card title="Quick check">
      <p className="mb-3 text-sm leading-relaxed">
        Type all twelve words from your sheet, in order, or re-open the file you saved. We rebuild your key from
        what you type and make sure it is the same one.
      </p>
      <textarea
        className="w-full rounded-lg border border-ink/20 px-3 py-2 font-mono text-sm"
        rows={3}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-label="Your twelve recovery words"
        placeholder="word1 word2 word3 …"
        value={entered}
        onChange={(e) => {
          setEntered(e.target.value);
          setError(null);
        }}
      />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button disabled={storing} onClick={checkWords}>
          {storing ? 'Saving…' : 'Check the words'}
        </Button>
        <Button variant="secondary" onClick={() => fileRef.current?.click()}>
          Re-open the saved file instead
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) checkFile(f);
          }}
        />
        <Button variant="secondary" onClick={() => setChecking(false)}>
          Show the words again
        </Button>
      </div>
      {error && (
        <div className="mt-3">
          <Note tone="bad">{error}</Note>
        </div>
      )}
    </Card>
  );
}
