/**
 * Full-scale BSGS benchmark: 2^20 baby-step table, worst-case 2^40 - 1 solve.
 * Excluded from the default run; execute with `pnpm bench:bsgs`.
 */

import { describe, expect, it } from 'vitest';
import { BsgsTable, solveDlog } from '../src/bsgs.js';
import { mulBase } from '../src/curve.js';
import { RESULT_BOUND } from '../src/constants.js';

describe('bsgs full-scale benchmark', () => {
  it('builds the 2^20 table and solves worst-case and random 40-bit dlogs', () => {
    let t0 = performance.now();
    const table = BsgsTable.build();
    const tBuild = performance.now() - t0;

    const worst = RESULT_BOUND - 1n;
    t0 = performance.now();
    expect(solveDlog(mulBase(worst), { table })).toBe(worst);
    const tWorst = performance.now() - t0;

    const rnd = new Uint8Array(5);
    globalThis.crypto.getRandomValues(rnd);
    let m = 0n;
    for (const b of rnd) m = (m << 8n) | BigInt(b);
    t0 = performance.now();
    expect(solveDlog(mulBase(m), { table })).toBe(m);
    const tRandom = performance.now() - t0;

    // eslint-disable-next-line no-console
    console.log(
      `bsgs: table build (2^20) ${(tBuild / 1000).toFixed(1)}s, worst-case 2^40-1 solve ${(tWorst / 1000).toFixed(1)}s, random 40-bit solve ${(tRandom / 1000).toFixed(1)}s`,
    );
  });
});
