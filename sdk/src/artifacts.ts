/**
 * Pinned circuit artifacts: fetch + sha256 stream-verification + cache
 * (architecture §4, protocol §4.4). The sha256 pins are part of the SDK
 * release and are NOT overridable; only the download location is (CDN
 * mirrors, tried in order — any copy that hashes to the pin is as good as
 * the original).
 *
 * Every release also carries its trust status: `developmentSetup` marks a
 * development trusted setup (one local phase-2 contribution) whose holder
 * could forge proofs. `circuitReleaseStatus(id)` maps a manager's on-chain
 * `circuitReleaseId` to that status so apps can warn on such deployments.
 */

import { sha256 } from '@noble/hashes/sha2';
import { circuitReleaseId } from './encoding.js';
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
  /**
   * A development trusted setup (one local snarkjs phase-2 contribution, see
   * `circuits/release/release.json` `setup`): whoever holds its toxic waste
   * could forge dealings and partial decryptions. Rehearsals only — never a
   * real election. False only for a verified multi-party phase 2.
   */
  developmentSetup: boolean;
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
  developmentSetup: true,
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

/** A release this SDK pins, with its on-chain id (protocol §4.4). */
export interface CircuitReleaseInfo extends ArtifactsRelease {
  /** circuitReleaseId = K(circuit-release, sha256(deal vkey), sha256(partial vkey)). */
  id: Hex;
}

const withId = (r: ArtifactsRelease): CircuitReleaseInfo => ({
  ...r,
  id: circuitReleaseId(r.deal.vkey.sha256, r.partial.vkey.sha256),
});

/**
 * Every circuit release this SDK build can prove for, current first. A
 * retired release stays listed (pins unchanged) for as long as deployments
 * using it may still open results.
 */
export const KNOWN_CIRCUIT_RELEASES: readonly CircuitReleaseInfo[] = [withId(COUNCIL_ARTIFACTS)];

/** The pinned release with this on-chain id, or undefined when this SDK does not know it. */
export function circuitReleaseById(id: Hex): CircuitReleaseInfo | undefined {
  return KNOWN_CIRCUIT_RELEASES.find((r) => r.id.toLowerCase() === id.toLowerCase());
}

/** What an app should say about a deployment's circuit release. */
export interface CircuitReleaseStatus {
  id: Hex;
  /** This SDK pins the release (it can prove for it). */
  known: boolean;
  tag?: string;
  /** True for a development setup; undefined when the release is unknown. */
  developmentSetup?: boolean;
  /** Fit for real elections: a known release from a production (multi-party) setup. */
  production: boolean;
}

/**
 * The trust status of a manager's on-chain `circuitReleaseId` (read it
 * authenticated, e.g. `CouncilClient.getCircuitReleaseStatus`). An unknown
 * release is never `production`.
 */
export function circuitReleaseStatus(id: Hex): CircuitReleaseStatus {
  const r = circuitReleaseById(id);
  if (!r) return { id, known: false, production: false };
  return { id: r.id, known: true, tag: r.release, developmentSetup: r.developmentSetup, production: !r.developmentSetup };
}

export interface FetchArtifactOptions {
  /** Replace the URL's directory with a mirror; the file name and pin stay. */
  baseUrl?: string;
  /**
   * Mirrors tried in order (after `baseUrl`, when both are given): a mirror
   * that is down, answers an error or serves bytes that do not match the pin
   * is skipped. Empty/absent: the canonical URL. `{release}` in a base URL
   * is replaced with `release`.
   */
  baseUrls?: readonly string[];
  /** Release tag substituted for `{release}` in mirror base URLs. */
  release?: string;
  /**
   * A mirror that sends no data for this long (no headers, or a stalled body) is skipped
   * (default 30 s). Slow but steady downloads are never cut.
   */
  stallTimeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /** Cache name for the browser Cache API (skipped when unavailable). */
  cacheName?: string;
}

const toHex = (bytes: Uint8Array): Hex =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

export function artifactUrl(file: ArtifactFile, baseUrl?: string, release?: string): string {
  if (!baseUrl) return file.url;
  const name = file.url.slice(file.url.lastIndexOf('/') + 1);
  const base = release === undefined ? baseUrl : baseUrl.split('{release}').join(release);
  return `${base.replace(/\/$/, '')}/${name}`;
}

/** The download candidates for one file, in the order `fetchArtifact` tries them. */
export function artifactUrls(file: ArtifactFile, options: Pick<FetchArtifactOptions, 'baseUrl' | 'baseUrls' | 'release'> = {}): string[] {
  const bases = [...(options.baseUrl ? [options.baseUrl] : []), ...(options.baseUrls ?? [])].filter((b) => b.trim() !== '');
  const urls = bases.length === 0 ? [file.url] : bases.map((b) => artifactUrl(file, b, options.release));
  return [...new Set(urls)];
}

/** Every mirror failed; `failures` says why each one was skipped, in order. */
export class ArtifactUnavailableError extends Error {
  constructor(
    readonly file: ArtifactFile,
    readonly failures: { url: string; reason: string }[],
  ) {
    super(
      `artifact ${file.url.slice(file.url.lastIndexOf('/') + 1)}: no mirror served the pinned file (` +
        failures.map((f) => `${f.url}: ${f.reason}`).join('; ') +
        ')',
    );
    this.name = 'ArtifactUnavailableError';
  }
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
 * pin before returning the bytes. Mirrors are tried in order; a failed or
 * mismatching one is skipped, and only when none serves the pinned bytes
 * does this throw (`ArtifactUnavailableError` for several mirrors, the single
 * failure otherwise). Uses the Cache API when present (browser), keyed by the
 * canonical URL; a cached entry is still re-verified before use.
 */
export async function fetchArtifact(file: ArtifactFile, options: FetchArtifactOptions = {}): Promise<Uint8Array> {
  if (file.sha256 === UNPINNED) {
    throw new Error(`artifact ${file.url}: sha256 not pinned yet (pre-release SDK build)`);
  }
  const fetchFn = options.fetchFn ?? fetch;

  const cacheStore =
    'caches' in globalThis
      ? await (globalThis as { caches: CacheStorage }).caches.open(options.cacheName ?? 'davinci-dkg-council-artifacts-v1')
      : undefined;
  if (cacheStore) {
    const hit = await cacheStore.match(file.url);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      try {
        verifyArtifactBytes(file, bytes);
        return bytes;
      } catch {
        await cacheStore.delete(file.url); // corrupted cache entry; refetch
      }
    }
  }

  const urls = artifactUrls(file, options);
  const failures: { url: string; reason: string; error: unknown }[] = [];
  for (const url of urls) {
    let bytes: Uint8Array;
    try {
      bytes = await downloadVerified(file, url, fetchFn, options.stallTimeoutMs ?? 30_000);
    } catch (error) {
      failures.push({ url, reason: error instanceof Error ? error.message : String(error), error });
      continue;
    }
    if (cacheStore) await cacheStore.put(file.url, new Response(bytes.slice().buffer));
    return bytes;
  }
  if (failures.length === 1) throw failures[0]?.error;
  throw new ArtifactUnavailableError(
    file,
    failures.map(({ url, reason }) => ({ url, reason })),
  );
}

async function downloadVerified(
  file: ArtifactFile,
  url: string,
  fetchFn: typeof fetch,
  stallMs: number,
): Promise<Uint8Array> {
  const ctl = new AbortController();
  const stalled = () => new Error(`artifact ${url}: no data for ${Math.round(stallMs / 1000)} s — skipped`);
  let timer = setTimeout(() => ctl.abort(), stallMs);
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(), stallMs);
  };
  // Settles every await below on a stall, even with a fetch that ignores the signal.
  const aborted = new Promise<never>((_, reject) => ctl.signal.addEventListener('abort', () => reject(stalled())));
  aborted.catch(() => undefined);
  const within = <T>(p: Promise<T>): Promise<T> => Promise.race([p, aborted]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const res = await within(fetchFn(url, { signal: ctl.signal }));
    progress();
    if (!res.ok) throw new Error(`artifact ${url}: HTTP ${res.status}`);

    const hasher = sha256.create();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      reader = res.body.getReader();
      for (;;) {
        const { done, value } = await within(reader.read());
        if (done) break;
        progress();
        hasher.update(value);
        chunks.push(value);
        total += value.length;
      }
    } else {
      const buf = new Uint8Array(await within(res.arrayBuffer()));
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
    return bytes;
  } catch (err) {
    if (ctl.signal.aborted) {
      void reader?.cancel().catch(() => undefined);
      throw stalled();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
