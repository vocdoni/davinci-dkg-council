/**
 * The root vault (architecture §6.4 `council.root.v1`).
 *
 * The 12-word root is encrypted at rest with a non-extractable WebCrypto
 * AES-GCM key that itself lives only inside IndexedDB (the browser never
 * exposes its bytes). Local storage is a cache: the recovery kit is the
 * source of truth, and clearing the browser loses nothing the kit plus chain
 * state cannot restore.
 */

import { idbDelete, idbGet, idbPut, STORE_VAULT } from './db';

const KEY_ID = 'council.root.key.v1';
const ROOT_ID = 'council.root.v1';

interface EncryptedRoot {
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

/** Storage indirection so unit tests can swap IndexedDB out. */
export interface VaultStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

const idbStore: VaultStore = {
  get: (key) => idbGet(STORE_VAULT, key),
  put: (key, value) => idbPut(STORE_VAULT, key, value),
  delete: (key) => idbDelete(STORE_VAULT, key),
};

async function vaultKey(store: VaultStore): Promise<CryptoKey> {
  const existing = (await store.get(KEY_ID)) as CryptoKey | undefined;
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, /* extractable */ false, [
    'encrypt',
    'decrypt',
  ]);
  await store.put(KEY_ID, key);
  return key;
}

/** Encrypt and persist the root mnemonic. */
export async function saveRoot(mnemonic: string, store: VaultStore = idbStore): Promise<void> {
  const key = await vaultKey(store);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(mnemonic));
  const record: EncryptedRoot = { iv, ciphertext };
  await store.put(ROOT_ID, record);
}

/** Load and decrypt the root mnemonic, or null when none is stored. */
export async function loadRoot(store: VaultStore = idbStore): Promise<string | null> {
  const record = (await store.get(ROOT_ID)) as EncryptedRoot | undefined;
  if (!record) return null;
  const key = (await store.get(KEY_ID)) as CryptoKey | undefined;
  if (!key) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv as BufferSource }, key, record.ciphertext);
    return new TextDecoder().decode(plain);
  } catch {
    return null; // corrupted at-rest data; the recovery kit is the source of truth
  }
}

export async function hasRoot(store: VaultStore = idbStore): Promise<boolean> {
  return (await store.get(ROOT_ID)) !== undefined;
}

/**
 * Set the current encrypted root aside under a dated id before a different
 * root takes its place (restore-switch, §5.3). Nothing is destroyed: the
 * archived blob stays decryptable under the same device key, and the recovery
 * kit remains the real way back.
 */
export async function archiveRoot(store: VaultStore = idbStore): Promise<void> {
  const record = await store.get(ROOT_ID);
  if (record !== undefined) await store.put(`${ROOT_ID}.archived.${Date.now()}`, record);
}

/** Forget the stored root (the recovery kit remains the source of truth). */
export async function clearRoot(store: VaultStore = idbStore): Promise<void> {
  await store.delete(ROOT_ID);
  await store.delete(KEY_ID);
}
