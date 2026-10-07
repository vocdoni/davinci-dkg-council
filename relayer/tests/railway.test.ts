import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/railway-deploy-relayer.test.sh');

describe('Railway deployment of the relayer (scripts/railway-deploy-relayer.sh)', () => {
  it('runs the scheduler and the combine worker, and never passes a secret as a process argument', () => {
    const out = execFileSync('bash', [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toContain('[railway-deploy-relayer.test] ok');
  }, 120_000);
});
