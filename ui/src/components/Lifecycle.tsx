/**
 * Where a committee stands, for the step indicator and the status badge at the top of every
 * committee screen. Display only: every decision stays with the screens' own state reads.
 */

import { Phase, type CeremonyView } from '@vocdoni/davinci-dkg-council-sdk';
import type { ReactNode } from 'react';
import { Badge, Steps, type Step } from './ui';

export function LifecycleSteps({ steps }: { steps: Step[] }) {
  return <Steps steps={steps} label="Committee progress" />;
}

/** The committee's phase as one short badge. */
export function PhaseBadge({ view, resultsOpen = false }: { view: CeremonyView; resultsOpen?: boolean }) {
  switch (view.phase) {
    case Phase.Registration:
      return (
        <Badge tone="info" dot>
          Joining open
        </Badge>
      );
    case Phase.Dealing:
      return (
        <Badge tone="warn" dot>
          Making the key
        </Badge>
      );
    case Phase.Live:
      return resultsOpen ? (
        <Badge tone="dark" dot>
          Results can be opened
        </Badge>
      ) : (
        <Badge tone="ok" dot>
          Key ready
        </Badge>
      );
    case Phase.Aborted:
      return <Badge tone="bad">Called off</Badge>;
    default:
      return <Badge>Not found</Badge>;
  }
}

/**
 * The top of a committee screen: who you are here, the committee's name and phase, a few status
 * lines, and the step indicator.
 */
export function CommitteeHeader({
  eyebrow,
  title,
  view,
  resultsOpen,
  steps,
  children,
  footer,
}: {
  eyebrow: ReactNode;
  title: string;
  view: CeremonyView;
  resultsOpen?: boolean;
  steps?: Step[];
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="eyebrow">{eyebrow}</p>
            <h1 className="mt-1.5 text-2xl leading-tight font-semibold tracking-tight break-words text-ink sm:text-[28px]">
              {title}
            </h1>
          </div>
          <div className="pt-0.5">
            <PhaseBadge view={view} resultsOpen={resultsOpen} />
          </div>
        </div>
        {children && <div className="mt-3 space-y-2 text-[15px] leading-relaxed text-ink-2">{children}</div>}
      </div>
      {steps && (
        <div className="border-t border-line px-3 pt-5 pb-5 sm:px-7">
          <LifecycleSteps steps={steps} />
        </div>
      )}
      {footer && <div className="border-t border-line bg-paper/70 px-5 py-4 sm:px-7">{footer}</div>}
    </div>
  );
}
