/**
 * Groth16 proving (protocol §7.2, architecture §4).
 *
 * - `SnarkjsProver` runs snarkjs `groth16.fullProve` directly (Node, workers).
 * - `WorkerProver` posts to a Web Worker running `prover-worker.ts` so the
 *   browser main thread never blocks (the witness still never leaves the page).
 * - `FakeProver` returns a placeholder proof with correctly ordered public
 *   signals, for tests that exercise everything but the proof.
 *
 * Proof words follow the pinned snarkjs `exportSolidityCallData` convention:
 * pB G2 limbs are swapped relative to the proof JSON (protocol §7.2).
 */

import { dealPublicSignals } from './dealing.js';
import { partialPublicSignals } from './partial.js';
import { fromDecimal, limbsToBytes32 } from './encoding.js';
import type { DealWitnessInput } from './dealing.js';
import type { PartialWitnessInput } from './partial.js';
import type { Groth16Proof } from './types.js';

export type CircuitName = 'deal' | 'partial';

export interface ProveResult {
  proof: Groth16Proof;
  /** Public signals in the circuit's pinned order (87 / 67 words). */
  publicSignals: bigint[];
}

export interface Prover {
  prove(circuit: CircuitName, witnessInput: DealWitnessInput | PartialWitnessInput): Promise<ProveResult>;
}

/** The raw snarkjs proof JSON (decimal strings, projective thirds included). */
export interface SnarkjsProofJson {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

/** Convert a snarkjs proof JSON to the pinned calldata word order (§7.2). */
export function proofFromSnarkjs(proof: SnarkjsProofJson): Groth16Proof {
  const d = fromDecimal;
  const b = proof.pi_b;
  return {
    pA: [d(proof.pi_a[0] as string), d(proof.pi_a[1] as string)],
    pB: [
      [d((b[0] as string[])[1] as string), d((b[0] as string[])[0] as string)],
      [d((b[1] as string[])[1] as string), d((b[1] as string[])[0] as string)],
    ],
    pC: [d(proof.pi_c[0] as string), d(proof.pi_c[1] as string)],
  };
}

/** A proving artifact: a file path (Node) or the raw bytes. */
export type ArtifactSource = string | Uint8Array;

export interface CircuitProvingArtifacts {
  wasm: ArtifactSource;
  zkey: ArtifactSource;
}

export type ProvingArtifacts = Record<CircuitName, CircuitProvingArtifacts>;

/** snarkjs accepts paths or `{ type: "mem", data }` objects. */
const toSnarkjsFile = (src: ArtifactSource): unknown =>
  typeof src === 'string' ? src : { type: 'mem', data: src };

/** Direct snarkjs prover (Node, or inside the worker). */
export class SnarkjsProver implements Prover {
  constructor(private readonly artifacts: ProvingArtifacts) {}

  async prove(
    circuit: CircuitName,
    witnessInput: DealWitnessInput | PartialWitnessInput,
  ): Promise<ProveResult> {
    const { groth16 } = await import('snarkjs');
    const a = this.artifacts[circuit];
    const { proof, publicSignals } = await groth16.fullProve(
      witnessInput as never,
      toSnarkjsFile(a.wasm) as never,
      toSnarkjsFile(a.zkey) as never,
    );
    return {
      proof: proofFromSnarkjs(proof as SnarkjsProofJson),
      publicSignals: (publicSignals as string[]).map(fromDecimal),
    };
  }
}

interface WorkerRequest {
  id: number;
  input: DealWitnessInput | PartialWitnessInput;
  wasm: ArtifactSource;
  zkey: ArtifactSource;
}

interface WorkerResponse {
  id: number;
  proof?: SnarkjsProofJson;
  publicSignals?: string[];
  error?: string;
}

/** Minimal structural Worker type so this module typechecks without DOM libs. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (ev: { data?: unknown }) => void): void;
  terminate(): void;
}

/**
 * Browser prover: proving runs in a Web Worker created by the caller from the
 * package's `./prover-worker` export, e.g.
 * `new Worker(new URL('@vocdoni/davinci-dkg-council-sdk/prover-worker', import.meta.url), { type: 'module' })`.
 *
 * Pending proofs never dangle: a worker `error`/`messageerror` event or
 * `terminate()` rejects every in-flight promise, a response that fails to
 * decode rejects its own promise, and proving after `terminate()` rejects
 * immediately.
 */
export class WorkerProver implements Prover {
  private nextId = 1;
  private terminated = false;
  private readonly pending = new Map<number, { resolve: (r: ProveResult) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly worker: WorkerLike,
    private readonly artifacts: ProvingArtifacts,
  ) {
    worker.addEventListener('message', (ev) => {
      const msg = ev.data as WorkerResponse;
      const entry = this.pending.get(msg?.id as number);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined || !msg.proof || !msg.publicSignals) {
        entry.reject(new Error(msg.error ?? 'prover worker: malformed response'));
        return;
      }
      try {
        entry.resolve({
          proof: proofFromSnarkjs(msg.proof),
          publicSignals: msg.publicSignals.map(fromDecimal),
        });
      } catch (err) {
        entry.reject(new Error(`prover worker: failed to decode response: ${(err as Error).message}`));
      }
    });
    worker.addEventListener('error', () => this.failAll('prover worker: worker error'));
    worker.addEventListener('messageerror', () => this.failAll('prover worker: message deserialization error'));
  }

  private failAll(reason: string): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(new Error(reason));
  }

  prove(circuit: CircuitName, witnessInput: DealWitnessInput | PartialWitnessInput): Promise<ProveResult> {
    if (this.terminated) return Promise.reject(new Error('prover worker: terminated'));
    const a = this.artifacts[circuit];
    const id = this.nextId++;
    return new Promise<ProveResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req: WorkerRequest = { id, input: witnessInput, wasm: a.wasm, zkey: a.zkey };
      this.worker.postMessage(req);
    });
  }

  /** Terminates the worker and rejects every pending proof. */
  terminate(): void {
    this.terminated = true;
    this.failAll('prover worker: terminated');
    this.worker.terminate();
  }
}

const isDealInput = (w: DealWitnessInput | PartialWitnessInput): w is DealWitnessInput => 'ctxHi' in w;

/**
 * Test prover: placeholder proof words (the vectors' 1..8), public signals
 * computed from the witness input in the pinned order.
 */
export class FakeProver implements Prover {
  constructor(
    private readonly placeholder: Groth16Proof = {
      pA: [1n, 2n],
      pB: [
        [3n, 4n],
        [5n, 6n],
      ],
      pC: [7n, 8n],
    },
  ) {}

  prove(_circuit: CircuitName, w: DealWitnessInput | PartialWitnessInput): Promise<ProveResult> {
    const point = (xy: string[]): { x: bigint; y: bigint } => ({
      x: fromDecimal(xy[0] as string),
      y: fromDecimal(xy[1] as string),
    });
    let publicSignals: bigint[];
    if (isDealInput(w)) {
      publicSignals = dealPublicSignals({
        ctx: limbsToBytes32({ hi: fromDecimal(w.ctxHi), lo: fromDecimal(w.ctxLo) }),
        dealerIndex: Number(w.dealerIndex),
        n: Number(w.n),
        t: Number(w.t),
        C: w.C.map(point),
        E: point(w.E),
        X: w.X.map(point),
        masked: w.masked.map(fromDecimal),
      });
    } else {
      publicSignals = partialPublicSignals({
        PK: point(w.PK),
        activeCount: Number(w.activeCount),
        C1: w.C1.map(point),
        D: w.D.map(point),
      });
    }
    return Promise.resolve({ proof: this.placeholder, publicSignals });
  }
}
