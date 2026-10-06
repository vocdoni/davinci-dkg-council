/**
 * Infrastructure for the headless suite: Foundry (Docker by default, host binaries with
 * E2E_FOUNDRY=host), Anvil, the package builds and the relayer child process.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(E2E_DIR, '..');
export const CONTRACTS_DIR = path.join(REPO_ROOT, 'solidity');
export const LOG_DIR = path.join(E2E_DIR, '.logs');
export const ARTIFACTS_DIR =
  process.env.COUNCIL_ARTIFACTS_DIR ?? path.join(homedir(), '.davinci-dkg-council', 'artifacts');

const FOUNDRY_IMAGE = process.env.E2E_FOUNDRY_IMAGE ?? 'ghcr.io/foundry-rs/foundry:stable';
const useHostFoundry = process.env.E2E_FOUNDRY === 'host';

function hostBin(name: string): string {
  const local = path.join(homedir(), '.foundry', 'bin', name);
  return existsSync(local) ? local : name;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

/** `forge build` of solidity/ (its tests read ../circuits and ../tests/vectors, so the repo root is mounted). */
export function forgeBuild(): void {
  if (useHostFoundry) {
    execFileSync(hostBin('forge'), ['build'], { cwd: CONTRACTS_DIR, stdio: 'pipe' });
    return;
  }
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  execFileSync(
    'docker',
    [
      'run', '--rm', '--entrypoint', 'sh', '-u', `${uid}:${gid}`, '-e', 'HOME=/tmp',
      '-v', `${REPO_ROOT}:/work`, '-w', '/work/solidity', FOUNDRY_IMAGE, '-c', 'forge build',
    ],
    { stdio: 'pipe' },
  );
}

/** Compile the SDK and the relayer (the relayer runs as a separate Node process from dist/). */
export function buildPackages(): void {
  const tsc = path.join(E2E_DIR, 'node_modules', '.bin', 'tsc');
  for (const project of ['sdk', 'relayer']) {
    execFileSync(tsc, ['-p', path.join(REPO_ROOT, project, 'tsconfig.json')], { stdio: 'pipe' });
  }
}

async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`anvil did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export interface Anvil {
  rpcUrl: string;
  /** Settles when the Anvil process (or its container) exits. */
  exited: Promise<void>;
  stop(): void;
}

/** Fixed port and log directory for a long-lived stack (`make dev`); the suite takes the defaults. */
export interface ServiceOptions {
  port?: number;
  logDir?: string;
}

/**
 * The hardfork Anvil runs, pinned rather than left to the Foundry version's default: Sepolia and
 * Gnosis run Fusaka (Osaka), whose modexp repricing (EIP-7883) makes finalize and combine
 * measurably dearer than under Cancun, and whose per-transaction gas cap (EIP-7825, 2^24) is
 * the binding limit for one action.
 */
export const ANVIL_HARDFORK = 'osaka';

/**
 * Anvil with a Gnosis-like 17M block gas limit (so per-transaction gas is checked against the
 * real budget), the Osaka hardfork, and `--slots-in-an-epoch 0`, which makes the `finalized` tag
 * the latest block: the SDK's authenticated reads pin to it.
 */
export async function startAnvil(opts: ServiceOptions = {}): Promise<Anvil> {
  const port = opts.port ?? (await freePort());
  const args = [
    '--chain-id', '31337', '--hardfork', ANVIL_HARDFORK, '--gas-limit', '17000000', '--slots-in-an-epoch', '0', '--host',
  ];
  const logDir = opts.logDir ?? LOG_DIR;
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(path.join(logDir, 'anvil.log'));
  let stop: () => void;
  let child: ChildProcess;
  if (useHostFoundry) {
    child = spawn(hostBin('anvil'), [...args, '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    stop = () => child.kill('SIGTERM');
  } else {
    const name = `council-e2e-anvil-${process.pid}`;
    child = spawn(
      'docker',
      ['run', '--rm', '--name', name, '-p', `127.0.0.1:${port}:8545`, FOUNDRY_IMAGE, `anvil ${args.join(' ')} 0.0.0.0`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    stop = () => {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        // already gone
      }
    };
  }
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const rpcUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForRpc(rpcUrl, 60_000);
  } catch (err) {
    stop();
    throw err;
  }
  return { rpcUrl, exited, stop };
}

export interface RelayerProcess {
  url: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

/** Run the built relayer (`relayer/dist/main.js`) with its env-only configuration. */
export async function startRelayer(env: Record<string, string>, opts: ServiceOptions = {}): Promise<RelayerProcess> {
  const port = opts.port ?? (await freePort());
  const logDir = opts.logDir ?? LOG_DIR;
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(path.join(logDir, 'relayer.log'));
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'relayer', 'dist', 'main.js')], {
    env: { ...process.env, ...env, COUNCIL_PORT: String(port), COUNCIL_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`relayer exited with ${child.exitCode}; see ${logDir}/relayer.log`);
    try {
      const res = await fetch(`${url}/v1/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`relayer did not start; see ${logDir}/relayer.log`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    child,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
