/**
 * Proving pipeline: download the pinned circuit files (sha256-verified by the
 * SDK, with progress for the UI), then run snarkjs in a Web Worker so the
 * page stays responsive. The witness never leaves the browser.
 */

import {
  COUNCIL_ARTIFACTS,
  fetchArtifact,
  WorkerProver,
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
  baseUrl: string | null,
  onProgress?: OnProveProgress,
): Promise<Uint8Array> {
  const file = COUNCIL_ARTIFACTS[circuit][kind];
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
  const bytes = await fetchArtifact(file, { baseUrl: baseUrl ?? undefined, fetchFn });
  memoryCache.set(cacheKey, bytes);
  return bytes;
}

/** Download (or reuse) the verified proving files of one circuit. */
export async function loadCircuitArtifacts(
  circuit: CircuitName,
  baseUrl: string | null,
  onProgress?: OnProveProgress,
): Promise<CircuitProvingArtifacts> {
  const [wasm, zkey] = await Promise.all([
    loadFile(circuit, 'wasm', baseUrl, onProgress),
    loadFile(circuit, 'zkey', baseUrl, onProgress),
  ]);
  return { wasm, zkey };
}

/** Prove one statement in a fresh Web Worker, terminated afterwards. */
export async function proveInWorker(
  circuit: CircuitName,
  witnessInput: DealWitnessInput | PartialWitnessInput,
  baseUrl: string | null,
  onProgress?: OnProveProgress,
): Promise<ProveResult> {
  const loaded = await loadCircuitArtifacts(circuit, baseUrl, onProgress);
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
