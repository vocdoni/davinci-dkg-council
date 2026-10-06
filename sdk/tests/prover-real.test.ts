/**
 * Real Groth16 proving against the local dev circuit artifacts
 * (circuits-v1, DEV phase-2 setup). Skipped when the artifacts
 * directory is not present on this machine.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { groth16 } from 'snarkjs';
import { SnarkjsProver } from '../src/prover.js';
import { COUNCIL_ARTIFACTS, verifyArtifactBytes } from '../src/artifacts.js';
import { circuitReleaseId, toDecimal } from '../src/encoding.js';
import { loadVectors, skipMsg } from './helpers.js';
import type { DealWitnessInput } from '../src/dealing.js';
import type { PartialWitnessInput } from '../src/partial.js';
import type { Groth16Proof } from '../src/types.js';

const ARTIFACTS_DIR = process.env.COUNCIL_ARTIFACTS_DIR ?? path.join(homedir(), '.davinci-dkg-council', 'artifacts');

interface DealingVectors {
  scenarios: { name: string; dealings: { witnessInput: DealWitnessInput; publicInputs: string[] }[] }[];
}
interface CombineVectors {
  scenarios: { name: string; partials: { witnessInput: PartialWitnessInput; publicInputs: string[] }[] }[];
}

const dealing = loadVectors<DealingVectors>('dealing');
const combine = loadVectors<CombineVectors>('combine');
const haveArtifacts = existsSync(path.join(ARTIFACTS_DIR, 'deal_final.zkey'));

/** Undo the §7.2 limb swap to rebuild the raw snarkjs proof JSON for groth16.verify. */
const toSnarkjsProof = (p: Groth16Proof) => ({
  pi_a: [toDecimal(p.pA[0]), toDecimal(p.pA[1]), '1'],
  pi_b: [
    [toDecimal(p.pB[0][1]), toDecimal(p.pB[0][0])],
    [toDecimal(p.pB[1][1]), toDecimal(p.pB[1][0])],
    ['1', '0'],
  ],
  pi_c: [toDecimal(p.pC[0]), toDecimal(p.pC[1]), '1'],
  protocol: 'groth16',
  curve: 'bn128',
});

describe.skipIf(!haveArtifacts || !dealing || !combine)(
  haveArtifacts
    ? 'real snarkjs proving (dev artifacts)'
    : `SKIPPED: dev circuit artifacts not found at ${ARTIFACTS_DIR} — ${skipMsg('dealing')}`,
  () => {
    const prover = new SnarkjsProver({
      deal: { wasm: path.join(ARTIFACTS_DIR, 'deal.wasm'), zkey: path.join(ARTIFACTS_DIR, 'deal_final.zkey') },
      partial: { wasm: path.join(ARTIFACTS_DIR, 'partial.wasm'), zkey: path.join(ARTIFACTS_DIR, 'partial_final.zkey') },
    });
    const vkey = (name: string) => JSON.parse(readFileSync(path.join(ARTIFACTS_DIR, name), 'utf8')) as object;

    it('local artifacts match the SDK sha256 pins and the circuitReleaseId binding', () => {
      for (const [circuit, files] of [
        ['deal', COUNCIL_ARTIFACTS.deal],
        ['partial', COUNCIL_ARTIFACTS.partial],
      ] as const) {
        for (const kind of ['wasm', 'zkey', 'vkey'] as const) {
          const name = files[kind].url.slice(files[kind].url.lastIndexOf('/') + 1);
          const bytes = readFileSync(path.join(ARTIFACTS_DIR, name));
          expect(() => verifyArtifactBytes(files[kind], new Uint8Array(bytes)), `${circuit} ${kind}`).not.toThrow();
        }
      }
      const release = JSON.parse(readFileSync(path.join(ARTIFACTS_DIR, 'release.json'), 'utf8')) as {
        circuitReleaseId: string;
      };
      expect(circuitReleaseId(COUNCIL_ARTIFACTS.deal.vkey.sha256, COUNCIL_ARTIFACTS.partial.vkey.sha256)).toBe(
        release.circuitReleaseId,
      );
    });

    it('proves a deal witness from the vectors and the proof verifies against the vkey', async () => {
      const sc = (dealing as DealingVectors).scenarios[0];
      if (!sc) throw new Error('no dealing scenario');
      const d = sc.dealings[0];
      if (!d) throw new Error('no dealing');
      const { proof, publicSignals } = await prover.prove('deal', d.witnessInput);
      expect(publicSignals.map(toDecimal)).toEqual(d.publicInputs);
      const signals = publicSignals.map(toDecimal);
      expect(await groth16.verify(vkey('deal_vkey.json') as never, signals, toSnarkjsProof(proof) as never)).toBe(true);
      // Tampered public input must not verify.
      const tampered = signals.slice();
      tampered[2] = '9'; // dealerIndex
      expect(await groth16.verify(vkey('deal_vkey.json') as never, tampered, toSnarkjsProof(proof) as never)).toBe(false);
    });

    it('proves a partial witness from the vectors and the proof verifies against the vkey', async () => {
      const sc = (combine as CombineVectors).scenarios[0];
      if (!sc) throw new Error('no combine scenario');
      const p = sc.partials[0];
      if (!p) throw new Error('no partial');
      const { proof, publicSignals } = await prover.prove('partial', p.witnessInput);
      expect(publicSignals.map(toDecimal)).toEqual(p.publicInputs);
      const signals = publicSignals.map(toDecimal);
      expect(await groth16.verify(vkey('partial_vkey.json') as never, signals, toSnarkjsProof(proof) as never)).toBe(
        true,
      );
    });
  },
);
