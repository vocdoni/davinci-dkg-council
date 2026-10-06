/**
 * /c/:cid — role resolution (architecture §6.2). The invite fragment is read
 * once and immediately stripped from the address bar; the secret never stays
 * in the URL or leaves the device.
 */

import { normalizeCeremonyId, parseInviteFragment, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApp } from '../App';
import { Note } from '../components/ui';
import { captureInviteFragment, peekInviteFragment } from '../lib/inviteCapture';
import { recordKey } from '../lib/records';
import { useServices } from '../services';
import { OrganizerView } from './OrganizerView';
import { JoinFlow, ParticipantView } from './ParticipantView';
import { ViewerView } from './ViewerView';

export function Ceremony() {
  const { cid: rawCid } = useParams();
  const { records } = useApp();
  const { config } = useServices();

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

  if (!cid) return <Note tone="bad">This link does not point to a committee.</Note>;

  const record = records.find((r) => r.key === recordKey(config.chainId, config.manager, cid));
  if (record?.role === 'organizer') return <OrganizerView record={record} />;
  if (record?.role === 'participant') return <ParticipantView record={record} />;
  if (invite) return <JoinFlow cid={cid} invite={invite} />;
  return <ViewerView cid={cid} />;
}
