/**
 * The trust status of a deployment's circuit release (development-setup disclosure).
 *
 * The manager's `circuitReleaseId` is read through the authenticated client and looked up in the
 * SDK's pins. A development setup (one local phase-2 contribution) can be forged by whoever ran
 * it, so the app says so on every page while such a deployment is in use. Until the read answers,
 * a build whose every pinned release is a development one shows the warning anyway: it cannot work
 * with anything else.
 */

import {
  circuitReleaseById,
  circuitReleaseStatus,
  KNOWN_CIRCUIT_RELEASES,
  type CircuitReleaseInfo,
  type CircuitReleaseStatus,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { ChainReader } from './chain';

/** True when every release this build pins is a development setup. */
export const ONLY_DEVELOPMENT_RELEASES = KNOWN_CIRCUIT_RELEASES.every((r) => r.developmentSetup);

const statusByClient = new WeakMap<ChainReader, Promise<CircuitReleaseStatus>>();

/** The deployment's release status, read once per client (a failed read is retried on the next call). */
export function readReleaseStatus(client: ChainReader): Promise<CircuitReleaseStatus> {
  let p = statusByClient.get(client);
  if (!p) {
    p = client.getCircuitReleaseId().then(circuitReleaseStatus);
    p.catch(() => statusByClient.delete(client));
    statusByClient.set(client, p);
  }
  return p;
}

/** The pinned files of the deployment's release, or a plain refusal when this build does not have them. */
export async function releaseArtifacts(client: ChainReader): Promise<CircuitReleaseInfo> {
  const status = await readReleaseStatus(client);
  const release = circuitReleaseById(status.id);
  if (!release) {
    throw new Error(
      'this committee uses checking files this copy of the app does not have — open the link you were given for it, or tell whoever runs this app',
    );
  }
  return release;
}
