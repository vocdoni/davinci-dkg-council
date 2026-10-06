/**
 * Invite-fragment hygiene (architecture §6.2): the invite secret rides in the
 * URL fragment. It is captured and wiped from the address bar *synchronously*
 * — `captureInviteFragment()` runs at bootstrap in `main.tsx`, before config
 * loading, storage init or any rendering, so a rejected or hanging start-up
 * never leaves the secret visible, in the history entry, or exposed to a
 * reload. The captured value lives in memory only, scoped to the path it
 * arrived on.
 */

interface Captured {
  fragment: string;
  path: string;
}

let captured: Captured | null = null;

/** Idempotent; also called defensively on first render and on /c/:cid mount. */
export function captureInviteFragment(): void {
  const h = window.location.hash;
  if (h.startsWith('#v1.')) {
    captured = { fragment: h, path: window.location.pathname };
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

/** The captured fragment, only for the path it was captured on. */
export function peekInviteFragment(forPath: string): string | null {
  return captured && captured.path === forPath ? captured.fragment : null;
}

/** Test hook: clear module state between tests. */
export function resetInviteFragmentForTests(): void {
  captured = null;
}
