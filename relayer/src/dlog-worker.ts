/** Worker-thread entry of WorkerDlogSolver: builds the BSGS table once, then answers solve requests. */

import { parentPort, workerData } from 'node:worker_threads';
import { BsgsTable, RESULT_BOUND, solveDlog } from '@vocdoni/davinci-dkg-council-sdk';

const port = parentPort;
if (!port) throw new Error('dlog-worker must run as a worker thread');

const table = BsgsTable.build((workerData as { babySteps: number }).babySteps);

port.on('message', (msg: { id: number; x: string; y: string }) => {
  try {
    const m = solveDlog({ x: BigInt(msg.x), y: BigInt(msg.y) }, { table, bound: RESULT_BOUND });
    port.postMessage({ id: msg.id, m: m.toString() });
  } catch (err) {
    port.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
