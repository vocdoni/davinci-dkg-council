/**
 * Development-setup disclosure (ops P0): a persistent, non-dismissible banner on every page while
 * the deployment in view runs on a development circuit release — or on one this build does not
 * recognize. A development setup is the production beta's accepted trade-off: whoever made it
 * could fake contributions and openings, so the banner says so plainly. An unrecognized one cannot
 * be vouched for at all.
 */

import type { CircuitReleaseStatus } from '@vocdoni/davinci-dkg-council-sdk';
import { useEffect, useState } from 'react';
import { ONLY_DEVELOPMENT_RELEASES, readReleaseStatus } from '../lib/release';
import { useOptionalServices } from '../services';

/** `inline`: inside the page (a committee of another deployment than the one in the page header). */
export function SetupBanner({ inline = false }: { inline?: boolean }) {
  const services = useOptionalServices();
  const client = services?.client;
  const [status, setStatus] = useState<CircuitReleaseStatus | null>(null);

  useEffect(() => {
    if (!client) return;
    let live = true;
    void readReleaseStatus(client).then(
      (s) => live && setStatus(s),
      () => undefined, // unknown for now: the build's own pins decide below
    );
    return () => {
      live = false;
    };
  }, [client]);

  // Before (or without) the authenticated answer, a build that only pins development releases
  // can only be serving one.
  const kind = status ? (status.production ? null : status.known ? 'development' : 'unknown') : ONLY_DEVELOPMENT_RELEASES ? 'development' : null;
  if (!kind) return null;
  const tone = kind === 'development' ? 'border-warn/30 bg-warn-soft' : 'border-bad/30 bg-bad-soft';
  return (
    <div role="alert" className={`${inline ? 'mb-4 rounded-lg border' : 'border-b'} ${tone} text-ink`}>
      <div className={inline ? 'px-3 py-2 text-sm' : 'mx-auto max-w-3xl px-4 py-2 text-sm'}>
        <p className="font-semibold">
          {kind === 'development' ? 'Beta — development trusted setup' : 'Unrecognized setup — do not use for real elections'}
        </p>
        <p className="text-xs leading-relaxed text-ink/80">
          {kind === 'development'
            ? 'The checking files behind this beta were prepared by one team, not yet by a public ceremony with many independent people. Whoever prepared them could, in principle, fake contributions and results, so only use it for votes where you trust that team.'
            : 'This copy of the app does not recognize the checking files this deployment uses, so it cannot vouch for them.'}
          {status?.tag ? ` (${status.tag})` : ''}
        </p>
      </div>
    </div>
  );
}
