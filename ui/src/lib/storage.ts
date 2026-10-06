/**
 * Persistent storage for this site's data (architecture §6.4).
 *
 * The twelve words are the only way back into a role, but members open the app rarely: they join,
 * contribute, then return weeks or months later to unlock results. Browsers evict "best-effort"
 * site data under storage pressure, and Safari deletes all script-written storage of a site after
 * about seven days of use without a visit to it. `navigator.storage.persist()` asks the browser to
 * keep this site's data until the user deletes it; browsers may refuse silently (Chrome decides by
 * engagement, Firefox asks the person, Safari grants it only to home-screen apps). The app asks
 * once a key is stored and shows the answer on the member's page; the recovery words remain the
 * guarantee either way.
 */

/** `persistent`: kept until the user deletes it. `best-effort`: the browser may delete it. */
export type StorageState = 'persistent' | 'best-effort' | 'unknown';

type StorageManagerLike = Pick<StorageManager, 'persist' | 'persisted'>;

const storageManager = (): StorageManagerLike | undefined => {
  const s = typeof navigator === 'undefined' ? undefined : (navigator.storage as StorageManagerLike | undefined);
  return s && typeof s.persisted === 'function' && typeof s.persist === 'function' ? s : undefined;
};

/** Whether this site's data is kept until the user deletes it. Never throws. */
export async function storageState(): Promise<StorageState> {
  const s = storageManager();
  if (!s) return 'unknown';
  try {
    return (await s.persisted()) ? 'persistent' : 'best-effort';
  } catch {
    return 'unknown';
  }
}

/**
 * Ask the browser to keep this site's data (a no-op when it already does). A refusal, an
 * exception or a browser without the API all resolve to the state as it is; nothing is blocked.
 */
export async function requestPersistentStorage(): Promise<StorageState> {
  const s = storageManager();
  if (!s) return 'unknown';
  try {
    if (await s.persisted()) return 'persistent';
    return (await s.persist()) ? 'persistent' : 'best-effort';
  } catch {
    return storageState();
  }
}

/** The reminder shown wherever the words come up (join, after contributing, the kit card). */
export const KEEP_WORDS_UNTIL_RESULTS =
  'Keep your twelve words until the results are opened: browsers can delete this site’s data — Safari does after about a week without a visit — and the words are then the only way back.';
