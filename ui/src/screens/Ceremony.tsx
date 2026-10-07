/**
 * /c/:cid — role resolution (architecture §6.2). The invite fragment is read
 * once and immediately stripped from the address bar; the secret never stays
 * in the URL or leaves the device.
 *
 * A committee belongs to exactly one deployment (its id commits to the
 * manager). A local record names it; otherwise every deployment this copy
 * serves is asked, current first, so links and kits of committees made
 * before a redeploy keep working on the same origin. Everything below is
 * rendered with that deployment's services.
 */

import { normalizeCeremonyId, parseInviteFragment, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApp } from '../App';
import { Note, Spinner } from '../components/ui';
import { readCeremony } from '../lib/chain';
import { captureInviteFragment, peekInviteFragment } from '../lib/inviteCapture';
import type { CeremonyRecord } from '../lib/records';
import { probeTiming, type Deployments } from '../deployments';
import { ServicesProvider, useDeployments, type Services } from '../services';
import { OrganizerView } from './OrganizerView';
import { JoinFlow, ParticipantView } from './ParticipantView';
import { ViewerView } from './ViewerView';

/**
 * The deployment holding `cid` when no local record names it: the first served deployment whose
 * finalized state knows the committee. While every deployment answers "unknown" (the
 * authenticated view reverts `UnknownCeremony()`) the current one is shown provisionally — a
 * committee created moments ago, or none at all; the screens below say which — and the lookup
 * goes on until one deployment knows it. A read that fails is not an answer: the spinner stays
 * and the lookup retries.
 */
function useProbedDeployment(
  deployments: Deployments,
  cid: Hex | null,
  skip: boolean,
): { services: Services | null; error: string | null } {
  const single = deployments.list.length === 1;
  const [found, setFound] = useState<Services | null>(single ? deployments.current : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (skip || single || !cid) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = async () => {
      let failure: unknown = null;
      for (const d of deployments.list) {
        const services = deployments.forManager(d.manager);
        if (!services) continue;
        try {
          if (await readCeremony(services.client, cid)) {
            if (live) {
              setFound(services);
              setError(null);
            }
            return;
          }
        } catch (err) {
          failure ??= err;
        }
      }
      if (!live) return;
      if (failure === null) {
        // Unknown everywhere at this finalized block: provisional, not an answer.
        setFound((f) => f ?? deployments.current);
        setError(null);
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
      timer = setTimeout(() => void probe(), probeTiming.retryMs);
    };
    setFound(null);
    void probe();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [deployments, cid, skip, single]);
  return { services: found, error };
}

export function Ceremony() {
  const { cid: rawCid } = useParams();
  const { records } = useApp();
  const deployments = useDeployments();
  const chainId = deployments.current.config.chainId;

  const cid = useMemo<Hex | null>(() => {
    try {
      return normalizeCeremonyId(rawCid ?? '');
    } catch {
      return null;
    }
  }, [rawCid]);

  // The invite capability was captured and stripped synchronously at
  // bootstrap (main.tsx / inviteCapture.ts); read it from memory here. The
  // extra capture call is a defensive no-op backstop for in-app navigations.
  const [invite] = useState(() => {
    captureInviteFragment();
    const fragment = peekInviteFragment(window.location.pathname);
    if (!fragment) return null;
    try {
      return parseInviteFragment(fragment);
    } catch {
      return null;
    }
  });

  const mine = records.filter((r) => cid !== null && r.chainId === chainId && r.cid.toLowerCase() === cid);
  const record: CeremonyRecord | undefined = mine.find((r) => deployments.forManager(r.manager) !== undefined);
  const probe = useProbedDeployment(deployments, cid, record !== undefined);

  if (!cid) return <Note tone="bad">This link does not point to a committee.</Note>;
  if (!record && mine.length > 0) {
    return (
      <Note tone="warn">
        This committee was made with a different copy of this app — open the link you were given for it.
      </Note>
    );
  }

  const services = record ? deployments.forManager(record.manager) : probe.services;
  if (!services) {
    return probe.error ? (
      <Note tone="bad">We could not reach the public record: {probe.error}. Trying again…</Note>
    ) : (
      <Spinner label="Looking up this committee…" />
    );
  }
  const ref = deployments.list.find((d) => d.manager.toLowerCase() === services.config.manager.toLowerCase());

  return (
    // Keyed: a provisional lookup that switches deployment restarts the screens on the new one.
    <ServicesProvider key={services.config.manager} services={services}>
      {ref?.legacy && (
        <div className="mb-4">
          <Note tone="info">
            This committee was set up with an earlier version of this service
            {ref.label ? ` (${ref.label})` : ''}. It keeps working here until its results are opened.
          </Note>
        </div>
      )}
      {record?.role === 'organizer' ? (
        <OrganizerView record={record} />
      ) : record?.role === 'participant' ? (
        <ParticipantView record={record} />
      ) : invite ? (
        <JoinFlow cid={cid} invite={invite} />
      ) : (
        <ViewerView cid={cid} />
      )}
    </ServicesProvider>
  );
}
