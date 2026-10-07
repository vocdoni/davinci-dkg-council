/**
 * Real Council ceremonies on Gnosis Chain (or any chain with a deployment record), end to end,
 * driven by the e2e actors with real proofs (snarkjs in Node) and a relayer this script runs:
 *
 *   A  n = 3, t = 2: manual registration close and manual decryption opening by the organizer;
 *      every signed action through the relayer, its combine worker solves and combines.
 *   B  n = 5, t = 3: scheduled registration close and scheduled decryption opening a few minutes
 *      later. The relayer's scheduler sends the close and the finalize, nobody calls anything,
 *      and the gate opens by predicate alone. Member 5 never deals (QUAL = {1..4}) and still
 *      decrypts from chain state (scenario C); member 4 sends its partial directly.
 *   D  on A's ceremony, the partial-data sourcing paths (protocol §10.4): the relayer's cache is
 *      dropped, so its combiner must read each vector with one single-block eth_getLogs at the
 *      stored publication block; then the logs are gone too (a proxy answers those reads with
 *      nothing), and the members re-publish their vectors through the relayer.
 *   E  n = 3, t = 2, one dealer only: finalize and abort are refused before the dealing deadline,
 *      the scheduler aborts after it.
 *
 * A then D, B and E run concurrently against one relayer. Every security-relevant read (roster
 * approval, share recovery, the partial snapshot, the decryption gate, every result) is the SDK's
 * authenticated read: >= 2 RPC providers pinned to one finalized block they agree on. Progress
 * checks in between read `latest` and are informational only.
 *
 * The relayer (relayer/dist/main.js) runs as a child process in open mode with its scheduler
 * and combine worker on, behind a local JSON-RPC proxy that forwards to the public endpoints,
 * records every eth_getLogs and, for D, answers the single-block reads of chosen requests with no
 * logs (a provider that lost them). Scenario D restarts it (combine worker off while the partials
 * go in, the cache file dropped while it is down).
 *
 * Launched by run.sh, which builds the packages and sets the environment:
 *   COUNCIL_DEPLOYMENT        deployment record (default scripts/gnosis/deployment.json); its
 *                              MockCouncilAdapter is the test-only requester
 *   COUNCIL_READ_RPC_URLS     comma-separated, >= 2 independent providers (authenticated reads)
 *   COUNCIL_RPC_URL           comma-separated fallbacks for sending and progress reads; the
 *                              relayer's proxy forwards to the same list
 *   COUNCIL_RELAYER_KEY_FILE  the relayer's hot key (read here, handed to the child via env only)
 *   COUNCIL_TESTER_KEY_FILE   the adapter's registry: bind, request, the direct partial
 *   COUNCIL_GNOSIS_STATE      relayer data, logs and run records
 *   COUNCIL_RELAYER_PORT      default 8791
 *   COUNCIL_DAILY_BUDGET_WEI  relayer rolling 24 h budget, default 0.2 xDAI
 *   COUNCIL_SCENARIOS         subset of a,b,d,e (default all; d needs a)
 *   COUNCIL_B_REGISTRATION_S, COUNCIL_B_OPEN_GAP_S   B's registration window (300 s) and its
 *                              opening date past registration + dealing (180 s)
 *
 * The same run works against a local Anvil (a deployment record with a MockCouncilAdapter, two
 * RPC URLs such as http://127.0.0.1:PORT,http://localhost:PORT, `--slots-in-an-epoch 4`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accountFromSecret,
  COUNCIL_MANAGER_ABI,
  CouncilClient,
  elgamalEncrypt,
  PhaseMode,
  RelayerClient,
  RelayerError,
  requestId as computeRequestId,
  sampleNonce,
  signAction,
  SnarkjsProver,
  type Action,
  type Hex,
  type Point,
} from '@vocdoni/davinci-dkg-council-sdk';
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  fallback,
  formatEther,
  http,
  toEventSelector,
  type AbiEvent,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Member, Organizer, type ActorHost } from '../../tests/src/actors.js';
import { devCircuitRelease, loadArtifact } from '../../tests/src/deploy.js';
import { randomProcessId } from '../../tests/src/harness.js';

// ─── configuration ──────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const COUNCIL_HOME = path.join(homedir(), '.davinci-dkg-council');

function env(name: string, fallbackValue?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallbackValue !== undefined) return fallbackValue;
  throw new Error(`${name} is required (run through scripts/gnosis/run.sh)`);
}
const list = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

interface Deployment {
  chainId: number;
  circuitRelease: { circuitReleaseId: Hex };
  deploymentBlock: number;
  contracts: Record<'CouncilManager' | 'MockCouncilAdapter', { address: Hex; registry?: Hex; block?: number }>;
}

const deployment = JSON.parse(readFileSync(env('COUNCIL_DEPLOYMENT', path.join(HERE, 'deployment.json')), 'utf8')) as Deployment;
const CHAIN_ID = BigInt(deployment.chainId);
const MANAGER = deployment.contracts.CouncilManager.address.toLowerCase() as Hex;
const ADAPTER = deployment.contracts.MockCouncilAdapter?.address.toLowerCase() as Hex;
const START_BLOCK = BigInt(deployment.deploymentBlock);
const ADAPTER_BLOCK = BigInt(deployment.contracts.MockCouncilAdapter?.block ?? deployment.deploymentBlock);
const READ_RPCS = list(env('COUNCIL_READ_RPC_URLS', 'https://gnosis-rpc.publicnode.com,https://rpc.gnosischain.com'));
const SEND_RPCS = list(
  env('COUNCIL_RPC_URL', 'https://gnosis-rpc.publicnode.com,https://rpc.gnosischain.com,https://gnosis.drpc.org'),
);
const STATE = env('COUNCIL_GNOSIS_STATE', path.join(COUNCIL_HOME, 'gnosis'));
const RELAYER_KEY_FILE = env('COUNCIL_RELAYER_KEY_FILE', path.join(COUNCIL_HOME, 'gnosis-relayer.key'));
const TESTER_KEY_FILE = env('COUNCIL_TESTER_KEY_FILE', path.join(COUNCIL_HOME, 'gnosis-tester.key'));
const RELAYER_PORT = Number(env('COUNCIL_RELAYER_PORT', '8791'));
const DAILY_BUDGET_WEI = env('COUNCIL_DAILY_BUDGET_WEI', (2n * 10n ** 17n).toString());
const SCENARIOS = new Set(list(env('COUNCIL_SCENARIOS', 'a,b,d,e')).map((s) => s.toLowerCase()));
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const RUN_OUT = path.join(STATE, `run-${CHAIN_ID}-${STAMP}.json`);
const RELAYER_DATA = path.join(STATE, 'relayer');
const RELAYER_LOG = path.join(STATE, `relayer-${CHAIN_ID}-${STAMP}.log`);
const POLL_MS = 4000;
const FINALITY_POLL_MS = 10_000;

const MAX_PLAINTEXT = (1n << 40n) - 1n;
const PHASE = { Registration: 1, Dealing: 2, Live: 3, Aborted: 4 } as const;

const chain = defineChain({
  id: deployment.chainId,
  name: deployment.chainId === 100 ? 'Gnosis' : `chain ${deployment.chainId}`,
  nativeCurrency: { name: 'xDAI', symbol: 'XDAI', decimals: 18 },
  rpcUrls: { default: { http: SEND_RPCS } },
});
const transport = () => fallback(SEND_RPCS.map((u) => http(u, { timeout: 30_000, retryCount: 2 })));

function loadKey(file: string): Hex {
  let k = readFileSync(file, 'utf8').trim();
  if (!k.startsWith('0x')) k = `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${file} does not hold a 32-byte hex key`);
  return k as Hex;
}

// ─── the run record ─────────────────────────────────────────────────────────────────────────

type Via = 'relayer' | 'direct' | 'adapter' | 'relayer (worker)' | 'relayer (scheduler)';

interface TxRecord {
  scenario: string;
  step: string;
  action: string;
  via: Via;
  hash: Hex;
  from: Hex;
  block: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  costWei: bigint;
  /** wall time from submission (relay request or send) to the receipt */
  latencyMs?: number;
}

interface WaitRecord {
  scenario: string;
  step: string;
  targetBlock: bigint;
  finalizedBlock: bigint;
  waitedMs: number;
  /** from the target block's timestamp to the moment every read provider had finalized it */
  lagMs: number;
}

interface RequestRecord {
  requestId: Hex;
  values: bigint[];
  plaintexts: bigint[];
  memberSet: number[];
}

interface ScenarioRecord {
  title: string;
  result: 'incomplete' | 'success' | 'failed';
  error?: string;
  startedAt: string;
  finishedAt: string;
  ceremonyId: Hex | '';
  n: number;
  t: number;
  publicKey?: Point;
  requests: RequestRecord[];
  steps: { step: string; ms: number }[];
  notes: string[];
}

const record = {
  startedAt: new Date().toISOString(),
  finishedAt: '',
  result: 'incomplete' as 'incomplete' | 'success' | 'failed',
  chainId: CHAIN_ID,
  manager: MANAGER,
  adapter: ADAPTER,
  relayer: '' as Hex | '',
  tester: '' as Hex | '',
  readRpcs: READ_RPCS,
  sendRpcs: SEND_RPCS,
  balances: { relayerStart: 0n, relayerEnd: 0n, testerStart: 0n, testerEnd: 0n },
  scenarios: {} as Record<string, ScenarioRecord>,
  txs: [] as TxRecord[],
  waits: [] as WaitRecord[],
  logReads: [] as LogCall[],
};

const ms = (n: number): string => (n >= 60_000 ? `${(n / 60_000).toFixed(1)} min` : `${(n / 1000).toFixed(1)} s`);
const fmt = (v: bigint): string => v.toLocaleString('en-US');

function writeRecord(): void {
  mkdirSync(path.dirname(RUN_OUT), { recursive: true });
  const json = JSON.stringify(record, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
  writeFileSync(RUN_OUT, `${json}\n`);
  writeFileSync(RUN_OUT.replace(/\.json$/, '') + '.md', renderMarkdown());
}

function renderMarkdown(): string {
  const lines: string[] = [
    `Run ${record.startedAt} → ${record.finishedAt || '…'}: **${record.result}** (chain ${record.chainId}, manager \`${record.manager}\`)`,
    '',
  ];
  for (const [name, s] of Object.entries(record.scenarios)) {
    const txs = record.txs.filter((t) => t.scenario === name);
    const gas = txs.reduce((a, t) => a + t.gasUsed, 0n);
    const cost = txs.reduce((a, t) => a + t.costWei, 0n);
    lines.push(
      `### ${name}: ${s.title} — **${s.result}**${s.error ? ` (${s.error})` : ''}`,
      '',
      `ceremony \`${s.ceremonyId}\`, n=${s.n}, t=${s.t}, ${s.startedAt} → ${s.finishedAt || '…'}`,
      ...s.requests.map(
        (r) =>
          `- request \`${r.requestId}\`: values [${r.values.join(', ')}], plaintexts [${r.plaintexts.join(', ')}], member set [${r.memberSet.join(', ')}]`,
      ),
      ...s.notes.map((n) => `- ${n}`),
      '',
      '| Step | Action | Via | Gas used | Gas price (wei) | Cost (xDAI) | Latency | Tx |',
      '|---|---|---|---:|---:|---:|---:|---|',
      ...txs.map(
        (t) =>
          `| ${t.step} | ${t.action.replaceAll('|', '\\|')} | ${t.via} | ${fmt(t.gasUsed)} | ${t.effectiveGasPrice} | ${formatEther(t.costWei)} | ${t.latencyMs === undefined ? '–' : ms(t.latencyMs)} | \`${t.hash}\` |`,
      ),
      `| **total** | | | **${fmt(gas)}** | | **${formatEther(cost)}** | | |`,
      '',
      '| Finality wait | Target block | Finalized at | Waited | Block → finalized |',
      '|---|---:|---:|---:|---:|',
      ...record.waits
        .filter((w) => w.scenario === name)
        .map((w) => `| ${w.step} | ${w.targetBlock} | ${w.finalizedBlock} | ${ms(w.waitedMs)} | ${ms(w.lagMs)} |`),
      '',
      '| Step | Duration |',
      '|---|---:|',
      ...s.steps.map((x) => `| ${x.step} | ${ms(x.ms)} |`),
      '',
    );
  }
  const byAction = new Map<string, { min: bigint; max: bigint; count: number }>();
  for (const t of record.txs) {
    const action = t.action.replace(/member \d+, /, '');
    const e = byAction.get(action) ?? { min: t.gasUsed, max: t.gasUsed, count: 0 };
    e.min = t.gasUsed < e.min ? t.gasUsed : e.min;
    e.max = t.gasUsed > e.max ? t.gasUsed : e.max;
    e.count++;
    byAction.set(action, e);
  }
  const totalGas = record.txs.reduce((a, t) => a + t.gasUsed, 0n);
  const totalCost = record.txs.reduce((a, t) => a + t.costWei, 0n);
  lines.push(
    '### Gas per action',
    '',
    '| Action | Count | Gas used |',
    '|---|---:|---:|',
    ...[...byAction.entries()].map(
      ([a, e]) => `| ${a.replaceAll('|', '\\|')} | ${e.count} | ${e.min === e.max ? fmt(e.min) : `${fmt(e.min)} to ${fmt(e.max)}`} |`,
    ),
    `| **all** | ${record.txs.length} | **${fmt(totalGas)}** (${formatEther(totalCost)} xDAI) |`,
    '',
    `Relayer ${record.relayer}: ${formatEther(record.balances.relayerStart)} → ${formatEther(record.balances.relayerEnd)} xDAI ` +
      `(spent ${formatEther(record.balances.relayerStart - record.balances.relayerEnd)}); tester ${record.tester}: ` +
      `${formatEther(record.balances.testerStart)} → ${formatEther(record.balances.testerEnd)} xDAI ` +
      `(spent ${formatEther(record.balances.testerStart - record.balances.testerEnd)}).`,
    '',
  );
  return lines.join('\n');
}

const sleep = (n: number): Promise<void> => new Promise((r) => setTimeout(r, n));

// ─── chain plumbing ─────────────────────────────────────────────────────────────────────────

const client = createPublicClient({ chain, transport: transport(), cacheTime: 0, pollingInterval: POLL_MS }) as PublicClient;
const reader = new CouncilClient({ chainId: CHAIN_ID, manager: MANAGER, rpcUrls: READ_RPCS });
const readClients = READ_RPCS.map(
  (u) => createPublicClient({ chain, transport: http(u, { timeout: 30_000, retryCount: 2 }), cacheTime: 0 }) as PublicClient,
);
const relayer = new RelayerClient(`http://127.0.0.1:${RELAYER_PORT}`);
const ADAPTER_ABI = loadArtifact('MockCouncilAdapter.sol', 'MockCouncilAdapter').abi;
const release = devCircuitRelease();
const prover = new SnarkjsProver({
  deal: { wasm: release.wasm.deal, zkey: release.zkey.deal },
  partial: { wasm: release.wasm.partial, zkey: release.zkey.partial },
});

const host: ActorHost = {
  chainId: CHAIN_ID,
  manager: MANAGER,
  reader,
  prover,
  now: async () => (await client.getBlock({ blockTag: 'latest' })).timestamp,
  validUntil: async (seconds = 3600n) => (await client.getBlock({ blockTag: 'latest' })).timestamp + seconds,
};

/** Transient trouble: rate limits, timeouts, finalized-head races, the relayer restarting. */
const transient = (err: unknown): boolean =>
  /disagree|not finalized|fetch failed|timed? ?out|429|rate.?limit|too many|ECONNRESET|ECONNREFUSED|other side closed|socket|HTTP request failed|50[234]|BUSY|INTERNAL|header not found|missing trie node|unknown block/i.test(
    `${(err as Error)?.message ?? String(err)} ${(err as RelayerError)?.code ?? ''}`,
  );

async function retrying<T>(what: string, fn: () => Promise<T>, tries = 8): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !transient(err)) throw err;
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${what}: transient failure (${(err as Error).message.split('\n')[0]}), retry ${i}/${tries - 1}`);
      await sleep(Math.min(30_000, 3_000 * 2 ** (i - 1)));
    }
  }
}

async function receiptOf(hash: Hex): Promise<TransactionReceipt> {
  return retrying(`receipt ${hash}`, () => client.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS, timeout: 10 * 60_000 }));
}

interface CeremonyLatest {
  phase: number;
  n: number;
  dealtCount: number;
  qualBitmap: number;
  dealingDeadline: bigint;
  registrationDeadline: bigint;
}

async function ceremonyAtLatest(cid: Hex): Promise<CeremonyLatest> {
  return (await retrying('getCeremony', () =>
    client.readContract({ address: MANAGER, abi: COUNCIL_MANAGER_ABI, functionName: 'getCeremony', args: [cid] }),
  )) as unknown as CeremonyLatest;
}

/** The logs of one manager event for a ceremony (`cid`) or a request (`requestId`). */
async function managerEvents(eventName: string, args: Record<string, Hex>, fromBlock: bigint) {
  return retrying(`${eventName} logs`, () =>
    client.getContractEvents({ address: MANAGER, abi: COUNCIL_MANAGER_ABI, eventName: eventName as never, args: args as never, fromBlock }),
  ) as Promise<{ transactionHash: Hex; blockNumber: bigint; args: Record<string, unknown> }[]>;
}

// ─── the tester key: the adapter's registry and the direct sender (one send at a time) ─────────

let tester: PrivateKeyAccount;
let testerWallet: WalletClient;
let testerLock: Promise<unknown> = Promise.resolve();
function withTester<T>(fn: () => Promise<T>): Promise<T> {
  const run = testerLock.then(fn, fn);
  testerLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ─── the relayer's RPC proxy ────────────────────────────────────────────────────────────────

interface LogCall {
  at: string;
  fromBlock: string;
  toBlock: string;
  topic0?: string;
  topic1?: string;
  blinded: boolean;
  results?: number;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown[];
}

const PARTIAL_DATA_TOPIC = toEventSelector(
  COUNCIL_MANAGER_ABI.find((e) => e.type === 'event' && e.name === 'PartialDataPublished') as AbiEvent,
).toLowerCase();

/**
 * Forwards to the public endpoints in order, falling over only on a transport failure (an HTTP
 * error, a timeout): a JSON-RPC answer, an error included, is the provider's verdict and is
 * returned as is. Records every eth_getLogs; for a request in `blind`, a single-block read of
 * its PartialDataPublished logs gets an empty answer — a provider that no longer has them.
 */
class RpcProxy {
  readonly blind = new Set<string>();
  readonly logCalls: LogCall[] = [];
  private server: Server | undefined;
  url = '';

  private async forward(body: JsonRpcRequest): Promise<unknown> {
    let last: unknown;
    for (const upstream of SEND_RPCS) {
      try {
        const res = await fetch(upstream, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`${new URL(upstream).host}: HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        last = err;
      }
    }
    return { jsonrpc: '2.0', id: body.id, error: { code: -32603, message: `proxy: every upstream failed: ${String(last)}` } };
  }

  private async handle(req: JsonRpcRequest): Promise<unknown> {
    if (req.method !== 'eth_getLogs') return this.forward(req);
    const f = (req.params?.[0] ?? {}) as { fromBlock?: string; toBlock?: string; topics?: (string | string[] | null)[] };
    const topic0 = typeof f.topics?.[0] === 'string' ? f.topics[0].toLowerCase() : undefined;
    const topic1 = typeof f.topics?.[1] === 'string' ? f.topics[1].toLowerCase() : undefined;
    const call: LogCall = {
      at: new Date().toISOString(),
      fromBlock: String(f.fromBlock),
      toBlock: String(f.toBlock),
      topic0,
      topic1,
      blinded: false,
    };
    this.logCalls.push(call);
    if (topic0 === PARTIAL_DATA_TOPIC && topic1 && this.blind.has(topic1) && f.fromBlock === f.toBlock) {
      call.blinded = true;
      call.results = 0;
      return { jsonrpc: '2.0', id: req.id, result: [] };
    }
    const res = (await this.forward(req)) as { result?: unknown[] };
    if (Array.isArray(res.result)) call.results = res.result.length;
    return res;
  }

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcRequest | JsonRpcRequest[];
          const out = Array.isArray(parsed) ? await Promise.all(parsed.map((r) => this.handle(r))) : await this.handle(parsed);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(err instanceof Error ? err.message : String(err));
        }
      })();
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Single-block PartialDataPublished reads of one request. */
  singleBlockReads(requestIdValue: Hex): LogCall[] {
    const rid = requestIdValue.toLowerCase();
    return this.logCalls.filter((c) => c.topic0 === PARTIAL_DATA_TOPIC && c.topic1 === rid && c.fromBlock === c.toBlock);
  }

  /** PartialDataPublished reads of one request over more than one block (must never happen). */
  rangeReads(requestIdValue: Hex): LogCall[] {
    const rid = requestIdValue.toLowerCase();
    return this.logCalls.filter((c) => c.topic0 === PARTIAL_DATA_TOPIC && c.topic1 === rid && c.fromBlock !== c.toBlock);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}

// ─── the relayer process ────────────────────────────────────────────────────────────────────

class RelayerProcess {
  private child: ChildProcess | undefined;
  combiner = true;

  constructor(
    private readonly key: Hex,
    private readonly rpcUrl: string,
  ) {}

  /** `<data>/<chainId>-<manager>-partials/<requestId>.json`: the relayer's D-vector cache file. */
  cacheFile(requestIdValue: Hex): string {
    return path.join(RELAYER_DATA, `${CHAIN_ID}-${MANAGER}-partials`, `${requestIdValue.toLowerCase()}.json`);
  }

  cachedMembers(requestIdValue: Hex): number[] {
    const file = this.cacheFile(requestIdValue);
    if (!existsSync(file)) return [];
    const { vectors } = JSON.parse(readFileSync(file, 'utf8')) as { vectors: Record<string, unknown> };
    return Object.keys(vectors)
      .map((k) => Number(k.split(':')[0]))
      .sort((a, b) => a - b);
  }

  async start(opts: { combiner: boolean }): Promise<void> {
    this.combiner = opts.combiner;
    mkdirSync(RELAYER_DATA, { recursive: true });
    appendFileSync(RELAYER_LOG, `\n# ${new Date().toISOString()} start (combiner ${opts.combiner ? 'on' : 'off'})\n`);
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('COUNCIL_')) childEnv[k] = v;
    Object.assign(childEnv, {
      COUNCIL_RPC_URL: this.rpcUrl,
      COUNCIL_MANAGER_ADDRESS: MANAGER,
      COUNCIL_PRIVATE_KEY: this.key,
      COUNCIL_PORT: String(RELAYER_PORT),
      COUNCIL_HOST: '127.0.0.1',
      COUNCIL_DATA_DIR: RELAYER_DATA,
      COUNCIL_COMBINER_ENABLED: String(opts.combiner),
      COUNCIL_SCHEDULER_ENABLED: 'true',
      COUNCIL_START_BLOCK: START_BLOCK.toString(),
      COUNCIL_DAILY_BUDGET_WEI: DAILY_BUDGET_WEI,
    });
    const child = spawn(process.execPath, [path.join(ROOT, 'relayer', 'dist', 'main.js')], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => appendFileSync(RELAYER_LOG, d));
    child.stderr?.on('data', (d: Buffer) => appendFileSync(RELAYER_LOG, d));
    this.child = child;
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`relayer exited with ${child.exitCode}; see ${RELAYER_LOG}`);
      try {
        const res = await fetch(`http://127.0.0.1:${RELAYER_PORT}/v1/health`);
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`relayer did not start; see ${RELAYER_LOG}`);
      await sleep(500);
    }
  }

  stop(): Promise<void> {
    const child = this.child;
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  }

  async restart(opts: { combiner: boolean }): Promise<void> {
    await this.stop();
    await this.start(opts);
  }

  log(): string {
    return existsSync(RELAYER_LOG) ? readFileSync(RELAYER_LOG, 'utf8') : '';
  }
}

let proxy: RpcProxy;
let relayerProc: RelayerProcess;
let relayerAddress: Hex;

// ─── one scenario: its log prefix, record and submission helpers ────────────────────────────

class Scenario {
  readonly rec: ScenarioRecord;

  constructor(
    readonly name: string,
    title: string,
  ) {
    this.rec = {
      title,
      result: 'incomplete',
      startedAt: new Date().toISOString(),
      finishedAt: '',
      ceremonyId: '',
      n: 0,
      t: 0,
      requests: [],
      steps: [],
      notes: [],
    };
    record.scenarios[name] = this.rec;
  }

  log(msg: string): void {
    console.log(`[${new Date().toISOString().slice(11, 19)}] [${this.name}] ${msg}`);
  }

  note(msg: string): void {
    this.rec.notes.push(msg);
    this.log(msg);
    writeRecord();
  }

  async timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.log(`── ${step}`);
    try {
      return await fn();
    } finally {
      this.rec.steps.push({ step, ms: Date.now() - started });
      writeRecord();
    }
  }

  track(step: string, action: string, via: Via, r: TransactionReceipt, startedAt?: number): TxRecord {
    if (r.status !== 'success') throw new Error(`${step}: ${action} reverted (${r.transactionHash})`);
    const existing = record.txs.find((t) => t.hash === r.transactionHash);
    if (existing) return existing;
    const rec: TxRecord = {
      scenario: this.name,
      step,
      action,
      via,
      hash: r.transactionHash,
      from: r.from.toLowerCase() as Hex,
      block: r.blockNumber,
      gasUsed: r.gasUsed,
      effectiveGasPrice: r.effectiveGasPrice,
      costWei: r.gasUsed * r.effectiveGasPrice,
      latencyMs: startedAt === undefined ? undefined : Date.now() - startedAt,
    };
    record.txs.push(rec);
    this.log(`${step}: ${action} via ${via} in block ${r.blockNumber}, gas ${fmt(r.gasUsed)} (${r.transactionHash})`);
    writeRecord();
    return rec;
  }

  /**
   * Relay a signed action and wait for it through /v1/status. Retried, all free (nothing was
   * broadcast): SIMULATION_REVERTED from a provider lagging the block the previous action
   * landed in, a refused broadcast, and the relayer being restarted by scenario D.
   */
  async relay(step: string, action: Action, label: string = action.kind): Promise<TransactionReceipt> {
    const started = Date.now();
    let txHash: Hex | undefined;
    for (let attempt = 1; !txHash; attempt++) {
      try {
        txHash = await relayer.relay(CHAIN_ID, MANAGER, action);
      } catch (err) {
        const code = err instanceof RelayerError ? err.code : '';
        const lagging = code === 'SIMULATION_REVERTED' && attempt < 4;
        const refused = code === 'TX_FAILED' && attempt < 3;
        if (!lagging && !refused && !(transient(err) && attempt < 15)) throw err;
        this.log(`${step}: relay refused (${(err as Error).message.split('\n')[0]}), retry ${attempt}`);
        await sleep(10_000);
      }
    }
    const deadline = Date.now() + 15 * 60_000;
    for (;;) {
      const st = await retrying('relayer status', () => relayer.status(txHash as Hex), 15);
      if (st.status === 'failed') throw new Error(`${step}: relayed ${label} failed: ${st.revertReason ?? 'reverted'} (${txHash})`);
      if (st.status === 'confirmed') {
        const mined = (st as { minedTxHash?: Hex }).minedTxHash ?? txHash;
        const r = await receiptOf(mined);
        this.track(step, label, 'relayer', r, started);
        return r;
      }
      if (Date.now() > deadline) throw new Error(`${step}: relayed ${label} still pending (${txHash})`);
      await sleep(POLL_MS);
    }
  }

  /** The relayer must refuse `action` with `code` (and one of the decoded custom errors, if given); free. */
  async expectRefusal(what: string, action: Action, codes: string[], errorName?: string | string[]): Promise<RelayerError> {
    const names = errorName === undefined ? undefined : [errorName].flat().map((n) => `${n}()`);
    for (let attempt = 1; ; attempt++) {
      const err = await relayer.relay(CHAIN_ID, MANAGER, action).then(
        (hash) => new Error(`${what}: the relayer accepted it (${hash})`),
        (e: unknown) => e,
      );
      if (err instanceof RelayerError && codes.includes(err.code)) {
        if (names !== undefined && !names.includes(err.detail)) {
          throw new Error(`${what}: expected ${names.join(' or ')}, got ${err.code}: ${err.detail}`);
        }
        this.log(`${what}: refused as expected (${err.code}: ${err.detail})`);
        return err;
      }
      if (transient(err) && !(err instanceof RelayerError) && attempt < 10) {
        await sleep(10_000);
        continue;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Send an action directly from the tester key (the relayer bypass). */
  async direct(step: string, action: Action, label: string = action.kind): Promise<TransactionReceipt> {
    return withTester(async () => {
      const started = Date.now();
      const hash = await retrying(`direct ${label}`, () => reader.sendAction(testerWallet as never, action));
      const r = await receiptOf(hash);
      this.track(step, label, 'direct', r, started);
      return r;
    });
  }

  /** The registry side of the test adapter (MockCouncilAdapter): simulate, send, wait. */
  async adapter(step: string, fn: 'register' | 'submit', args: readonly unknown[], label: string) {
    return withTester(async () => {
      const started = Date.now();
      const { request, result } = await retrying(`${fn} simulation`, () =>
        client.simulateContract({ address: ADAPTER, abi: ADAPTER_ABI, functionName: fn, args, account: tester } as never),
      );
      const hash = await testerWallet.writeContract(request as never);
      const r = await receiptOf(hash);
      this.track(step, label, 'adapter', r, started);
      return { receipt: r, result: result as unknown };
    });
  }

  /** Wait until every read provider's finalized head (the authenticated anchor) reaches `block`. */
  async waitFinalized(step: string, block: bigint): Promise<void> {
    const started = Date.now();
    const { timestamp } = await retrying('target block', () => client.getBlock({ blockNumber: block }));
    let last = -1n;
    for (;;) {
      try {
        const anchor = await reader.finalizedAnchor();
        if (anchor.blockNumber >= block) {
          const w: WaitRecord = {
            scenario: this.name,
            step,
            targetBlock: block,
            finalizedBlock: anchor.blockNumber,
            waitedMs: Date.now() - started,
            lagMs: Date.now() - Number(timestamp) * 1000,
          };
          record.waits.push(w);
          this.log(`${step}: block ${block} finalized (anchor ${anchor.blockNumber}) after ${ms(w.waitedMs)}, ${ms(w.lagMs)} after it was produced`);
          writeRecord();
          return;
        }
        if (anchor.blockNumber !== last) {
          last = anchor.blockNumber;
          this.log(`${step}: waiting for finality of block ${block}; finalized ${anchor.blockNumber} (${block - anchor.blockNumber} to go)`);
        }
      } catch (err) {
        if (!transient(err)) throw err;
      }
      await sleep(FINALITY_POLL_MS);
    }
  }

  async waitPhase(cid: Hex, phase: number, timeoutMs: number): Promise<CeremonyLatest> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = await ceremonyAtLatest(cid);
      if (view.phase === phase) return view;
      if (Date.now() > deadline) throw new Error(`ceremony ${cid} did not reach phase ${phase} in time (phase ${view.phase})`);
      await sleep(POLL_MS * 2);
    }
  }

  /** The one transaction that emitted `eventName` for a ceremony, recorded with who sent it. */
  async eventTx(cid: Hex, eventName: string, fromBlock: bigint, step: string, action: string): Promise<TxRecord> {
    const logs = await managerEvents(eventName, { cid }, fromBlock);
    expect(logs.length).toBe(1);
    const r = await receiptOf(logs[0]!.transactionHash);
    const sender = r.from.toLowerCase() as Hex;
    const known = record.txs.find((t) => t.hash === r.transactionHash);
    if (known) return known;
    return this.track(step, action, sender === relayerAddress ? 'relayer (scheduler)' : 'direct', r);
  }

  /** Bind a process through the test adapter and submit the request with known plaintexts. */
  async request(cid: Hex, values: bigint[]): Promise<{ rid: Hex; publicKey: Point; requestBlock: bigint }> {
    const processId = randomProcessId();
    const { result } = await this.adapter('bind', 'register', [processId, tester.address, cid], 'bindProcess');
    const [, rid, pkX, pkY] = result as readonly [Hex, Hex, bigint, bigint];
    expect(rid).toBe(computeRequestId(CHAIN_ID, MANAGER, cid, ADAPTER, processId));
    const publicKey = { x: pkX, y: pkY };
    const cts = values.map((m) => {
      const { c1, c2 } = elgamalEncrypt(publicKey, m, sampleNonce());
      return [c1.x, c1.y, c2.x, c2.y] as const;
    });
    const { receipt } = await this.adapter('request', 'submit', [cid, rid, cts], `submitRequest (fields=${values.length})`);
    this.rec.requests.push({ requestId: rid, values, plaintexts: [], memberSet: [] });
    writeRecord();
    return { rid, publicKey, requestBlock: receipt.blockNumber };
  }

  /** Wait for the relayer's worker to complete a request; records every combine transaction. */
  async waitCombined(rid: Hex, t: number, fromBlock: bigint, timeoutMs = 25 * 60_000): Promise<{ combineBlock: bigint; memberSet: number[] }> {
    const started = Date.now();
    for (;;) {
      const [ready] = (await retrying('getPlaintexts', () =>
        client.readContract({ address: MANAGER, abi: COUNCIL_MANAGER_ABI, functionName: 'getPlaintexts', args: [rid] }),
      )) as readonly [boolean, readonly bigint[]];
      if (ready) break;
      if (Date.now() - started > timeoutMs) throw new Error(`request ${rid} was not combined in time`);
      await sleep(POLL_MS * 2);
    }
    this.log(`request ${rid} complete at the head after ${ms(Date.now() - started)}`);
    const logs = await managerEvents('FieldsCombined', { requestId: rid }, fromBlock);
    expect(logs.length).toBeGreaterThan(0);
    let combineBlock = 0n;
    let memberSet: number[] = [];
    for (const l of logs) {
      const r = await receiptOf(l.transactionHash);
      const fields = (l.args as { fieldIndexes: readonly number[] }).fieldIndexes.length;
      const sender = r.from.toLowerCase() as Hex;
      this.track('combine', `combine (t=${t}, fields=${fields})`, sender === relayerAddress ? 'relayer (worker)' : 'direct', r);
      expect(sender).toBe(relayerAddress);
      if (r.blockNumber > combineBlock) combineBlock = r.blockNumber;
      const tx = await retrying('combine tx', () => client.getTransaction({ hash: l.transactionHash }));
      const { args } = decodeFunctionData({ abi: COUNCIL_MANAGER_ABI, data: tx.input });
      memberSet = [...((args as readonly unknown[])[1] as readonly number[])];
    }
    const req = this.rec.requests.find((x) => x.requestId === rid);
    if (req) req.memberSet = memberSet;
    writeRecord();
    return { combineBlock, memberSet };
  }

  /** The plaintexts from finalized state, through the manager and through the adapter, at one anchor. */
  async checkResult(cid: Hex, rid: Hex, values: bigint[], combineBlock: bigint): Promise<void> {
    await this.waitFinalized('result', combineBlock);
    const anchor = await retrying('anchor', () => reader.finalizedAnchor());
    const { ready, values: plaintexts } = await retrying('getPlaintexts', () => reader.getPlaintexts(rid, anchor));
    expect(ready).toBe(true);
    expect(plaintexts).toEqual(values);
    for (const c of readClients) {
      const [adapterReady, adapterValues] = (await retrying('adapter plaintexts', () =>
        c.readContract({
          address: ADAPTER,
          abi: ADAPTER_ABI,
          functionName: 'plaintexts',
          args: [cid, rid, 0, values.length],
          blockNumber: anchor.blockNumber,
        }),
      )) as readonly [boolean, readonly bigint[]];
      expect(adapterReady).toBe(true);
      expect([...adapterValues]).toEqual(values);
    }
    const req = this.rec.requests.find((x) => x.requestId === rid);
    if (req) req.plaintexts = plaintexts;
    this.log(`request ${rid}: plaintexts [${plaintexts.join(', ')}] from finalized block ${anchor.blockNumber} (manager and adapter, every read provider)`);
    writeRecord();
  }

  async proveAndRelayPartial(m: Member, rid: Hex, fields: number, via: 'relayer' | 'direct'): Promise<TransactionReceipt> {
    const t0 = Date.now();
    const action = await retrying('partial', () => m.partial(rid));
    this.log(`member ${m.index}: share recovered and partial proven in ${ms(Date.now() - t0)}`);
    const label = `submitPartial (member ${m.index}, fields=${fields})`;
    return via === 'relayer' ? this.relay('partials', action, label) : this.direct('partials', action, label);
  }

  async run(body: () => Promise<void>): Promise<void> {
    try {
      await body();
      this.rec.result = 'success';
    } catch (err) {
      this.rec.result = 'failed';
      this.rec.error = (err as Error).message.split('\n')[0];
      this.log(`FAILED: ${(err as Error).stack ?? String(err)}`);
      throw err;
    } finally {
      this.rec.finishedAt = new Date().toISOString();
      writeRecord();
    }
  }
}

async function joinAll(s: Scenario, org: Organizer, cid: Hex, n: number): Promise<{ members: Member[]; lastJoinBlock: bigint }> {
  const members: Member[] = [];
  let lastJoinBlock = 0n;
  await s.timed(`join (${n} members)`, async () => {
    for (let i = 0; i < n; i++) {
      const m = new Member(host, cid);
      members.push(m);
      lastJoinBlock = (await s.relay('join', await m.join(org.inviteLink(cid, i)), 'join')).blockNumber;
    }
  });
  return { members, lastJoinBlock };
}

/**
 * The organizer's manual close. The action also carries the joined roster keys for a direct
 * submission (the relayer rebuilds them itself), read from finalized state: if the joins are not
 * finalized yet that read fails, and the close waits for them.
 */
async function closeManually(s: Scenario, org: Organizer, cid: Hex, n: number, lastJoinBlock: bigint): Promise<bigint> {
  return s.timed('close (organizer)', async () => {
    let action: Action;
    try {
      action = await org.close(cid, n);
    } catch (err) {
      s.log(`close: roster keys not readable at the finalized block yet (${(err as Error).message.split('\n')[0]})`);
      await s.waitFinalized('close (joins finalized)', lastJoinBlock);
      action = await retrying('close', () => org.close(cid, n));
    }
    return (await s.relay('close', action, `closeRegistration (n=${n})`)).blockNumber;
  });
}

async function approveAll(s: Scenario, members: Member[], closeBlock: bigint): Promise<void> {
  await s.timed('roster approval (incl. finality wait)', async () => {
    await s.waitFinalized('roster approval', closeBlock);
    for (const m of members) await retrying('approveRoster', () => m.approveRoster());
    expect(members.map((m) => m.index)).toEqual(members.map((_, i) => i + 1));
  });
}

async function dealAll(s: Scenario, dealers: Member[], n: number, t: number): Promise<bigint> {
  let last = 0n;
  await s.timed(`deal (${dealers.length} dealers)`, async () => {
    for (const m of dealers) {
      const t0 = Date.now();
      const action = await retrying('deal', () => m.deal());
      s.log(`member ${m.index}: dealing proven in ${ms(Date.now() - t0)}`);
      last = (await s.relay('deal', action, `deal (n=${n}, t=${t})`)).blockNumber;
    }
  });
  return last;
}

async function authorize(s: Scenario, org: Organizer, cid: Hex): Promise<void> {
  await s.timed('authorize (adapter + creator)', async () => {
    await s.relay('authorize', await org.allowAdapter(cid, ADAPTER), 'allowAdapter');
    await s.relay('authorize', await org.authorizeCreator(cid, tester.address.toLowerCase() as Hex), 'authorizeCreator');
  });
}

// ─── A: manual registration, manual decryption opening ──────────────────────────────────────

interface Live {
  cid: Hex;
  org: Organizer;
  members: Member[];
}

async function scenarioA(): Promise<Live> {
  const s = new Scenario('A', 'n=3, t=2, manual registration close and manual decryption opening');
  const values = [0n, 7n, 123_456_789n, MAX_PLAINTEXT];
  s.rec.n = 3;
  s.rec.t = 2;
  let live: Live | undefined;
  await s.run(async () => {
    const org = new Organizer(host);
    let cid = '0x' as Hex;
    let createBlock = 0n;
    await s.timed('create', async () => {
      // Manual registration (24 h expiry), Manual decryption with no fallback date.
      const created = await org.create({ threshold: 2, invites: 3 });
      cid = created.cid;
      s.rec.ceremonyId = cid;
      createBlock = (await s.relay('create', created.action, 'createCeremony (invites=3)')).blockNumber;
    });
    const { members, lastJoinBlock } = await joinAll(s, org, cid, 3);
    await s.expectRefusal('openDecryption in Registration', await org.openDecryption(cid), ['SIMULATION_REVERTED'], 'WrongPhase');
    const closeBlock = await closeManually(s, org, cid, 3, lastJoinBlock);
    await approveAll(s, members, closeBlock);
    await dealAll(s, members, 3, 2);
    await s.timed('finalize', async () => {
      // What the organizer's "Finish the key" sends; the scheduler may have sent the same
      // finalize already (QUAL = n), in which case the relayer refuses this one.
      try {
        await s.relay('finalize', { kind: 'finalize', ceremonyId: cid }, 'finalize (|QUAL|=3)');
      } catch (err) {
        if (!(err instanceof RelayerError)) throw err;
        s.note(`finalize relayed by the test was refused (${err.code}: ${err.detail}); the scheduler sent it`);
        await s.eventTx(cid, 'CeremonyFinalized', createBlock, 'finalize', 'finalize (|QUAL|=3)');
      }
      const view = await s.waitPhase(cid, PHASE.Live, 10 * 60_000);
      expect(view.qualBitmap).toBe(0b111);
    });
    await authorize(s, org, cid);
    let rid = '0x' as Hex;
    let requestBlock = 0n;
    await s.timed('bind + request', async () => {
      const r = await s.request(cid, values);
      rid = r.rid;
      requestBlock = r.requestBlock;
      s.rec.publicKey = r.publicKey;
    });
    await s.timed('gate closed (incl. finality wait)', async () => {
      await s.waitFinalized('request', requestBlock);
      expect(await retrying('getPublicKey', () => reader.getPublicKey(cid))).toEqual(s.rec.publicKey);
      expect(await retrying('isDecryptionOpen', () => reader.isDecryptionOpen(cid))).toBe(false);
      // An honest client refuses to compute a partial while the gate is closed (§8.7).
      await expect(members[0]!.partial(rid)).rejects.toThrow(/decryption gate is closed/);
    });
    let openBlock = 0n;
    await s.timed('open decryption (organizer)', async () => {
      openBlock = (await s.relay('open', await org.openDecryption(cid), 'openDecryption')).blockNumber;
      expect((await managerEvents('DecryptionOpened', { cid }, createBlock)).length).toBe(1);
      await s.expectRefusal('second openDecryption', await org.openDecryption(cid), ['SIMULATION_REVERTED', 'QUOTA_EXCEEDED', 'CONFLICT']);
    });
    await s.timed('partials (incl. finality wait)', async () => {
      await s.waitFinalized('partials', openBlock);
      expect(await retrying('isDecryptionOpen', () => reader.isDecryptionOpen(cid))).toBe(true);
      await s.proveAndRelayPartial(members[0]!, rid, values.length, 'relayer');
      await s.proveAndRelayPartial(members[2]!, rid, values.length, 'relayer');
    });
    const { combineBlock, memberSet } = await s.timed('combine (worker)', () => s.waitCombined(rid, 2, requestBlock));
    expect(memberSet).toEqual([1, 3]);
    await s.timed('result (incl. finality wait)', () => s.checkResult(cid, rid, values, combineBlock));
    live = { cid, org, members };
  });
  return live as Live;
}

// ─── B (+C): scheduled close and scheduled opening; a non-dealer decrypts ───────────────────

async function scenarioB(): Promise<void> {
  const s = new Scenario('B', 'n=5, t=3, scheduled registration close and scheduled decryption opening; member 5 never deals and decrypts (C)');
  const values = [0n, 1_000_000_007n, MAX_PLAINTEXT - 1n];
  const REG = BigInt(env('COUNCIL_B_REGISTRATION_S', '300'));
  const DEAL = 600n; // MIN_DEALING_DURATION
  const OPEN_GAP = BigInt(env('COUNCIL_B_OPEN_GAP_S', '180'));
  s.rec.n = 5;
  s.rec.t = 3;
  await s.run(async () => {
    const org = new Organizer(host);
    let cid = '0x' as Hex;
    let createBlock = 0n;
    let openAt = 0n;
    await s.timed('create', async () => {
      const now = await host.now();
      openAt = now + REG + DEAL + OPEN_GAP;
      const created = await org.create({
        threshold: 3,
        invites: 5,
        registrationMode: PhaseMode.Scheduled,
        registrationWindow: REG,
        dealingDuration: DEAL,
        decryptionMode: PhaseMode.Scheduled,
        decryptionOpenAt: openAt,
      });
      cid = created.cid;
      s.rec.ceremonyId = cid;
      createBlock = (await s.relay('create', created.action, 'createCeremony (invites=5, scheduled)')).blockNumber;
      const policy = await retrying('getPolicy', () =>
        client.readContract({ address: MANAGER, abi: COUNCIL_MANAGER_ABI, functionName: 'getPolicy', args: [cid] }),
      );
      s.note(`registration closes at ${new Date(Number((await ceremonyAtLatest(cid)).registrationDeadline) * 1000).toISOString()}, decryption opens at ${new Date(Number(openAt) * 1000).toISOString()} (policy ${JSON.stringify(policy, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))})`);
    });
    const { members } = await joinAll(s, org, cid, 5);
    await s.timed('scheduled close (relayer scheduler)', async () => {
      // Signed like the app's close, without the roster keys a direct call carries (the relayer
      // rebuilds them, and the joins need not be finalized yet).
      const closeMessage = { ceremonyId: cid, participantCount: 5, validUntil: await host.validUntil() };
      const manualClose: Action = {
        kind: 'closeRegistration',
        message: closeMessage,
        signature: await signAction(accountFromSecret(org.key.secret), CHAIN_ID, MANAGER, 'CloseRegistration', closeMessage),
      };
      await s.expectRefusal('organizer close in Scheduled mode', manualClose, ['SIMULATION_REVERTED'], 'WrongMode');
      const { registrationDeadline } = await ceremonyAtLatest(cid);
      if ((await host.now()) < registrationDeadline - 30n) {
        await s.expectRefusal('time-based close before the deadline', { kind: 'closeRegistrationScheduled', ceremonyId: cid }, ['SIMULATION_REVERTED'], 'RegistrationNotDue');
      }
      await s.waitPhase(cid, PHASE.Dealing, Number(REG) * 1000 + 15 * 60_000);
      const tx = await s.eventTx(cid, 'RegistrationClosed', createBlock, 'close', 'closeRegistrationScheduled (n=5)');
      expect(tx.via).toBe('relayer (scheduler)');
      const closedAt = (await client.getBlock({ blockNumber: tx.block })).timestamp;
      s.note(`the scheduler closed registration in block ${tx.block}, ${closedAt - registrationDeadline} s after the deadline`);
    });
    const closeTx = record.txs.find((t) => t.scenario === 'B' && t.step === 'close') as TxRecord;
    await approveAll(s, members, closeTx.block);
    // Member 5 approves the roster but never deals: QUAL = {1, 2, 3, 4}.
    await dealAll(s, members.slice(0, 4), 5, 3);
    await s.timed('scheduled finalize (relayer scheduler)', async () => {
      await s.expectRefusal('finalize before the dealing deadline (|QUAL| = 4 < n)', { kind: 'finalize', ceremonyId: cid }, ['SIMULATION_REVERTED'], 'FinalizeConditionNotMet');
      const { dealingDeadline } = await ceremonyAtLatest(cid);
      const view = await s.waitPhase(cid, PHASE.Live, Number(DEAL) * 1000 + 15 * 60_000);
      expect(view.qualBitmap).toBe(0b01111);
      const tx = await s.eventTx(cid, 'CeremonyFinalized', createBlock, 'finalize', 'finalize (|QUAL|=4, scheduled)');
      expect(tx.via).toBe('relayer (scheduler)');
      const at = (await client.getBlock({ blockNumber: tx.block })).timestamp;
      s.note(`the scheduler finalized in block ${tx.block}, ${at - dealingDeadline} s after the dealing deadline`);
    });
    await authorize(s, org, cid);
    let rid = '0x' as Hex;
    let requestBlock = 0n;
    await s.timed('bind + request (before the opening date)', async () => {
      const r = await s.request(cid, values);
      rid = r.rid;
      requestBlock = r.requestBlock;
      s.rec.publicKey = r.publicKey;
      await s.expectRefusal('openDecryption in Scheduled mode', await org.openDecryption(cid), ['SIMULATION_REVERTED'], 'WrongMode');
    });
    await s.timed('scheduled opening (no transaction)', async () => {
      await s.waitFinalized('request', requestBlock);
      const anchorTime = async () => {
        const a = await reader.finalizedAnchor();
        return { a, ts: (await client.getBlock({ blockNumber: a.blockNumber })).timestamp };
      };
      const first = await retrying('anchor', anchorTime);
      if (first.ts < openAt) {
        expect(await retrying('isDecryptionOpen', () => reader.isDecryptionOpen(cid, first.a))).toBe(false);
        s.note(`gate closed at finalized block ${first.a.blockNumber} (timestamp ${first.ts} < openAt ${openAt})`);
      }
      for (;;) {
        const { a, ts } = await retrying('anchor', anchorTime);
        if (await retrying('isDecryptionOpen', () => reader.isDecryptionOpen(cid, a))) {
          s.note(`gate open at finalized block ${a.blockNumber} (timestamp ${ts}, ${ts - openAt} s past openAt), seen ${Math.round(Date.now() / 1000 - Number(openAt))} s after openAt`);
          break;
        }
        await sleep(FINALITY_POLL_MS);
      }
      expect(await managerEvents('DecryptionOpened', { cid }, createBlock)).toEqual([]);
    });
    await s.timed('partials: member 5 (never dealt) and 2 relayed, member 4 direct', async () => {
      await s.proveAndRelayPartial(members[4]!, rid, values.length, 'relayer');
      await s.proveAndRelayPartial(members[1]!, rid, values.length, 'relayer');
      await s.proveAndRelayPartial(members[3]!, rid, values.length, 'direct');
    });
    const { combineBlock, memberSet } = await s.timed('combine (worker)', () => s.waitCombined(rid, 3, requestBlock));
    expect(memberSet).toEqual([2, 4, 5]);
    await s.timed('result (incl. finality wait)', () => s.checkResult(cid, rid, values, combineBlock));
    const view = await retrying('getCeremony', () => reader.getCeremony(cid));
    expect(view.qualBitmap & 0b10000).toBe(0); // member 5 is not in QUAL, and its partial counted
  });
}

// ─── D: partial-data sourcing on A's ceremony ───────────────────────────────────────────────

async function scenarioD(a: Live): Promise<void> {
  const s = new Scenario('D', "partial-data sourcing on A's ceremony: cache dropped (single-block logs), then logs gone (member republication)");
  s.rec.ceremonyId = a.cid;
  s.rec.n = 3;
  s.rec.t = 2;
  const [m1, m2, m3] = a.members as [Member, Member, Member];
  await s.run(async () => {
    // D1: the relayer carries the partials while its combine worker is off, its cache is then
    // dropped; the restarted worker has to read each vector at its publication block.
    const v1 = [0n, MAX_PLAINTEXT, 42n];
    let r1 = { rid: '0x' as Hex, requestBlock: 0n };
    await s.timed('D1: request, partials relayed with the combine worker off', async () => {
      await relayerProc.restart({ combiner: false });
      s.note('relayer restarted with its combine worker off');
      r1 = await s.request(a.cid, v1);
      await s.waitFinalized('D1 request', r1.requestBlock);
      await s.proveAndRelayPartial(m2, r1.rid, v1.length, 'relayer');
      await s.proveAndRelayPartial(m3, r1.rid, v1.length, 'relayer');
      expect(relayerProc.cachedMembers(r1.rid)).toEqual([2, 3]);
    });
    await s.timed('D1: cache dropped, combine from single-block logs', async () => {
      await relayerProc.stop();
      rmSync(relayerProc.cacheFile(r1.rid));
      s.note(`relayer stopped, its cache file for ${r1.rid} deleted, restarted with the combine worker on`);
      await relayerProc.start({ combiner: true });
      const { combineBlock, memberSet } = await s.waitCombined(r1.rid, 2, r1.requestBlock);
      expect(memberSet).toEqual([2, 3]);
      for (const i of memberSet) {
        // At the head: the partials landed a few blocks ago and need not be finalized yet.
        const [, , publishedBlock] = (await retrying('getPartialCommitment', () =>
          client.readContract({ address: MANAGER, abi: COUNCIL_MANAGER_ABI, functionName: 'getPartialCommitment', args: [r1.rid, i] }),
        )) as readonly [boolean, Hex, bigint];
        const reads = proxy.singleBlockReads(r1.rid).filter((c) => BigInt(c.fromBlock) === BigInt(publishedBlock));
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.some((c) => (c.results ?? 0) > 0)).toBe(true);
      }
      expect(proxy.rangeReads(r1.rid)).toEqual([]);
      s.note(`the combiner read ${proxy.singleBlockReads(r1.rid).length} single-block PartialDataPublished log(s) for ${r1.rid} and no range`);
      await s.checkResult(a.cid, r1.rid, v1, combineBlock);
    });

    // D2: the same, but the provider has lost the logs too: the members re-publish.
    const v2 = [9n, 0n, (1n << 39n) + 5n];
    let r2 = { rid: '0x' as Hex, requestBlock: 0n };
    const before = new Map<number, bigint>();
    await s.timed('D2: request, partials relayed with the combine worker off', async () => {
      await relayerProc.restart({ combiner: false });
      r2 = await s.request(a.cid, v2);
      await s.waitFinalized('D2 request', r2.requestBlock);
      await s.proveAndRelayPartial(m1, r2.rid, v2.length, 'relayer');
      await s.proveAndRelayPartial(m2, r2.rid, v2.length, 'relayer');
      expect(relayerProc.cachedMembers(r2.rid)).toEqual([1, 2]);
    });
    await s.timed('D2: cache dropped and logs gone, members re-publish', async () => {
      await relayerProc.stop();
      rmSync(relayerProc.cacheFile(r2.rid));
      proxy.blind.add(r2.rid.toLowerCase());
      s.note(`relayer stopped, its cache file for ${r2.rid} deleted, its provider answers that request's single-block log reads with nothing; restarted with the combine worker on`);
      await relayerProc.start({ combiner: true });
      const deadline = Date.now() + 5 * 60_000;
      const waiting = (): boolean =>
        relayerProc
          .log()
          .split('\n')
          .some((l) => l.includes('combine waiting for partial data re-publication') && l.toLowerCase().includes(r2.rid.toLowerCase()));
      while (!waiting() || proxy.singleBlockReads(r2.rid).filter((c) => c.blinded).length < 2) {
        if (Date.now() > deadline) throw new Error('the combiner never reported the missing partial data');
        await sleep(POLL_MS);
      }
      const [ready] = (await client.readContract({ address: MANAGER, abi: COUNCIL_MANAGER_ABI, functionName: 'getPlaintexts', args: [r2.rid] })) as readonly [boolean, unknown];
      expect(ready).toBe(false);
      s.note('the combiner found neither a cached vector nor a log and waits for re-publication');
      // The partials just landed and need not be finalized yet: their publication blocks at the head.
      for (const i of [1, 2]) {
        const [accepted, , publishedBlock] = (await retrying('getPartialCommitment', () =>
          client.readContract({ address: MANAGER, abi: COUNCIL_MANAGER_ABI, functionName: 'getPartialCommitment', args: [r2.rid, i] }),
        )) as readonly [boolean, Hex, bigint];
        expect(accepted).toBe(true);
        before.set(i, BigInt(publishedBlock));
      }
      for (const m of [m1, m2]) {
        const action = await retrying('republish', () => m.republish(r2.rid));
        await s.relay('republish', action, `publishPartialData (member ${m.index}, fields=${v2.length})`);
      }
      // The relayer now holds member 1's data: a second re-publication is not sponsored.
      await s.expectRefusal('second re-publication of member 1', await m1.republish(r2.rid), ['NOT_SPONSORED', 'RATE_LIMITED', 'CONFLICT']);
      const { combineBlock, memberSet } = await s.waitCombined(r2.rid, 2, r2.requestBlock);
      expect(memberSet).toEqual([1, 2]);
      await s.checkResult(a.cid, r2.rid, v2, combineBlock);
      for (const i of [1, 2]) {
        const after = (await retrying('getPartialCommitment', () => reader.getPartialCommitment(r2.rid, i))).publishedBlock;
        expect(after).toBeGreaterThan(before.get(i) as bigint);
        s.note(`member ${i}: publication block ${before.get(i)} → ${after}`);
      }
      proxy.blind.delete(r2.rid.toLowerCase());
    });
  });
}

// ─── E: fewer than t dealers by the deadline ────────────────────────────────────────────────

async function scenarioE(): Promise<void> {
  const s = new Scenario('E', 'n=3, t=2, one dealer by the dealing deadline: the scheduler aborts');
  const DEAL = 600n;
  s.rec.n = 3;
  s.rec.t = 2;
  await s.run(async () => {
    const org = new Organizer(host);
    let cid = '0x' as Hex;
    let createBlock = 0n;
    await s.timed('create', async () => {
      const created = await org.create({ threshold: 2, invites: 3, dealingDuration: DEAL });
      cid = created.cid;
      s.rec.ceremonyId = cid;
      createBlock = (await s.relay('create', created.action, 'createCeremony (invites=3)')).blockNumber;
    });
    const { members, lastJoinBlock } = await joinAll(s, org, cid, 3);
    const closeBlock = await closeManually(s, org, cid, 3, lastJoinBlock);
    await approveAll(s, members, closeBlock);
    await dealAll(s, [members[0]!], 3, 2);
    const late = await retrying('deal', () => members[1]!.deal());
    await s.timed('refusals before the dealing deadline', async () => {
      await s.expectRefusal('finalize with |QUAL| = 1 < t', { kind: 'finalize', ceremonyId: cid }, ['SIMULATION_REVERTED'], 'FinalizeConditionNotMet');
      await s.expectRefusal('abort before the dealing deadline', { kind: 'abort', ceremonyId: cid }, ['SIMULATION_REVERTED'], 'AbortConditionNotMet');
    });
    let abortBlock = 0n;
    await s.timed('abort (relayer scheduler)', async () => {
      const { dealingDeadline } = await ceremonyAtLatest(cid);
      await s.waitPhase(cid, PHASE.Aborted, Number(DEAL) * 1000 + 20 * 60_000);
      const tx = await s.eventTx(cid, 'CeremonyAborted', createBlock, 'abort', 'abort (in Dealing, |QUAL| < t)');
      expect(tx.via).toBe('relayer (scheduler)');
      abortBlock = tx.block;
      const at = (await client.getBlock({ blockNumber: tx.block })).timestamp;
      s.note(`the scheduler aborted in block ${tx.block}, ${at - dealingDeadline} s after the dealing deadline`);
      await s.expectRefusal('a dealing after the abort', late, ['SIMULATION_REVERTED'], ['WrongPhase', 'Expired']);
    });
    await s.timed('aborted, from finalized state', async () => {
      await s.waitFinalized('abort', abortBlock);
      const view = await retrying('getCeremony', () => reader.getCeremony(cid));
      expect(view.phase).toBe(PHASE.Aborted);
      expect(view.qualBitmap).toBe(0b001); // accepted contributions are never deleted
    });
  });
}

// ─── the run ────────────────────────────────────────────────────────────────────────────────

describe.sequential(`Council ceremonies on chain ${CHAIN_ID} (real proofs, local relayer with scheduler and combine worker)`, () => {
  beforeAll(async () => {
    expect(ADAPTER, 'the deployment record has no MockCouncilAdapter (the test-only requester)').toBeTruthy();
    const relayerKey = loadKey(RELAYER_KEY_FILE);
    relayerAddress = privateKeyToAccount(relayerKey).address.toLowerCase() as Hex;
    tester = privateKeyToAccount(loadKey(TESTER_KEY_FILE));
    testerWallet = createWalletClient({ account: tester, chain, transport: transport() });
    record.relayer = relayerAddress;
    record.tester = tester.address.toLowerCase() as Hex;
    record.balances.relayerStart = await client.getBalance({ address: relayerAddress });
    record.balances.testerStart = await client.getBalance({ address: tester.address });
    proxy = new RpcProxy();
    await proxy.start();
    record.logReads = proxy.logCalls;
    relayerProc = new RelayerProcess(relayerKey, proxy.url);
    await relayerProc.start({ combiner: true });
    console.log(`relayer ${relayerAddress} (${formatEther(record.balances.relayerStart)} xDAI) on :${RELAYER_PORT}, log ${RELAYER_LOG}`);
    console.log(`tester ${tester.address} (${formatEther(record.balances.testerStart)} xDAI); run record ${RUN_OUT}`);
  }, 5 * 60_000);

  afterAll(async () => {
    await relayerProc?.stop();
    await proxy?.close();
    record.balances.relayerEnd = await client.getBalance({ address: relayerAddress }).catch(() => 0n);
    record.balances.testerEnd = await client.getBalance({ address: tester.address }).catch(() => 0n);
    record.finishedAt = new Date().toISOString();
    if (record.result === 'incomplete') record.result = 'failed';
    writeRecord();
    console.log(`\nrun record: ${RUN_OUT}\n\n${renderMarkdown()}`);
  });

  it('preflight: the deployment, the release pin, the adapter, the relayer', async () => {
    const s = new Scenario('preflight', 'deployment finalized, release pin, adapter registry, relayer health');
    await s.run(async () => {
      await s.waitFinalized('deployment', ADAPTER_BLOCK > START_BLOCK ? ADAPTER_BLOCK : START_BLOCK);
      const anchor = await retrying('anchor', () => reader.finalizedAnchor());
      expect(await reader.getCircuitReleaseId(anchor)).toBe(deployment.circuitRelease.circuitReleaseId);
      expect(await reader.protocolVersion(anchor)).toBe(2);
      for (const c of readClients) {
        const registry = (await c.readContract({ address: ADAPTER, abi: ADAPTER_ABI, functionName: 'registry', blockNumber: anchor.blockNumber })) as Hex;
        expect(registry.toLowerCase()).toBe(tester.address.toLowerCase());
        const manager = (await c.readContract({ address: ADAPTER, abi: ADAPTER_ABI, functionName: 'manager', blockNumber: anchor.blockNumber })) as Hex;
        expect(manager.toLowerCase()).toBe(MANAGER);
      }
      const health = await relayer.health();
      expect(health.ok).toBe(true);
      expect(health.chainId).toBe(CHAIN_ID.toString());
      expect(health.manager.toLowerCase()).toBe(MANAGER);
      expect(health.relayer.toLowerCase()).toBe(relayerAddress);
      s.note(`finalized anchor ${anchor.blockNumber}; relayer balance ${formatEther(BigInt(health.balanceWei))} xDAI`);
    });
  });

  it('A then D, B (+C) and E, concurrently', async () => {
    const runs: Promise<void>[] = [];
    if (SCENARIOS.has('a')) {
      runs.push(
        scenarioA().then(async (a) => {
          if (SCENARIOS.has('d')) await scenarioD(a);
        }),
      );
    }
    if (SCENARIOS.has('b')) runs.push(scenarioB());
    if (SCENARIOS.has('e')) runs.push(scenarioE());
    const settled = await Promise.allSettled(runs);
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    record.result = failed.length === 0 ? 'success' : 'failed';
    writeRecord();
    if (failed.length > 0) throw new Error(failed.map((f) => (f.reason as Error).message.split('\n')[0]).join('; '));
  });
});
