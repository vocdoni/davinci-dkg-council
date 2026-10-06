/**
 * Web Worker entry for in-browser Groth16 proving. Paired with `WorkerProver`.
 *
 * Receives `{ id, input, wasm, zkey }`, runs snarkjs `groth16.fullProve` and
 * posts back `{ id, proof, publicSignals }` (raw snarkjs JSON; the main thread
 * converts word order). The witness never leaves the worker.
 */

interface Request {
  id: number;
  input: Record<string, unknown>;
  wasm: string | Uint8Array;
  zkey: string | Uint8Array;
}

const toSnarkjsFile = (src: string | Uint8Array): unknown =>
  typeof src === 'string' ? src : { type: 'mem', data: src };

const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
};

scope.addEventListener('message', (ev) => {
  const req = ev.data as Request;
  void (async () => {
    try {
      const { groth16 } = await import('snarkjs');
      const { proof, publicSignals } = await groth16.fullProve(
        req.input as never,
        toSnarkjsFile(req.wasm) as never,
        toSnarkjsFile(req.zkey) as never,
      );
      scope.postMessage({ id: req.id, proof, publicSignals });
    } catch (err) {
      scope.postMessage({ id: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  })();
});
