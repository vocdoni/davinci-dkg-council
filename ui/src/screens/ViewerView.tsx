/** Read-only view for someone with no role in this ceremony. */

import { Phase, type CeremonyView, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { useState } from 'react';
import { Page } from '../components/Layout';
import { PhaseBadge } from '../components/Lifecycle';
import { EyeIcon } from '../components/icons';
import { ConfirmingNote, KeyDots, Loading, Note } from '../components/ui';
import { bitCount, shortId, thresholdSentence } from '../lib/format';
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
    return (
      <Page>
        {poll.confirming ? (
          <ConfirmingNote />
        ) : poll.error ? (
          <Note tone="bad">We could not reach the public record: {poll.error}</Note>
        ) : (
          <Loading label="Looking up this committee…" />
        )}
      </Page>
    );
  }
  if (view.phase === Phase.None) {
    return (
      <Page>
        <Note tone="warn">No committee with this id exists here.</Note>
      </Page>
    );
  }
  return (
    <Page>
      <section className="card overflow-hidden">
        <div className="p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="eyebrow">Committee {shortId(cid)}</p>
              <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-ink">A key-holder committee</h1>
            </div>
            <PhaseBadge view={view} />
          </div>
          <p className="mt-4 text-[15px] leading-relaxed text-ink-2">{phaseSentence(view)}</p>
          {view.phase >= Phase.Dealing && view.phase !== Phase.Aborted && (
            <div className="mt-4 flex items-center gap-3">
              <KeyDots t={view.threshold} n={view.n} />
              <p className="text-sm text-muted">Once ready, {thresholdSentence(view.threshold, view.n)}.</p>
            </div>
          )}
        </div>
        <p className="flex gap-2.5 border-t border-line bg-paper/70 px-6 py-4 text-sm leading-relaxed text-muted sm:px-8">
          <EyeIcon size={18} className="mt-0.5" />
          <span>You are viewing this as a visitor. If you were invited, open the exact link you were sent.</span>
        </p>
      </section>
    </Page>
  );
}
