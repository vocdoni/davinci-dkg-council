/**
 * Pinned circuit artifacts: fetch + sha256 stream-verification + cache
 * (architecture §4, protocol §4.4). The sha256 pins are part of the SDK
 * release and are NOT overridable; only the download location is (CDN mirror).
 */

import { sha256 } from '@noble/hashes/sha2';
import type { Hex } from './types.js';

export interface ArtifactFile {
  /** Canonical download URL. */
  url: string;
  /** sha256 of the exact released file bytes, 0x-hex. */
  sha256: Hex;
}

export interface CircuitArtifactSet {
  wasm: ArtifactFile;
  zkey: ArtifactFile;
  vkey: ArtifactFile;
}

export interface ArtifactsRelease {
  release: string;
  deal: CircuitArtifactSet;
  partial: CircuitArtifactSet;
}

const UNPINNED: Hex = `0x${'0'.repeat(64)}`;

const BASE = 'https://github.com/vocdoni/davinci-dkg-council/releases/download/circuits-v1';

/**
 * The pinned release. Pins come from `circuits/release/release.json`
 * (circuitReleaseId 0x071a01deb1e9b5e5e1da302df14be234c5ee5b91603d7f0437852dbf1c665301).
 * NOTE: this is the DEVELOPMENT phase-2 setup ("one local snarkjs contribution
 * + beacon. NOT FOR PRODUCTION"); a production ceremony re-pins every hash.
 */
export const COUNCIL_ARTIFACTS: ArtifactsRelease = {
  release: 'circuits-v1',
  deal: {
    wasm: {
      url: `${BASE}/deal.wasm`,
      sha256: '0x1956a88d40344b23f039e0f20957d0bd9ad08fe4448997b29a15ce7ae68ca089',
    },
    zkey: {
      url: `${BASE}/deal_final.zkey`,
      sha256: '0x2f500df2886c17f91cbc7332518f4d501cfaee732d9577fb692962fc1a342e4b',
    },
    vkey: {
      url: `${BASE}/deal_vkey.json`,
      sha256: '0x329f3456ac194bf8f7e07974b7f782a8bcc797e2ce37e46dc357dd3dbd442444',
    },
  },
  partial: {
    wasm: {
      url: `${BASE}/partial.wasm`,
      sha256: '0x55aa433c9c3d472f01573323c2c1599bbd4874f8f0ae863ed3a4ace4dcf3d795',
    },
    zkey: {
      url: `${BASE}/partial_final.zkey`,
      sha256: '0x10567ac3b0b642f58cbc6785212d0cb4ddb7f22c3dd29aaa90ba1a6244756d52',
    },
    vkey: {
      url: `${BASE}/partial_vkey.json`,
      sha256: '0xae15a6c0ab9dfe26756aef8af8d7766c8d462bbeefae0847f513a2d317ad1991',
    },
  },
};

export interface FetchArtifactOptions {
  /** Replace the URL's directory with a mirror; the file name and pin stay. */
  baseUrl?: string;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /** Cache name for the browser Cache API (skipped when unavailable). */
  cacheName?: string;
}

const toHex = (bytes: Uint8Array): Hex =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

export function artifactUrl(file: ArtifactFile, baseUrl?: string): string {
  if (!baseUrl) return file.url;
  const name = file.url.slice(file.url.lastIndexOf('/') + 1);
  return `${baseUrl.replace(/\/$/, '')}/${name}`;
}

/** Verify bytes against an artifact pin; throws with both digests on mismatch. */
export function verifyArtifactBytes(file: ArtifactFile, bytes: Uint8Array): void {
  if (file.sha256 === UNPINNED) {
    throw new Error(`artifact ${file.url}: sha256 not pinned yet (pre-release SDK build)`);
  }
  const digest = toHex(sha256(bytes));
  if (digest !== file.sha256.toLowerCase()) {
    throw new Error(`artifact ${file.url}: sha256 mismatch (got ${digest}, pinned ${file.sha256})`);
  }
}

/**
 * Download one artifact, stream-hashing the body, and verify it against the
 * pin before returning the bytes. Uses the Cache API when present (browser);
 * a cached entry is still re-verified before use.
 */
export async function fetchArtifact(file: ArtifactFile, options: FetchArtifactOptions = {}): Promise<Uint8Array> {
  if (file.sha256 === UNPINNED) {
    throw new Error(`artifact ${file.url}: sha256 not pinned yet (pre-release SDK build)`);
  }
  const url = artifactUrl(file, options.baseUrl);
  const fetchFn = options.fetchFn ?? fetch;

  const cacheStore =
    'caches' in globalThis
      ? await (globalThis as { caches: CacheStorage }).caches.open(options.cacheName ?? 'davinci-dkg-council-artifacts-v1')
      : undefined;
  if (cacheStore) {
    const hit = await cacheStore.match(url);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      try {
        verifyArtifactBytes(file, bytes);
        return bytes;
      } catch {
        await cacheStore.delete(url); // corrupted cache entry; refetch
      }
    }
  }

  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`artifact ${url}: HTTP ${res.status}`);

  const hasher = sha256.create();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      chunks.push(value);
      total += value.length;
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    hasher.update(buf);
    chunks.push(buf);
    total = buf.length;
  }
  const digest = toHex(hasher.digest());
  if (digest !== file.sha256.toLowerCase()) {
    throw new Error(`artifact ${url}: sha256 mismatch (got ${digest}, pinned ${file.sha256})`);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  if (cacheStore) await cacheStore.put(url, new Response(bytes.slice().buffer));
  return bytes;
}
