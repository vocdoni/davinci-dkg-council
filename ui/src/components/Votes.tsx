/** Shared bits of the vote lists on the organizer and member screens. Display only. */

import type { ReactNode } from 'react';
import { LockIcon } from './icons';
import { Badge } from './ui';

/** One short badge for where a vote stands. */
export function VoteBadge({
  ready,
  notSubmitted,
  gateOpen,
  turned,
  needed,
}: {
  ready: boolean;
  notSubmitted: boolean;
  gateOpen: boolean;
  turned: number;
  needed: number;
}) {
  if (ready) {
    return (
      <Badge tone="ok" dot>
        Results open
      </Badge>
    );
  }
  if (notSubmitted) return <Badge>Waiting for the vote</Badge>;
  if (!gateOpen) {
    return (
      <Badge>
        <LockIcon size={12} strokeWidth={2.25} />
        Locked
      </Badge>
    );
  }
  return (
    <Badge tone="info" dot>
      {Math.min(turned, needed)}/{needed} keys turned
    </Badge>
  );
}

/** The decrypted values as tiles, in ballot order (the sentence above them says the same in words). */
export function ResultValues({ values }: { values: bigint[] }) {
  if (values.length === 0) return null;
  return (
    <div aria-hidden="true" className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
      {values.map((v, i) => (
        <div key={i} className="rounded-lg border border-line bg-paper px-3 py-2">
          <div className="text-[11px] font-medium tracking-wide text-faint uppercase">Answer {i + 1}</div>
          <div className="mt-0.5 text-lg font-semibold text-ink tabular-nums">{v.toString(10)}</div>
        </div>
      ))}
    </div>
  );
}

/** A quiet placeholder for an empty list. */
export function EmptyState({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line-strong px-5 py-8 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-wash text-muted">{icon}</span>
      <div className="max-w-sm text-sm leading-relaxed text-muted">{children}</div>
    </div>
  );
}
