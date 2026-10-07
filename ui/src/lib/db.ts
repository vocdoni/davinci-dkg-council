/** Minimal promise wrapper around IndexedDB (no dependencies). */

const DB_NAME = 'council';
const DB_VERSION = 1;

export const STORE_VAULT = 'vault';
export const STORE_CEREMONIES = 'ceremonies';
export const STORE_LABELS = 'labels';

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of [STORE_VAULT, STORE_CEREMONIES, STORE_LABELS]) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
  return dbPromise;
}

/**
 * Run one request in its own transaction and settle with the transaction, not the request: a
 * request can succeed and its transaction still abort before commit (quota exceeded, disk I/O,
 * the browser shutting down), so nothing written is reported as stored until `complete` fires.
 * `abort` and `error` reject. Writes ask for strict durability (flushed to disk before
 * `complete`) where the browser supports the option.
 */
function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let t: IDBTransaction;
        let req: IDBRequest<T>;
        try {
          t = mode === 'readwrite' ? db.transaction(store, mode, { durability: 'strict' }) : db.transaction(store, mode);
          req = run(t.objectStore(store));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        let result: T;
        let settled = false;
        const fail = (fallback: string) => {
          if (settled) return;
          settled = true;
          reject(t.error ?? req.error ?? new Error(fallback));
        };
        req.onsuccess = () => {
          result = req.result;
        };
        t.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        t.onabort = () => fail('indexedDB transaction aborted');
        t.onerror = () => fail('indexedDB transaction failed');
      }),
  );
}

export const idbGet = <T>(store: string, key: string): Promise<T | undefined> =>
  tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);

export const idbPut = (store: string, key: string, value: unknown): Promise<unknown> =>
  tx(store, 'readwrite', (s) => s.put(value, key));

export const idbDelete = (store: string, key: string): Promise<unknown> =>
  tx(store, 'readwrite', (s) => s.delete(key));

export const idbKeys = (store: string): Promise<string[]> =>
  tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()).then((keys) => keys.map(String));

export const idbGetAll = <T>(store: string): Promise<T[]> =>
  tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);

/** Test hook: drop the cached connection (fake-indexeddb resets between tests). */
export function resetDbForTests(): void {
  dbPromise = undefined;
}
