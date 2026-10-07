/** Whether this browser keeps the site's data, on the member's page (architecture §6.4). */

import { useEffect, useState } from 'react';
import { requestPersistentStorage, storageState, type StorageState } from '../lib/storage';
import { Button, Note } from './ui';

export function StorageNote() {
  const [state, setState] = useState<StorageState | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let live = true;
    void storageState().then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, []);

  if (state === null) return null;
  if (state === 'persistent') {
    return (
      <Note tone="ok">
        <p className="font-semibold">This browser keeps your key for this site until you delete it.</p>
        <p className="mt-1">Still keep your twelve words until the results are opened — they work on any device.</p>
      </Note>
    );
  }
  return (
    <Note tone="warn">
      <p className="font-semibold">This browser may delete what this site stores, your key included.</p>
      <p className="mt-1">
        Safari does after about a week without a visit; other browsers may when space runs low. Keep your twelve
        words until the results are opened: with them and the committee link you can always come back.
      </p>
      {state === 'best-effort' && !asked && (
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setAsked(true);
              void requestPersistentStorage().then(setState);
            }}
          >
            Ask this browser to keep it
          </Button>
        </div>
      )}
      {asked && <p className="mt-2">This browser did not agree to keep it — your twelve words are what count.</p>}
    </Note>
  );
}
