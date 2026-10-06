import { NotFinalizedYetError } from '@vocdoni/davinci-dkg-council-sdk';
import { useEffect, useRef, useState } from 'react';

export interface PollStatus {
  /** Last poll failure, cleared on the next success. */
  error: string | null;
  /**
   * The read hit a deployment the network has not confirmed (finalized) yet —
   * a transient wait right after deployment, never a failure. Polling keeps
   * going until the network catches up (~15 min on Sepolia, 1–2 min on Gnosis).
   */
  confirming: boolean;
}

/** Run an async poller every `ms` while mounted; failures land in the returned status. */
export function usePoll(fn: () => Promise<void>, ms: number, deps: unknown[]): PollStatus {
  const [status, setStatus] = useState<PollStatus>({ error: null, confirming: false });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        await fnRef.current();
        if (!stopped) setStatus({ error: null, confirming: false });
      } catch (err) {
        if (!stopped) {
          setStatus(
            err instanceof NotFinalizedYetError
              ? { error: null, confirming: true }
              : { error: err instanceof Error ? err.message : String(err), confirming: false },
          );
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), ms);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return status;
}
