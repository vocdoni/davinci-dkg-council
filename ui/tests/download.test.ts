/** The real (unmocked) print path: isolated iframe document, honest result. */

import { describe, expect, it } from 'vitest';
import { printTextSheet } from '../src/lib/download';

describe('printTextSheet', () => {
  it('builds an isolated print frame and reports success', () => {
    const ok = printTextSheet('Council recovery words', 'word1 word2 word3');
    expect(ok).toBe(true);
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.contentDocument?.body.textContent).toContain('word1 word2 word3');
  });
});
