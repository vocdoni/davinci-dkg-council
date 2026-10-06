/**
 * The DAVINCI side of the round-trip suite: davinci-contracts (branch `council`) built with
 * Foundry, the davinci-test CLI (davinci-sdk), and the results accumulator the registry proves
 * against its state root.
 *
 * Env:
 * - `DAVINCI_CONTRACTS_DIR`: the davinci-contracts checkout (default: `davinci-contracts` next to
 *   this repository's main checkout). Built with the host `forge` (FOUNDRY_BIN, ~/.foundry/bin or
 *   PATH), else the Foundry image; output goes to `~/.cache/council-e2e`, never into the checkout.
 * - `DAVINCI_SDK_DIR`: the built davinci-sdk checkout the CLI links (see tools/davinci-test/README.md).
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { elgamalEncrypt, sampleNonce, type Hex, type Point } from '@vocdoni/davinci-dkg-council-sdk';
import {
  encodeAbiParameters,
  keccak256,
  stringToHex,
  toHex,
  zeroAddress,
  type Abi,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { deploy } from './deploy.js';
import { REPO_ROOT } from './infra.js';

const FOUNDRY_IMAGE = process.env.E2E_FOUNDRY_IMAGE ?? 'ghcr.io/foundry-rs/foundry:stable';
export const DAVINCI_TEST_DIR = path.join(REPO_ROOT, 'tools', 'davinci-test');

/** A checkout next to the main checkout of this repository (also from a git worktree). */
function sibling(name: string): string {
  let root = REPO_ROOT;
  try {
    const common = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    root = path.dirname(common);
  } catch {
    // not a git checkout
  }
  return path.join(root, '..', name);
}

export const DAVINCI_CONTRACTS_DIR = path.resolve(process.env.DAVINCI_CONTRACTS_DIR || sibling('davinci-contracts'));

const forgeOut = (): string => {
  const id = createHash('sha256').update(DAVINCI_CONTRACTS_DIR).digest('hex').slice(0, 8);
  return path.join(homedir(), '.cache', 'council-e2e', `davinci-contracts-${id}`);
};

function hostForge(): string | undefined {
  for (const dir of [process.env.FOUNDRY_BIN, path.join(homedir(), '.foundry', 'bin')]) {
    if (dir && existsSync(path.join(dir, 'forge'))) return path.join(dir, 'forge');
  }
  try {
    execFileSync('forge', ['--version'], { stdio: 'ignore' });
    return 'forge';
  } catch {
    return undefined;
  }
}

/** `forge build` of davinci-contracts, its out/ and cache outside the checkout. */
export function buildDavinciContracts(): void {
  if (!existsSync(path.join(DAVINCI_CONTRACTS_DIR, 'src', 'CouncilAdapter.sol'))) {
    throw new Error(`${DAVINCI_CONTRACTS_DIR} is not davinci-contracts with the COUNCIL key mode; set DAVINCI_CONTRACTS_DIR`);
  }
  const out = forgeOut();
  mkdirSync(out, { recursive: true });
  const forge = hostForge();
  if (forge) {
    execFileSync(forge, ['build'], {
      cwd: DAVINCI_CONTRACTS_DIR,
      stdio: 'pipe',
      env: {
        ...process.env,
        FOUNDRY_OUT: path.join(out, 'out'),
        FOUNDRY_CACHE_PATH: path.join(out, 'cache'),
        FOUNDRY_LINT_LINT_ON_BUILD: 'false',
      },
    });
    return;
  }
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  execFileSync(
    'docker',
    [
      'run', '--rm', '--entrypoint', 'sh', '-u', `${uid}:${gid}`, '-e', 'HOME=/tmp',
      '-e', 'FOUNDRY_OUT=/out/out', '-e', 'FOUNDRY_CACHE_PATH=/out/cache', '-e', 'FOUNDRY_LINT_LINT_ON_BUILD=false',
      '-v', `${DAVINCI_CONTRACTS_DIR}:/work`, '-v', `${out}:/out`, '-w', '/work', FOUNDRY_IMAGE, '-c', 'forge build',
    ],
    { stdio: 'pipe' },
  );
}

interface ForgeArtifact {
  abi: Abi;
  bytecode: { object: Hex; linkReferences?: Record<string, unknown> };
  storageLayout?: {
    storage: { label: string; slot: string; offset: number; type: string }[];
    types: Record<string, { members?: { label: string; slot: string; offset: number }[]; value?: string }>;
  };
}

export function davinciArtifact(file: string, contract: string): ForgeArtifact {
  const a = JSON.parse(readFileSync(path.join(forgeOut(), 'out', file, `${contract}.json`), 'utf8')) as ForgeArtifact;
  if (a.bytecode.linkReferences && Object.keys(a.bytecode.linkReferences).length > 0) {
    throw new Error(`${contract}: library linking is not supported`);
  }
  return a;
}

/** The registry's grace window settings (seconds): the davinci-sdk anvil values. */
export const DAVINCI_GRACE = [120, 40, 180, 240, 5] as const;

export interface DavinciDeployment {
  registry: Hex;
  /** The registry's CouncilAdapter (deployed by the registry's constructor). */
  adapter: Hex;
  verifier: Hex;
}

/**
 * A davinci-contracts ProcessRegistry in the COUNCIL key mode bound to `manager`, on
 * MockZiskVerifier (state transitions are not proven) and with no davinci-dkg manager. The
 * verifier pins are labels: a mock verifier has nothing to pin.
 */
export async function deployDavinciRegistry(
  wallet: WalletClient,
  client: PublicClient,
  chainId: number,
  manager: Hex,
): Promise<DavinciDeployment> {
  const zisk = davinciArtifact('MockZiskVerifier.sol', 'MockZiskVerifier');
  const artifact = davinciArtifact('ProcessRegistry.sol', 'ProcessRegistry');
  const verifier = await deploy(wallet, client, { abi: zisk.abi, bytecode: zisk.bytecode.object });
  const pin = (label: string) => keccak256(stringToHex(`council-e2e:${label}`));
  const registry = await deploy(wallet, client, { abi: artifact.abi, bytecode: artifact.bytecode.object }, [
    chainId,
    verifier,
    pin('batch-program-vk'),
    pin('results-program-vk'),
    pin('root-c-vadcop-final'),
    pin('ballot-vk-hash'),
    zeroAddress, // no davinci-dkg manager
    manager,
    ...DAVINCI_GRACE,
  ]);
  const adapter = (await client.readContract({
    address: registry,
    abi: artifact.abi,
    functionName: 'councilAdapter',
  } as never)) as Hex;
  if (adapter === zeroAddress) throw new Error('the registry has no CouncilAdapter');
  return { registry, adapter: adapter.toLowerCase() as Hex, verifier };
}

/**
 * The storage slot of `processes[pid].latestStateRoot`, from the compiled storage layout (the
 * branch's, not an assumed one): keccak256(pid ‖ slot(processes)) + slot(latestStateRoot).
 */
export function latestStateRootSlot(registry: ForgeArtifact, pid: Hex): Hex {
  const layout = registry.storageLayout;
  if (!layout) throw new Error('ProcessRegistry artifact has no storageLayout (extra_output)');
  const processes = layout.storage.find((s) => s.label === 'processes');
  const valueType = processes && layout.types[processes.type]?.value;
  const member = valueType ? layout.types[valueType]?.members?.find((m) => m.label === 'latestStateRoot') : undefined;
  if (!processes || !member || member.offset !== 0) throw new Error('cannot locate processes[pid].latestStateRoot');
  const base = BigInt(keccak256(encodeAbiParameters([{ type: 'bytes31' }, { type: 'uint256' }], [pid, BigInt(processes.slot)])));
  return toHex(base + BigInt(member.slot), { size: 32 });
}

/** A ballot field of the final tally: a ciphertext of `value`, or never written (identity). */
export type Field = { value: bigint } | { identity: true };

/** The 64-coordinate results accumulator (16 fields of [c1x, c1y, c2x, c2y], circomlib TE). */
export function accumulator(fields: readonly Field[], publicKey: Point): bigint[] {
  if (fields.length > 16) throw new Error('at most 16 fields');
  const acc: bigint[] = [];
  for (let i = 0; i < 16; i++) {
    const f = fields[i];
    if (!f || 'identity' in f) {
      acc.push(0n, 1n, 0n, 1n);
      continue;
    }
    const { c1, c2 } = elgamalEncrypt(publicKey, f.value, sampleNonce());
    acc.push(c1.x, c1.y, c2.x, c2.y);
  }
  return acc;
}

/** The plaintexts the registry stores: each field's value, 0 for an identity field. */
export const expectedResult = (fields: readonly Field[]): bigint[] => fields.map((f) => ('identity' in f ? 0n : f.value));

const sha256 = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest();

/**
 * A state root holding only the results leaf (key 0x04): the arbo leaf hash
 * sha256(key_le8 ‖ value_le32 ‖ 0x01) of value = sha256(abi.encode(uint256[64] acc)), proven by
 * one zero sibling.
 */
export function resultsOnlyRoot(acc: readonly bigint[]): Hex {
  if (acc.length !== 64) throw new Error('the accumulator has 64 coordinates');
  const encoded = Buffer.from(encodeAbiParameters([{ type: 'uint256[64]' }], [acc as never]).slice(2), 'hex');
  const valueLE = Buffer.from(sha256(encoded)).reverse();
  const key = Buffer.alloc(8);
  key.writeBigUInt64LE(4n);
  return `0x${sha256(Buffer.concat([key, valueLE, Buffer.from([1])])).toString('hex')}`;
}

/** Compile the davinci-test CLI against the linked davinci-sdk. */
export function buildDavinciTest(): void {
  execFileSync(process.execPath, [path.join(DAVINCI_TEST_DIR, 'scripts', 'link-sdk.mjs')], { stdio: 'pipe' });
  execFileSync(path.join(DAVINCI_TEST_DIR, 'node_modules', '.bin', 'tsc'), ['-p', path.join(DAVINCI_TEST_DIR, 'tsconfig.json')], {
    stdio: 'pipe',
  });
}

export interface CliResult<T> {
  code: number;
  out: T;
  stderr: string;
}

/** Run `davinci-council <args> --json` with `env`; the JSON it printed (an error object on failure). */
export function runCli<T = Record<string, unknown>>(args: string[], env: Record<string, string>): Promise<CliResult<T>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DAVINCI_TEST_DIR, 'dist', 'cli.js'), ...args, '--json'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').pop() ?? '';
      try {
        resolve({ code: code ?? -1, out: JSON.parse(line) as T, stderr });
      } catch {
        reject(new Error(`davinci-council ${args[0]} printed no JSON (exit ${code}): ${stdout}\n${stderr}`));
      }
    });
  });
}
