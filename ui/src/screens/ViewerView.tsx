/** Read-only view for someone with no role in this ceremony. */

import { Phase, type CeremonyView, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { useState } from 'react';
import { Card, ConfirmingNote, Note, Spinner } from '../components/ui';
import { bitCount, thresholdSentence } from '../lib/format';
import { usePoll } from '../lib/hooks';
import { useServices } from '../services';

export function phaseSentence(view: CeremonyView): string {
  switch (view.phase) {
    case Phase.Registration:
      return `Invitations are out: ${view.joinedCount} of ${view.inviteCount} people have joined so far.`;
    case Phase.Dealing:
      return `The member list is locked; ${bitCount(view.qualBitmap)} of ${view.n} contributions are in.`;
    case Phase.Live:
      return 'The shared key is ready and in use.';
    case Phase.Aborted:
      return 'This committee was called off before its key was finished.';
    default:
      return 'This committee does not exist here.';
  }
}

export function ViewerView({ cid }: { cid: Hex }) {
  const { client } = useServices();
  const [view, setView] = useState<CeremonyView | null>(null);
  const poll = usePoll(
    async () => {
      setView(await client.getCeremony(cid));
    },
    8000,
    [cid],
  );

  if (!view) {
    if (poll.confirming) return <ConfirmingNote />;
    return poll.error ? <Note tone="bad">We could not reach the public record: {poll.error}</Note> : <Spinner label="Looking up this committee…" />;
  }
  if (view.phase === Phase.None) return <Note tone="warn">No committee with this id exists here.</Note>;
  return (
    <Card title="A key-holder committee">
      <p className="text-sm leading-relaxed">{phaseSentence(view)}</p>
      {view.phase >= Phase.Dealing && view.phase !== Phase.Aborted && (
        <p className="mt-2 text-sm text-ink/70">Once ready, {thresholdSentence(view.threshold, view.n)}.</p>
      )}
      <p className="mt-3 text-xs text-ink/50">
        You are viewing this as a visitor. If you were invited, open the exact link you were sent.
      </p>
    </Card>
  );
}
