/**
 * "Check your recovery kit" before the results can be opened (ops review P0). Months pass between
 * the key ceremony and the opening; a member who lost their words finds out on opening day, when
 * nothing can be done (no resharing). This card asks them to check the words now and again close
 * to the date (more insistently in the last two weeks), and offers a calendar file with both
 * reminders.
 */

import type { Hex, PhasePolicyView } from '@vocdoni/davinci-dkg-council-sdk';
import { useState } from 'react';
import { useApp } from '../App';
import { mnemonicMatches } from '../flows/kit';
import { reminderCalendar, upcomingOpening } from '../lib/calendar';
import { downloadTextFile } from '../lib/download';
import { dateWithUtc, shortId, timeLeft } from '../lib/format';
import { Button, Card, Note } from './ui';

const SOON_SECONDS = 14 * 86_400;

/** Re-type the twelve words and learn whether they rebuild the key on this device. */
export function WordsCheck({ mnemonic }: { mnemonic: string | null }) {
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState('');
  const [result, setResult] = useState<'ok' | 'bad' | null>(null);
  if (!mnemonic) {
    return (
      <Note tone="warn">
        Your key is not on this device. Restore it from your recovery kit well before the results open, so you
        know your words work.
      </Note>
    );
  }
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Check my words
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <textarea
        className="w-full rounded-lg border border-ink/20 px-3 py-2 font-mono text-sm"
        rows={3}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-label="Type your twelve recovery words to check them"
        placeholder="word1 word2 word3 …"
        value={entered}
        onChange={(e) => {
          setEntered(e.target.value);
          setResult(null);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={entered.trim() === ''}
          onClick={() => {
            setResult(mnemonicMatches(entered, mnemonic) ? 'ok' : 'bad');
            setEntered(''); // the words do not linger on screen
          }}
        >
          Check
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(false);
            setEntered('');
            setResult(null);
          }}
        >
          Close
        </Button>
      </div>
      {result === 'ok' && (
        <Note tone="ok">Those are the right words. Keep them safe until the results are opened.</Note>
      )}
      {result === 'bad' && (
        <Note tone="bad">
          Those words do not rebuild your key. Check your sheet word by word. If you cannot find the right words,
          tell whoever runs the committee now — not on the opening day.
        </Note>
      )}
    </div>
  );
}

export function OpeningReminder({
  cid,
  name,
  policy,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  cid: Hex;
  name?: string;
  policy: PhasePolicyView;
  nowSeconds?: number;
}) {
  const { mnemonic } = useApp();
  const opening = upcomingOpening(policy, nowSeconds);
  if (!opening) return null;
  const soon = opening.at - nowSeconds <= SOON_SECONDS;
  const committee = name || `Committee ${shortId(cid)}`;
  const link = `${window.location.origin}/c/${cid}`;
  const when = opening.scheduled
    ? `The results can be opened from ${dateWithUtc(opening.at)} (${timeLeft(opening.at, nowSeconds)}).`
    : `The organizer opens the results when ready — on ${dateWithUtc(opening.at)} at the latest (${timeLeft(opening.at, nowSeconds)}).`;
  return (
    <Card title={soon ? 'The results open soon — check your recovery words now' : 'Before the results open'}>
      {soon ? (
        <Note tone="warn">
          {when} Make sure your twelve words are at hand and right: without them, this device losing your key
          means you cannot help open the results.
        </Note>
      ) : (
        <p className="text-sm leading-relaxed">
          {when} Your twelve words are the only way back if this browser loses your key. Check that you still have
          them and that they are right — now, and again shortly before that date.
        </p>
      )}
      <div className="mt-3 space-y-3">
        <WordsCheck mnemonic={mnemonic} />
        <div>
          <Button
            variant="secondary"
            onClick={() =>
              downloadTextFile(
                `council-reminder-${cid.slice(2, 10)}.ics`,
                reminderCalendar({ openingAt: opening.at, committee, link, uid: cid, now: nowSeconds }),
                'text/calendar',
              )
            }
          >
            Add a reminder to my calendar
          </Button>
          <p className="mt-1 text-xs text-ink/60">
            The calendar file reminds you to check your words two weeks before the date, and of the date itself
            the day before. It holds the committee link only — nothing secret.
          </p>
        </div>
      </div>
    </Card>
  );
}
