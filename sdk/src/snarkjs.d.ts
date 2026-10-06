/** Minimal typings for the snarkjs surface the SDK uses (snarkjs ships none). */
declare module 'snarkjs' {
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmFile: unknown,
      zkeyFile: unknown,
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: string[], proof: unknown): Promise<boolean>;
  };
}
