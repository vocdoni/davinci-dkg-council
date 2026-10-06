/**
 * Discrete-log solvers for the combine worker, both on the SDK BSGS
 * (bound 2^40). The worker-thread solver keeps the HTTP loop responsive
 * while a table is built or a dlog is searched.
 */

import { Worker } from 'node:worker_threads';
import { BsgsTable, RESULT_BOUND, solveDlog, type Point } from '@vocdoni/davinci-dkg-council-sdk';

export interface DlogSolver {
  /**
   * m with M = m·G and 0 <= m < 2^40. Rejects with DlogNotFoundError when the
   * bounded search is exhausted, with any other error on an operational failure.
   */
  solve(M: Point): Promise<bigint>;
  close(): Promise<void>;
}

/** The bounded search found no exponent: the field can never complete. */
export class DlogNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DlogNotFoundError';
  }
}

/** In-process solver (tests, small deployments). */
export class InlineDlogSolver implements DlogSolver {
  private table: BsgsTable | undefined;

  constructor(
    private readonly babySteps: number,
    private readonly bound: bigint = RESULT_BOUND,
  ) {}

  solve(M: Point): Promise<bigint> {
    this.table ??= BsgsTable.build(this.babySteps);
    try {
      return Promise.resolve(solveDlog(M, { table: this.table, bound: this.bound }));
    } catch (err) {
      return Promise.reject(new DlogNotFoundError(err instanceof Error ? err.message : String(err)));
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface WorkerReply {
  id: number;
  m?: string;
  error?: string;
}

/** Solver on a worker thread running `dlog-worker.js`; the table is built once, in the worker. */
export class WorkerDlogSolver implements DlogSolver {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (m: bigint) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly script: URL,
    private readonly babySteps: number,
  ) {}

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.script, { workerData: { babySteps: this.babySteps } });
    w.on('message', (msg: WorkerReply) => {
      const entry = this.waiting.get(msg.id);
      if (!entry) return;
      this.waiting.delete(msg.id);
      if (msg.m !== undefined) entry.resolve(BigInt(msg.m));
      else if (msg.error !== undefined) entry.reject(new DlogNotFoundError(msg.error));
      else entry.reject(new Error('dlog worker: malformed reply'));
    });
    const fail = (err: Error): void => {
      this.worker = undefined;
      for (const entry of this.waiting.values()) entry.reject(err);
      this.waiting.clear();
    };
    w.on('error', fail);
    w.on('exit', (code) => fail(new Error(`dlog worker exited with code ${code}`)));
    w.unref();
    this.worker = w;
    return w;
  }

  /** Start the worker (and its table build) ahead of the first request. */
  warm(): void {
    this.spawn();
  }

  solve(M: Point): Promise<bigint> {
    const w = this.spawn();
    const id = this.nextId++;
    return new Promise<bigint>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      w.postMessage({ id, x: M.x.toString(), y: M.y.toString() });
    });
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    if (w) await w.terminate();
  }
}
