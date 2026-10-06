import { describe, expect, it } from 'vitest';
import { clearRoot, loadRoot, saveRoot, type VaultStore } from '../src/lib/vault';

/** In-memory store (fake-indexeddb cannot structured-clone CryptoKey). */
function memStore(): VaultStore {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k),
    put: async (k, v) => m.set(k, v),
    delete: async (k) => m.delete(k),
  };
}

describe('vault', () => {
  it('round-trips the mnemonic through an encrypted record', async () => {
    const store = memStore();
    expect(await loadRoot(store)).toBeNull();
    await saveRoot('abandon ability able about above absent absorb abstract absurd abuse access accident', store);
    expect(await loadRoot(store)).toMatch(/^abandon ability/);
    await clearRoot(store);
    expect(await loadRoot(store)).toBeNull();
  });

  it('stores ciphertext, not the words', async () => {
    const seen: unknown[] = [];
    const inner = memStore();
    const spying: VaultStore = {
      get: inner.get,
      delete: inner.delete,
      put: async (k, v) => {
        seen.push(v);
        return inner.put(k, v);
      },
    };
    await saveRoot('correct horse battery staple one two three four five six seven eight', spying);
    const serialized = JSON.stringify(seen, (_k, v: unknown) =>
      v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)).join(',') : v,
    );
    expect(serialized).not.toContain('battery');
  });
});
