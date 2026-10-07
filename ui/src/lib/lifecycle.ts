/** Where a committee stands, as steps for the progress indicator. Display only. */

import { Phase, type CeremonyView } from '@vocdoni/davinci-dkg-council-sdk';
import type { Step, StepState } from '../components/ui';

const at = (labels: string[], current: number): Step[] =>
  labels.map((label, i) => ({ label, state: (i < current ? 'done' : i === current ? 'current' : 'todo') as StepState }));

/**
 * The organizer's path: create → invite → members join → key ready → (connect to Elections) →
 * open results. `view` undefined = still in the creation wizard.
 */
export function organizerSteps(opts: {
  view?: CeremonyView;
  davinci: boolean;
  connected: boolean;
  resultsOpen: boolean;
}): Step[] {
  const labels = ['Create', 'Invite', 'Members join', 'Key ready', ...(opts.davinci ? ['Connect to Elections'] : []), 'Open results'];
  const { view } = opts;
  if (!view) return at(labels, 0);
  if (view.phase === (Phase.Registration as number)) return at(labels, view.joinedCount > 0 ? 2 : 1);
  if (view.phase === (Phase.Dealing as number)) return at(labels, 2);
  // Live: the key is ready; next is the Elections connection (when offered), then the opening.
  if (opts.davinci && !opts.connected) return at(labels, 4);
  return at(labels, opts.resultsOpen ? labels.length : labels.length - 1);
}

/** A member's path: join → add your part → key ready → open results. `view` undefined = invitation. */
export function memberSteps(opts: { view?: CeremonyView; dealt?: boolean }): Step[] {
  const labels = ['Join', 'Add your part', 'Key ready', 'Open results'];
  const { view } = opts;
  if (!view || view.phase === (Phase.Registration as number)) return at(labels, view ? 1 : 0);
  if (view.phase === (Phase.Dealing as number)) return at(labels, opts.dealt ? 2 : 1);
  return at(labels, 3);
}
