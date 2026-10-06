// Circom analogue of circuits/common/publicrows.go (MissingDedicatedPublicRows): every public
// wire must be the only variable of the left (A) linear combination of some constraint of the
// optimized R1CS. Wire 0 is the constant one; public wires are 1..nOutputs+nPubInputs.
import type { R1cs } from "./harness.ts";

export function missingDedicatedPublicRows(r1cs: R1cs): number[] {
  const nPublic = r1cs.nOutputs + r1cs.nPubInputs;
  const dedicated = new Array<boolean>(nPublic + 1).fill(false);
  for (const [a] of r1cs.constraints) {
    if (a.size !== 1) continue;
    const [[wire, coeff]] = a;
    if (wire >= 1 && wire <= nPublic && coeff !== 0n) dedicated[wire] = true;
  }
  const missing: number[] = [];
  for (let wire = 1; wire <= nPublic; wire++) if (!dedicated[wire]) missing.push(wire);
  return missing;
}
