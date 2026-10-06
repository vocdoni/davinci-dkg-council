/**
 * A real Council ceremony on a live network (Sepolia), end to end, driven by the e2e actors:
 * n = 3, t = 2, fresh in-memory roots for the organizer and every member.
 *
 *   create (3 invites) -> 3 joins -> close -> [finality] roster approval -> 3 proven dealings
 *   -> finalize -> allow the test adapter + the creator -> bind -> request (known ciphertexts)
 *   -> [finality] 2 proven partials (member 1 directly from a funded throwaway key, member 3
 *   through the relayer) -> combine by the relayer's worker -> [finality] plaintexts
 *
 * Every signed action goes through the relayer except member 1's partial; the adapter calls
 * (bind, request) come from the adapter's registry key. Security-relevant reads (roster
 * approval, share recovery, the partial snapshot, the result) are the SDK's authenticated reads:
 * at least two RPC providers, pinned to one finalized block they agree on, so each of those
 * steps first waits for the preceding transactions to be finalized. Progress checks in between
 * read `latest` and are informational only.
 *
 * Launched by run.sh, which starts the relayer and sets the environment:
 *   COUNCIL_DEPLOYMENT      deployment record (default scripts/sepolia/deployment.json)
 *   COUNCIL_READ_RPC_URLS   comma-separated, >= 2 independent providers (authenticated reads)
 *   COUNCIL_RPC_URL         comma-separated fallbacks for sending and progress reads
 *   COUNCIL_RELAYER_URL     the relayer
 *   COUNCIL_RELAYER_TOKEN   bearer token admitting createCeremony (restricted mode)
 *   COUNCIL_PRIVATE_KEY     funded key: the adapter's registry and the throwaway's funder
 *   COUNCIL_RUN_OUT         run record (JSON; a Markdown summary is written next to it)
 *   COUNCIL_THROWAWAY_FUND_WEI  funding of the direct-partial key (default 0.003 ether)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COUNCIL_MANAGER_ABI,
  CouncilClient,
  elgamalEncrypt,
  RelayerClient,
  RelayerError,
  requestId as computeRequestId,
  sampleNonce,
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
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Member, Organizer, type ActorHost } from '../../tests/src/actors.js';
import { devCircuitRelease, loadArtifact } from '../../tests/src/deploy.js';
import { randomProcessId } from '../../tests/src/harness.js';

// ─── configuration ──────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

function env(name: string, fallbackValue?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallbackValue !== undefined) return fallbackValue;
  throw new Error(`${name} is required (run through scripts/sepolia/run.sh)`);
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
  contracts: Record<'CouncilManager' | 'MockCouncilAdapter', { address: Hex; registry?: Hex }>;
}

const deployment = JSON.parse(readFileSync(env('COUNCIL_DEPLOYMENT', path.join(HERE, 'deployment.json')), 'utf8')) as Deployment;
const CHAIN_ID = BigInt(deployment.chainId);
const MANAGER = deployment.contracts.CouncilManager.address.toLowerCase() as Hex;
const ADAPTER = deployment.contracts.MockCouncilAdapter.address.toLowerCase() as Hex;
const READ_RPCS = list(env('COUNCIL_READ_RPC_URLS'));
const SEND_RPCS = list(env('COUNCIL_RPC_URL'));
const RELAYER_URL = env('COUNCIL_RELAYER_URL');
const RELAYER_TOKEN = env('COUNCIL_RELAYER_TOKEN');
const RUN_OUT = env('COUNCIL_RUN_OUT');
const THROWAWAY_FUND = BigInt(env('COUNCIL_THROWAWAY_FUND_WEI', '3000000000000000'));
const POLL_MS = Number(env('COUNCIL_POLL_MS', CHAIN_ID === 31337n ? '1000' : '6000'));
const FINALITY_POLL_MS = Number(env('COUNCIL_FINALITY_POLL_MS', CHAIN_ID === 31337n ? '1000' : '30000'));

const N = 3;
const T = 2;
/** Known plaintexts: a zero field, small values and one close to the 2^40 bound. */
const VALUES = [0n, 1n, 123_456_789n, (1n << 40n) - 3n];
const DIRECT_MEMBER = 1;
const RELAYED_MEMBER = 3;

const chain = defineChain({
  id: deployment.chainId,
  name: deployment.chainId === 11155111 ? 'Sepolia' : `chain ${deployment.chainId}`,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: SEND_RPCS } },
});
const transport = () => fallback(SEND_RPCS.map((u) => http(u, { timeout: 30_000, retryCount: 3 })));

function loadKey(): PrivateKeyAccount {
  let k = env('COUNCIL_PRIVATE_KEY');
  if (!k.startsWith('0x')) k = `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('COUNCIL_PRIVATE_KEY is not a 32-byte hex key');
  return privateKeyToAccount(k as Hex);
}

// ─── the run record ─────────────────────────────────────────────────────────────────────────

interface TxRecord {
  step: string;
  action: string;
  via: 'relayer' | 'direct' | 'adapter' | 'relayer (worker)' | 'transfer';
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
  step: string;
  targetBlock: bigint;
  finalizedBlock: bigint;
  waitedMs: number;
}

const record = {
  startedAt: new Date().toISOString(),
  finishedAt: '',
  result: 'incomplete' as 'incomplete' | 'success' | 'failed',
  chainId: CHAIN_ID,
  manager: MANAGER,
  adapter: ADAPTER,
  relayerUrl: RELAYER_URL,
  relayer: '' as Hex | '',
  readRpcs: READ_RPCS,
  sendRpcs: SEND_RPCS,
  n: N,
  t: T,
  ceremonyId: '' as Hex | '',
  processId: '' as Hex | '',
  requestId: '' as Hex | '',
  publicKey: undefined as Point | undefined,
  values: VALUES,
  plaintexts: [] as bigint[],
  memberSet: [] as number[],
  throwaway: '' as Hex | '',
  balances: { keyStart: 0n, keyEnd: 0n },
  txs: [] as TxRecord[],
  waits: [] as WaitRecord[],
  steps: [] as { step: string; ms: number }[],
  notes: [] as string[],
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
  const total = record.txs.reduce((s, t) => s + t.costWei, 0n);
  const totalGas = record.txs.reduce((s, t) => s + t.gasUsed, 0n);
  const lines = [
    `Run ${record.startedAt} → ${record.finishedAt || '…'}: **${record.result}**`,
    '',
    `ceremony \`${record.ceremonyId}\`, n=${N}, t=${T}; request \`${record.requestId}\`; member set [${record.memberSet.join(', ')}]`,
    '',
    '| Step | Action | Via | Gas used | Gas price (gwei) | Cost (ETH) | Latency | Tx |',
    '|---|---|---|---:|---:|---:|---:|---|',
    ...record.txs.map(
      (t) =>
        `| ${t.step} | ${t.action.replaceAll('|', '\\|')} | ${t.via} | ${fmt(t.gasUsed)} | ${(Number(t.effectiveGasPrice) / 1e9).toFixed(3)} | ${formatEther(t.costWei)} | ${t.latencyMs === undefined ? '–' : ms(t.latencyMs)} | \`${t.hash}\` |`,
    ),
    `| **total** | | | **${fmt(totalGas)}** | | **${formatEther(total)}** | | |`,
    '',
    '| Finality wait | Target block | Finalized at | Waited |',
    '|---|---:|---:|---:|',
    ...record.waits.map((w) => `| ${w.step} | ${w.targetBlock} | ${w.finalizedBlock} | ${ms(w.waitedMs)} |`),
    '',
    '| Step | Duration |',
    '|---|---:|',
    ...record.steps.map((s) => `| ${s.step} | ${ms(s.ms)} |`),
    '',
    `Key balance ${formatEther(record.balances.keyStart)} → ${formatEther(record.balances.keyEnd)} ETH ` +
      `(spent ${formatEther(record.balances.keyStart - record.balances.keyEnd)} ETH, throwaway funding net of its sweep included).`,
    ...record.notes.map((n) => `- ${n}`),
    '',
  ];
  return lines.join('\n');
}

const log = (msg: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sleep = (n: number): Promise<void> => new Promise((r) => setTimeout(r, n));

// ─── chain plumbing ─────────────────────────────────────────────────────────────────────────

const client = createPublicClient({ chain, transport: transport(), cacheTime: 0, pollingInterval: POLL_MS }) as PublicClient;
const reader = new CouncilClient({ chainId: CHAIN_ID, manager: MANAGER, rpcUrls: READ_RPCS });
/** createCeremony needs the bearer token in restricted mode; it is harmless on every other call. */
const relayer = new RelayerClient(RELAYER_URL, {
  fetchFn: (input, init) =>
    fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${RELAYER_TOKEN}` } }),
});
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

/** Transient provider trouble: rate limits, timeouts, finalized-head races between providers. */
const transient = (err: unknown): boolean =>
  /disagree|not finalized|fetch failed|timed? ?out|429|rate.?limit|too many|ECONNRESET|socket|HTTP request failed|50[234]|BUSY|INTERNAL|header not found|missing trie node/i.test(
    `${(err as Error)?.message ?? String(err)} ${(err as RelayerError)?.code ?? ''}`,
  );

async function retrying<T>(what: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !transient(err)) throw err;
      log(`${what}: transient failure (${(err as Error).message.split('\n')[0]}), retry ${i}/${tries - 1}`);
      await sleep(Math.min(60_000, 5_000 * 2 ** (i - 1)));
    }
  }
}

async function receiptOf(hash: Hex): Promise<TransactionReceipt> {
  return retrying(`receipt ${hash}`, () => client.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS, timeout: 15 * 60_000 }));
}

function track(step: string, action: string, via: TxRecord['via'], r: TransactionReceipt, startedAt?: number): TxRecord {
  if (r.status !== 'success') throw new Error(`${step}: ${action} reverted (${r.transactionHash})`);
  const rec: TxRecord = {
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
  log(`${step}: ${action} via ${via} in block ${r.blockNumber}, gas ${fmt(r.gasUsed)} (${r.transactionHash})`);
  writeRecord();
  return rec;
}

/**
 * Relay a signed action and wait for it through /v1/status. Two refusals are retried, both
 * free (nothing was broadcast):
 *  - SIMULATION_REVERTED: a provider lagging the block the previous action landed in;
 *  - TX_FAILED from a refused broadcast: in this run the relayer's hot key is also the test
 *    adapter's registry, so the direct bind/request/funding transactions move the account
 *    nonce under the relayer's local allocator. The relayer resyncs its nonce from the node
 *    after a refused broadcast, so the next attempt goes through.
 */
async function relay(step: string, action: Action, label: string = action.kind): Promise<TransactionReceipt> {
  const started = Date.now();
  let txHash: Hex | undefined;
  for (let attempt = 1; !txHash; attempt++) {
    try {
      txHash = await relayer.relay(CHAIN_ID, MANAGER, action);
    } catch (err) {
      const code = err instanceof RelayerError ? err.code : '';
      const lagging = code === 'SIMULATION_REVERTED' && attempt < 4;
      const refused = code === 'TX_FAILED' && attempt < 3;
      if (!lagging && !refused && !(transient(err) && attempt < 6)) throw err;
      log(`${step}: relay refused (${(err as Error).message}), retry ${attempt}`);
      await sleep(15_000);
    }
  }
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const st = await retrying('relayer status', () => relayer.status(txHash as Hex));
    if (st.status === 'failed') throw new Error(`${step}: relayed ${label} failed: ${st.revertReason ?? 'reverted'} (${txHash})`);
    if (st.status === 'confirmed') {
      const mined = (st as { minedTxHash?: Hex }).minedTxHash ?? txHash;
      const r = await receiptOf(mined);
      track(step, label, 'relayer', r, started);
      return r;
    }
    if (Date.now() > deadline) throw new Error(`${step}: relayed ${label} still pending (${txHash})`);
    await sleep(POLL_MS);
  }
}

function walletFor(account: PrivateKeyAccount): WalletClient {
  return createWalletClient({ account, chain, transport: transport() });
}

/** The registry side of the test adapter (MockCouncilAdapter): simulate, send, wait. */
async function adapterCall(step: string, wallet: WalletClient, fn: 'register' | 'submit', args: readonly unknown[]) {
  const started = Date.now();
  const { request, result } = await retrying(`${fn} simulation`, () =>
    client.simulateContract({ address: ADAPTER, abi: ADAPTER_ABI, functionName: fn, args, account: wallet.account } as never),
  );
  const hash = await wallet.writeContract(request as never);
  const r = await receiptOf(hash);
  track(step, fn === 'register' ? 'bindProcess' : `submitRequest (fields=${VALUES.length})`, 'adapter', r, started);
  return { receipt: r, result: result as unknown };
}

/**
 * Wait until every provider's finalized head (the authenticated anchor) reaches `block`.
 * Sepolia finalizes two epochs (64 slots, ~12.8 min) behind, in 32-slot steps.
 */
async function waitFinalized(step: string, block: bigint): Promise<void> {
  const started = Date.now();
  let last = -1n;
  for (;;) {
    try {
      const anchor = await reader.finalizedAnchor();
      if (anchor.blockNumber >= block) {
        const w = { step, targetBlock: block, finalizedBlock: anchor.blockNumber, waitedMs: Date.now() - started };
        record.waits.push(w);
        log(`${step}: block ${block} finalized (anchor ${anchor.blockNumber}) after ${ms(w.waitedMs)}`);
        writeRecord();
        return;
      }
      if (anchor.blockNumber !== last) {
        last = anchor.blockNumber;
        log(`${step}: waiting for finality of block ${block}; finalized ${anchor.blockNumber} (${block - anchor.blockNumber} to go)`);
      }
    } catch (err) {
      if (!transient(err)) throw err;
      log(`${step}: finalized head not agreed yet (${(err as Error).message.split('\n')[0]})`);
    }
    await sleep(FINALITY_POLL_MS);
  }
}

async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  log(`── ${step}`);
  try {
    return await fn();
  } finally {
    record.steps.push({ step, ms: Date.now() - started });
    writeRecord();
  }
}

// ─── the ceremony ───────────────────────────────────────────────────────────────────────────

describe.sequential(`Council ceremony on chain ${CHAIN_ID} (n=${N}, t=${T}, real proofs, relayer in front)`, () => {
  const key = loadKey();
  const funder = walletFor(key);
  const throwawayKey = generatePrivateKey();
  const throwaway = privateKeyToAccount(throwawayKey);
  const org = new Organizer(host);
  const members: Member[] = [];
  let cid: Hex;
  let rid: Hex;
  let processId: Hex;
  let publicKey: Point;
  let requestBlock = 0n;
  let relayerAddress: Hex;

  beforeAll(async () => {
    record.throwaway = throwaway.address.toLowerCase() as Hex;
    record.balances.keyStart = await client.getBalance({ address: key.address });
    log(`key ${key.address}: ${formatEther(record.balances.keyStart)} ETH`);
  });

  afterAll(async () => {
    // Return what is left on the throwaway key, then close the record.
    try {
      const bal = await client.getBalance({ address: throwaway.address });
      const fees = await client.estimateFeesPerGas();
      const cost = 21_000n * fees.maxFeePerGas;
      if (bal > cost) {
        const wallet = walletFor(throwaway);
        const hash = await wallet.sendTransaction({
          account: throwaway,
          chain,
          to: key.address,
          value: bal - cost,
          gas: 21_000n,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        track('cleanup', 'sweep throwaway back', 'transfer', await receiptOf(hash));
      }
    } catch (err) {
      record.notes.push(`throwaway sweep failed: ${(err as Error).message.split('\n')[0]}`);
    }
    record.balances.keyEnd = await client.getBalance({ address: key.address }).catch(() => 0n);
    record.finishedAt = new Date().toISOString();
    if (record.result === 'incomplete') record.result = 'failed';
    writeRecord();
    log(`run record: ${RUN_OUT}`);
    console.log(`\n${renderMarkdown()}`);
  });

  it('preflight: the deployment, the release pin, the relayer', async () => {
    await timed('preflight', async () => {
      // Authenticated reads see the manager only once its deployment is finalized.
      await waitFinalized('deployment', BigInt(deployment.deploymentBlock));
      const anchor = await reader.finalizedAnchor(); // every read RPC serves the pinned chain and agrees
      expect(await reader.getCircuitReleaseId(anchor)).toBe(deployment.circuitRelease.circuitReleaseId);
      const registry = (await client.readContract({ address: ADAPTER, abi: ADAPTER_ABI, functionName: 'registry' })) as Hex;
      expect(registry.toLowerCase()).toBe(key.address.toLowerCase());
      const health = await relayer.health();
      expect(health.ok).toBe(true);
      expect(health.chainId).toBe(CHAIN_ID.toString());
      expect(health.manager.toLowerCase()).toBe(MANAGER);
      relayerAddress = health.relayer.toLowerCase() as Hex;
      record.relayer = relayerAddress;
      log(`relayer ${relayerAddress}, balance ${formatEther(BigInt(health.balanceWei))} ETH; finalized anchor ${anchor.blockNumber}`);
    });
  });

  it('the organizer creates the ceremony with 3 invites (bearer token: restricted mode)', async () => {
    await timed('create', async () => {
      const created = await org.create({ threshold: T, invites: N, dealingDuration: 7200n });
      cid = created.cid;
      record.ceremonyId = cid;
      await relay('create', created.action, `createCeremony (invites=${N})`);
    });
  });

  it('three members join from their invite links (relayer)', async () => {
    await timed('join', async () => {
      for (let i = 0; i < N; i++) {
        const m = new Member(host, cid);
        members.push(m);
        await relay('join', await m.join(org.inviteLink(cid, i)), 'join');
      }
    });
  });

  let closeBlock = 0n;
  it('the organizer closes registration (relayer)', async () => {
    await timed('close', async () => {
      closeBlock = (await relay('close', await org.close(cid, N), `closeRegistration (n=${N})`)).blockNumber;
    });
  });

  it('every member approves the frozen roster from finalized state', async () => {
    await timed('roster approval (incl. finality wait)', async () => {
      await waitFinalized('roster approval', closeBlock);
      for (const m of members) await retrying('approveRoster', () => m.approveRoster());
      expect(members.map((m) => m.index).sort()).toEqual([1, 2, 3]);
    });
  });

  it('every member deals with a real proof (relayer)', async () => {
    await timed('deal', async () => {
      for (const m of members) {
        const t0 = Date.now();
        const action = await retrying('deal', () => m.deal());
        log(`member ${m.index}: dealing proven in ${ms(Date.now() - t0)}`);
        await relay('deal', action, `deal (n=${N}, t=${T})`);
      }
    });
  });

  let finalizeBlock = 0n;
  it('finalize as soon as all n have dealt (relayer)', async () => {
    await timed('finalize', async () => {
      finalizeBlock = (await relay('finalize', { kind: 'finalize', ceremonyId: cid }, `finalize (|QUAL|=${N})`)).blockNumber;
      const view = (await client.readContract({
        address: MANAGER,
        abi: COUNCIL_MANAGER_ABI,
        functionName: 'getCeremony',
        args: [cid],
      })) as { phase: number; qualBitmap: number };
      expect(view.phase).toBe(3); // Live (latest)
      expect(view.qualBitmap).toBe(0b111);
    });
  });

  it('the organizer allows the test adapter and the creator (relayer)', async () => {
    await timed('authorize', async () => {
      await relay('authorize', await org.allowAdapter(cid, ADAPTER), 'allowAdapter');
      await relay('authorize', await org.authorizeCreator(cid, key.address.toLowerCase() as Hex), 'authorizeCreator');
    });
  });

  it('bind a process through the adapter and submit the request with known ciphertexts', async () => {
    await timed('bind + request', async () => {
      const wallet = funder;
      processId = randomProcessId();
      record.processId = processId;
      const { result } = await adapterCall('bind', wallet, 'register', [processId, key.address, cid]);
      const [, boundRid, pkX, pkY] = result as readonly [Hex, Hex, bigint, bigint];
      rid = boundRid;
      record.requestId = rid;
      expect(rid).toBe(computeRequestId(CHAIN_ID, MANAGER, cid, ADAPTER, processId));
      // The requester encrypts under the key bindProcess returned on chain; it is checked
      // against the authenticated read below once finalized.
      publicKey = { x: pkX, y: pkY };
      record.publicKey = publicKey;
      const cts = VALUES.map((m) => {
        const { c1, c2 } = elgamalEncrypt(publicKey, m, sampleNonce());
        return [c1.x, c1.y, c2.x, c2.y] as const;
      });
      requestBlock = (await adapterCall('request', wallet, 'submit', [cid, rid, cts])).receipt.blockNumber;
    });
  });

  it('two members compute partials from finalized state: one direct (throwaway key), one relayed', async () => {
    await timed('partials (incl. finality wait)', async () => {
      await waitFinalized('partials', requestBlock);
      expect(finalizeBlock).toBeLessThanOrEqual(requestBlock);
      // Authenticated: the key the request was encrypted under is the ceremony's key.
      expect(await retrying('getPublicKey', () => reader.getPublicKey(cid))).toEqual(publicKey);
      const req = await retrying('getRequest', () => reader.getRequest(rid));
      expect(req.fieldCount).toBe(VALUES.length);

      const fund = await funder.sendTransaction({ account: key, chain, to: throwaway.address, value: THROWAWAY_FUND });
      track('partials', `fund throwaway (${formatEther(THROWAWAY_FUND)} ETH)`, 'transfer', await receiptOf(fund));

      const direct = members.find((m) => m.index === DIRECT_MEMBER) as Member;
      const relayedMember = members.find((m) => m.index === RELAYED_MEMBER) as Member;
      let t0 = Date.now();
      const directAction = await retrying('partial', () => direct.partial(rid));
      log(`member ${DIRECT_MEMBER}: partial proven in ${ms(Date.now() - t0)}`);
      t0 = Date.now();
      const sent = await retrying('direct partial', () => reader.sendAction(walletFor(throwaway) as never, directAction));
      track('partials', `submitPartial (fields=${VALUES.length})`, 'direct', await receiptOf(sent), t0);

      t0 = Date.now();
      const relayedAction = await retrying('partial', () => relayedMember.partial(rid));
      log(`member ${RELAYED_MEMBER}: partial proven in ${ms(Date.now() - t0)}`);
      await relay('partials', relayedAction, `submitPartial (fields=${VALUES.length})`);
    });
  });

  let combineBlock = 0n;
  it("the relayer's combine worker solves and combines every field", async () => {
    await timed('combine (worker)', async () => {
      const deadline = Date.now() + 20 * 60_000;
      for (;;) {
        const [ready] = (await retrying('getPlaintexts', () =>
          client.readContract({ address: MANAGER, abi: COUNCIL_MANAGER_ABI, functionName: 'getPlaintexts', args: [rid] }),
        )) as readonly [boolean, readonly bigint[]];
        if (ready) break;
        if (Date.now() > deadline) throw new Error('the relayer did not combine in time');
        await sleep(POLL_MS * 2);
      }
      const logs = await retrying('FieldsCombined logs', () =>
        client.getContractEvents({
          address: MANAGER,
          abi: COUNCIL_MANAGER_ABI,
          eventName: 'FieldsCombined',
          args: { requestId: rid },
          fromBlock: requestBlock,
        }),
      );
      expect(logs.length).toBeGreaterThan(0);
      for (const l of logs) {
        const r = await receiptOf(l.transactionHash as Hex);
        const fields = (l.args as { fieldIndexes: readonly number[] }).fieldIndexes.length;
        const sender = r.from.toLowerCase() as Hex;
        track('combine', `combine (t=${T}, fields=${fields})`, sender === relayerAddress ? 'relayer (worker)' : 'direct', r);
        expect(sender).toBe(relayerAddress);
        if (r.blockNumber > combineBlock) combineBlock = r.blockNumber;
        const tx = await client.getTransaction({ hash: l.transactionHash as Hex });
        const { args } = decodeFunctionData({ abi: COUNCIL_MANAGER_ABI, data: tx.input });
        record.memberSet = [...((args as readonly unknown[])[1] as readonly number[])];
      }
      expect(record.memberSet).toEqual([DIRECT_MEMBER, RELAYED_MEMBER]);
    });
  });

  it('the plaintexts, read from finalized state, are the known values', async () => {
    await timed('result (incl. finality wait)', async () => {
      await waitFinalized('result', combineBlock);
      const { ready, values } = await retrying('getPlaintexts', () => reader.getPlaintexts(rid));
      expect(ready).toBe(true);
      expect(values).toEqual(VALUES);
      record.plaintexts = values;
      const [adapterReady, adapterValues] = (await client.readContract({
        address: ADAPTER,
        abi: ADAPTER_ABI,
        functionName: 'plaintexts',
        args: [cid, rid, 0, VALUES.length],
      })) as readonly [boolean, readonly bigint[]];
      expect(adapterReady).toBe(true);
      expect([...adapterValues]).toEqual(VALUES);
      record.result = 'success';
    });
  });
});
