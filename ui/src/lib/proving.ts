/**
 * Proving pipeline: download the pinned circuit files (sha256-verified by the
 * SDK, with progress for the UI), then run snarkjs in a Web Worker so the
 * page stays responsive. The witness never leaves the browser.
 */

import {
  ArtifactUnavailableError,
  COUNCIL_ARTIFACTS,
  fetchArtifact,
  WorkerProver,
  type ArtifactsRelease,
  type CircuitName,
  type CircuitProvingArtifacts,
  type DealWitnessInput,
  type PartialWitnessInput,
  type ProveResult,
  type ProvingArtifacts,
  type WorkerLike,
} from '@vocdoni/davinci-dkg-council-sdk';
import { progressFetch } from './progressFetch';

export interface ProveProgress {
  /** 'download': fetching proving files; 'prove': computing the proof. */
  stage: 'download' | 'prove';
  file?: string;
  loadedBytes?: number;
  totalBytes?: number;
}

export type OnProveProgress = (p: ProveProgress) => void;

const memoryCache = new Map<string, Uint8Array>();

async function loadFile(
  circuit: CircuitName,
  kind: 'wasm' | 'zkey',
  baseUrls: readonly string[],
  release: ArtifactsRelease,
  onProgress?: OnProveProgress,
): Promise<Uint8Array> {
  const file = release[circuit][kind];
  const cacheKey = `${file.url}:${file.sha256}`;
  const hit = memoryCache.get(cacheKey);
  if (hit) return hit;
  const fetchFn = progressFetch((p) =>
    onProgress?.({
      stage: 'download',
      file: `${circuit}.${kind}`,
      loadedBytes: p.loadedBytes,
      totalBytes: p.totalBytes,
    }),
  );
  // Mirrors in order; each copy is checked against the pin inside the SDK.
  const bytes = await fetchArtifact(file, { baseUrls, release: release.release, fetchFn }).catch((err: unknown) => {
    if (err instanceof ArtifactUnavailableError) {
      throw new Error(
        'the checking files could not be downloaded from any of our copies — check your connection and try again; if it keeps failing, tell whoever runs this app',
        { cause: err },
      );
    }
    throw err;
  });
  memoryCache.set(cacheKey, bytes);
  return bytes;
}

/** Download (or reuse) the verified proving files of one circuit of `release` (default: the current pins). */
export async function loadCircuitArtifacts(
  circuit: CircuitName,
  baseUrls: readonly string[],
  onProgress?: OnProveProgress,
  release: ArtifactsRelease = COUNCIL_ARTIFACTS,
): Promise<CircuitProvingArtifacts> {
  const [wasm, zkey] = await Promise.all([
    loadFile(circuit, 'wasm', baseUrls, release, onProgress),
    loadFile(circuit, 'zkey', baseUrls, release, onProgress),
  ]);
  return { wasm, zkey };
}

/** Prove one statement in a fresh Web Worker, terminated afterwards. */
export async function proveInWorker(
  circuit: CircuitName,
  witnessInput: DealWitnessInput | PartialWitnessInput,
  baseUrls: readonly string[],
  onProgress?: OnProveProgress,
  release: ArtifactsRelease = COUNCIL_ARTIFACTS,
): Promise<ProveResult> {
  const loaded = await loadCircuitArtifacts(circuit, baseUrls, onProgress, release);
  onProgress?.({ stage: 'prove' });
  const worker = new Worker(new URL('./prover.worker.ts', import.meta.url), { type: 'module' });
  const artifacts: ProvingArtifacts = { deal: loaded, partial: loaded };
  const prover = new WorkerProver(worker as unknown as WorkerLike, artifacts);
  try {
    return await prover.prove(circuit, witnessInput);
  } finally {
    prover.terminate();
  }
}
