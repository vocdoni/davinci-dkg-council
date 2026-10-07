/**
 * DAVINCI + Council on Gnosis Chain, end to end with real proofs, against the TEST deployment in
 * deployment.json (Council v2 on the circuits-v1 development setup, a ProcessRegistry from the
 * unreleased davinci-contracts `council` branch). Every proof is real: Council dealings and
 * partials (snarkjs), DAVINCI ballots (davinci-sdk, snarkjs) and the state transitions (a
 * davinci-sequencer `council` build proving on a davinci-zkvm prover).
 *
 *   Council (relayer in front, n = 3, t = 2, authenticated reads at finalized blocks)
 *     ceremony A: Manual decryption with a 30-day fallback; ceremony B: Scheduled decryption.
 *     create -> 3 joins -> close -> [finality] roster approval -> 3 proven dealings -> finalize
 *     -> allow the registry's councilAdapter() -> authorize the DAVINCI organizer as creator
 *   DAVINCI (davinci-sdk, keyMode 'council', the test sequencer)
 *     (a) process on A, 3 voters: vote, settle, end; the sequencer requests the decryption while
 *         the gate is closed ('awaiting-opening'); the organizer opens A; members 1 and 3 post
 *         partials; the relayer combines; the sequencer finalizes; waitForResults has the tally.
 *     (c) process on A, no votes: ended at once; the request carries no ciphertext (no Council
 *         request); 'awaiting-opening' until A opens, then the sequencer publishes the zeros.
 *     (b) process on B, 3 voters, ending a few minutes before B's scheduled opening: the request
 *         lands while closed; the gate opens by date; members 2 and 3 decrypt.
 *
 * Launched by run.sh (see there for the environment). Secrets (the organizer and member recovery
 * phrases, the voter keys) go to a 0600 file in COUNCIL_RUN_DIR so a run can be inspected or
 * resumed (COUNCIL_RESUME=<that file> reuses its Live ceremonies); the run record (JSON +
 * Markdown) holds addresses, transaction hashes, states and timings only.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COUNCIL_MANAGER_ABI,
  CouncilClient,
  PhaseMode,
  RelayerClient,
  RelayerError,
  requestId as computeRequestId,
  SnarkjsProver,
  type Action,
  type Hex,
} from '@vocdoni/davinci-dkg-council-sdk';
import {
  DavinciSDK,
  FailoverRpcProvider,
  KeyMode,
  OffchainCensus,
  ProcessStatus,
  VoteError,
  VoteStatus,
  type ProcessResults,
  type ResultsStatus,
  type Uploader,
} from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';
import { createPublicClient, defineChain, fallback, formatEther, http, type PublicClient, type TransactionReceipt } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Member, Organizer, type ActorHost } from '../../tests/src/actors.js';
import { devCircuitRelease } from '../../tests/src/deploy.js';

// ─── configuration ──────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = (name: string, fallbackValue?: string): string => {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallbackValue !== undefined) return fallbackValue;
  throw new Error(`${name} is required (run through scripts/davinci-gnosis/run.sh)`);
};
const list = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

interface Deployment {
  chainId: number;
  council: { manager: Hex; deploymentBlock: number; circuitReleaseId: Hex };
  davinci: { processRegistry: Hex; deploymentBlock: number; councilAdapter: Hex; grace: { default: number } };
  rpcUrls: string[];
}
const deployment = JSON.parse(readFileSync(path.join(HERE, 'deployment.json'), 'utf8')) as Deployment;
const CHAIN_ID = BigInt(deployment.chainId);
const MANAGER = deployment.council.manager.toLowerCase() as Hex;
const REGISTRY = deployment.davinci.processRegistry.toLowerCase() as Hex;
const ADAPTER = deployment.davinci.councilAdapter.toLowerCase() as Hex;
const RPCS = list(env('COUNCIL_RPC_URL', deployment.rpcUrls.join(',')));
const RUN_DIR = env('COUNCIL_RUN_DIR', path.join(homedir(), '.davinci-gnosis', 'council-davinci'));
const RELAYER_URL = env('COUNCIL_RELAYER_URL', 'http://127.0.0.1:8797');
const RELAYER_TOKEN = readFileSync(env('COUNCIL_RELAYER_TOKEN_FILE', path.join(RUN_DIR, 'relayer.token')), 'utf8').trim();
const SEQUENCER_URL = env('DAVINCI_SEQUENCER_URL', 'http://127.0.0.1:9095');
const FILES_DIR = env('DAVINCI_FILES_DIR', path.join(homedir(), '.davinci-gnosis', 'sequencer-council-test', 'files'));
const FILES_URL = env('DAVINCI_FILES_URL', 'http://172.17.0.1:8099');
const ARTIFACT_CACHE = env('DAVINCI_SDK_ARTIFACTS', path.join(homedir(), '.cache', 'davinci-sdk-e2e', 'artifacts'));
const ORGANIZER_KEY_FILE = env('DAVINCI_ORGANIZER_KEY_FILE');
/** Ceremony B opens this many minutes after its creation; process B ends 7 minutes before. */
const B_OPEN_AFTER_MIN = Number(env('COUNCIL_B_OPEN_AFTER_MIN', '75'));
const B_END_BEFORE_OPEN_S = 420n;
const RESUME = process.env.COUNCIL_RESUME?.trim();
const POLL_MS = 6_000;
const FINALITY_POLL_MS = 15_000;

const N = 3;
const T = 2;
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const RECORD_OUT = path.join(RUN_DIR, `run-${STAMP}.json`);
const SECRETS_OUT = path.join(RUN_DIR, `secrets-${STAMP}.json`);

const chain = defineChain({
  id: deployment.chainId,
  name: 'Gnosis',
  nativeCurrency: { name: 'xDAI', symbol: 'XDAI', decimals: 18 },
  rpcUrls: { default: { http: RPCS } },
});

/** The ballots of the voted processes and the tallies they must give. */
const A_QUESTION = { title: 'Rate each proposal (0 to 5)', choices: ['Bike lanes', 'Library hours', 'Tree planting'] };
const A_BALLOTS = [
  [1, 2, 3],
  [5, 0, 1],
  [2, 2, 2],
];
const B_QUESTION = { title: 'Where should the next meetup be?', choices: ['Library', 'Park', 'Online'] };
const B_BALLOTS = [
  [1, 0, 0],
  [0, 0, 1],
  [0, 0, 1],
];
const tally = (ballots: number[][]): bigint[] =>
  ballots[0]!.map((_, i) => ballots.reduce((s, b) => s + BigInt(b[i]!), 0n));

// ─── records ────────────────────────────────────────────────────────────────────────────────

interface TxRecord {
  step: string;
  action: string;
  via: string;
  hash: string;
  from: string;
  block: number;
  gasUsed: string;
  costWei: string;
}
interface StateSample {
  at: string;
  state: string;
  status: number;
  resultsRequested: boolean;
  gateOpen?: boolean;
}

const record = {
  startedAt: new Date().toISOString(),
  finishedAt: '',
  result: 'incomplete' as 'incomplete' | 'success' | 'failed',
  chainId: deployment.chainId,
  manager: MANAGER,
  registry: REGISTRY,
  councilAdapter: ADAPTER,
  sequencer: '' as string,
  relayer: '' as string,
  davinciOrganizer: '' as string,
  ceremonies: {} as Record<string, { cid: Hex; policy: string; liveAt?: string; openedAt?: string; openTx?: string }>,
  processes: {} as Record<
    string,
    {
      pid: string;
      ceremony: string;
      requestId: string;
      createTx?: string;
      votes: { voteId: string; statuses: string[]; settledAfterMs?: number }[];
      states: StateSample[];
      waitForResultsStates: string[];
      events: { name: string; block: number; tx: string }[];
      expected: string[];
      values?: string[];
      endedAt?: string;
      requestedAt?: string;
      resultsAt?: string;
      decryptors?: number[];
    }
  >,
  txs: [] as TxRecord[],
  steps: [] as { step: string; ms: number }[],
  balances: {} as Record<string, { start: string; end?: string }>,
  notes: [] as string[],
};

function writeAtomic(file: string, body: string, mode = 0o644): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body, { mode });
  renameSync(tmp, file);
  chmodSync(file, mode);
}
const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x), 2);
const writeRecord = () => writeAtomic(RECORD_OUT, `${json(record)}\n`);

/** Secrets of this run: recovery phrases and voter keys. 0600, never printed. */
const secrets = {
  ceremonies: {} as Record<string, { cid: Hex; policy: string; openAt?: string; organizer: string; members: string[] }>,
  voters: {} as Record<string, string[]>,
};
const writeSecrets = () => writeAtomic(SECRETS_OUT, `${json(secrets)}\n`, 0o600);

const log = (msg: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sleep = (n: number): Promise<void> => new Promise((r) => setTimeout(r, n));
const ms = (n: number): string => (n >= 60_000 ? `${(n / 60_000).toFixed(1)} min` : `${(n / 1000).toFixed(1)} s`);

async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  log(`── ${step}`);
  try {
    return await fn();
  } finally {
    record.steps.push({ step, ms: Date.now() - started });
    log(`── ${step}: ${ms(Date.now() - started)}`);
    writeRecord();
  }
}

// ─── chain plumbing ─────────────────────────────────────────────────────────────────────────

const client = createPublicClient({
  chain,
  transport: fallback(RPCS.map((u) => http(u, { timeout: 30_000, retryCount: 3 }))),
  cacheTime: 0,
  pollingInterval: POLL_MS,
}) as PublicClient;
const reader = new CouncilClient({ chainId: CHAIN_ID, manager: MANAGER, rpcUrls: RPCS });
const relayer = new RelayerClient(RELAYER_URL, {
  fetchFn: (input, init) =>
    fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${RELAYER_TOKEN}` } }),
});
const release = devCircuitRelease();
const prover = new SnarkjsProver({
  deal: { wasm: release.wasm.deal, zkey: release.zkey.deal },
  partial: { wasm: release.wasm.partial, zkey: release.zkey.partial },
});
const chainNow = async () => (await client.getBlock({ blockTag: 'latest' })).timestamp;
const host: ActorHost = {
  chainId: CHAIN_ID,
  manager: MANAGER,
  reader,
  prover,
  now: chainNow,
  validUntil: async (seconds = 3600n) => (await chainNow()) + seconds,
};

const transient = (err: unknown): boolean =>
  /disagree|not finalized|fetch failed|timed? ?out|429|rate.?limit|too many|ECONNRESET|socket|HTTP request failed|50[234]|BUSY|INTERNAL|header not found|missing trie node|could not coalesce|UnknownCeremony/i.test(
    `${(err as Error)?.message ?? String(err)} ${(err as RelayerError)?.code ?? ''}`,
  );

async function retrying<T>(what: string, fn: () => Promise<T>, tries = 8): Promise<T> {
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

function track(step: string, action: string, via: string, r: TransactionReceipt): void {
  if (r.status !== 'success') throw new Error(`${step}: ${action} reverted (${r.transactionHash})`);
  record.txs.push({
    step,
    action,
    via,
    hash: r.transactionHash,
    from: r.from.toLowerCase(),
    block: Number(r.blockNumber),
    gasUsed: r.gasUsed.toString(),
    costWei: (r.gasUsed * r.effectiveGasPrice).toString(),
  });
  log(`${step}: ${action} via ${via} in block ${r.blockNumber}, gas ${r.gasUsed} (${r.transactionHash})`);
  writeRecord();
}

const receiptOf = (hash: Hex) =>
  retrying(`receipt ${hash}`, () => client.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS, timeout: 15 * 60_000 }));

/** Relay a signed Council action and wait for it (the Sepolia script's loop). */
async function relay(step: string, action: Action, label: string = action.kind): Promise<TransactionReceipt> {
  let txHash: Hex | undefined;
  for (let attempt = 1; !txHash; attempt++) {
    try {
      txHash = await relayer.relay(CHAIN_ID, MANAGER, action);
    } catch (err) {
      const code = err instanceof RelayerError ? err.code : '';
      const lagging = code === 'SIMULATION_REVERTED' && attempt < 6;
      if (!lagging && !(transient(err) && attempt < 8)) throw err;
      log(`${step}: relay refused (${(err as Error).message.split('\n')[0]}), retry ${attempt}`);
      await sleep(10_000);
    }
  }
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const st = await retrying('relayer status', () => relayer.status(txHash as Hex));
    if (st.status === 'failed') throw new Error(`${step}: relayed ${label} failed: ${st.revertReason ?? 'reverted'} (${txHash})`);
    if (st.status === 'confirmed') {
      const mined = (st as { minedTxHash?: Hex }).minedTxHash ?? txHash;
      const r = await receiptOf(mined);
      track(step, label, 'relayer', r);
      return r;
    }
    if (Date.now() > deadline) throw new Error(`${step}: relayed ${label} still pending (${txHash})`);
    await sleep(POLL_MS);
  }
}

/** Until every read RPC's finalized head (the authenticated anchor) reaches `block`. */
async function waitFinalized(step: string, block: bigint): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const anchor = await reader.finalizedAnchor();
      if (anchor.blockNumber >= block) {
        log(`${step}: block ${block} finalized (anchor ${anchor.blockNumber}) after ${ms(Date.now() - started)}`);
        return;
      }
    } catch (err) {
      if (!transient(err)) throw err;
    }
    await sleep(FINALITY_POLL_MS);
  }
}

// ─── Council: ceremonies ────────────────────────────────────────────────────────────────────

interface Ceremony {
  name: string;
  cid: Hex;
  org: Organizer;
  members: Member[];
  openAt?: bigint;
}

type Policy = { kind: 'manual'; fallbackAt: bigint } | { kind: 'scheduled'; openAt: bigint };
const policyText = (p: Policy) =>
  p.kind === 'manual'
    ? `Manual decryption, fallback ${new Date(Number(p.fallbackAt) * 1000).toISOString()}`
    : `Scheduled decryption at ${new Date(Number(p.openAt) * 1000).toISOString()}`;

/** A Live n = 3, t = 2 ceremony that allows the registry's adapter and the DAVINCI organizer. */
async function liveCeremony(name: string, policy: Policy, creator: Hex): Promise<Ceremony> {
  const org = new Organizer(host);
  const created = await org.create({
    threshold: T,
    invites: N,
    dealingDuration: 7200n,
    decryptionMode: policy.kind === 'manual' ? PhaseMode.Manual : PhaseMode.Scheduled,
    decryptionOpenAt: policy.kind === 'scheduled' ? policy.openAt : 0n,
    manualDecryptionFallbackAt: policy.kind === 'manual' ? policy.fallbackAt : 0n,
  });
  const cid = created.cid;
  secrets.ceremonies[name] = {
    cid,
    policy: policyText(policy),
    ...(policy.kind === 'scheduled' && { openAt: policy.openAt.toString() }),
    organizer: org.mnemonic,
    members: [],
  };
  writeSecrets();
  record.ceremonies[name] = { cid, policy: policyText(policy) };
  log(`${name}: ceremony ${cid} (${policyText(policy)})`);
  await relay(`${name} create`, created.action, `createCeremony (invites=${N})`);

  const members: Member[] = [];
  let lastJoin = 0n;
  for (let i = 0; i < N; i++) {
    const m = new Member(host, cid);
    members.push(m);
    secrets.ceremonies[name]!.members.push(m.mnemonic);
    writeSecrets();
    lastJoin = (await relay(`${name} join`, await m.join(org.inviteLink(cid, i)), 'join')).blockNumber;
  }
  // The organizer reads the joined keys it closes over from finalized state.
  await waitFinalized(`${name} joins`, lastJoin);
  const closed = await relay(`${name} close`, await org.close(cid, N), `closeRegistration (n=${N})`);
  await waitFinalized(`${name} roster`, closed.blockNumber);
  for (const m of members) await retrying(`${name} approveRoster`, () => m.approveRoster());
  expect(members.map((m) => m.index).sort()).toEqual([1, 2, 3]);
  for (const m of members) {
    const t0 = Date.now();
    const action = await retrying(`${name} deal`, () => m.deal());
    log(`${name}: member ${m.index} dealing proven in ${ms(Date.now() - t0)}`);
    await relay(`${name} deal`, action, `deal (n=${N}, t=${T})`);
  }
  await relay(`${name} finalize`, { kind: 'finalize', ceremonyId: cid }, `finalize (|QUAL|=${N})`);
  await relay(`${name} grants`, await org.allowAdapter(cid, ADAPTER), 'allowAdapter (registry councilAdapter)');
  await relay(`${name} grants`, await org.authorizeCreator(cid, creator), 'authorizeCreator (DAVINCI organizer)');
  record.ceremonies[name]!.liveAt = new Date().toISOString();
  return { name, cid, org, members, ...(policy.kind === 'scheduled' && { openAt: policy.openAt }) };
}

/** A ceremony of an earlier run (COUNCIL_RESUME), Live and granted. */
async function resumedCeremony(name: string, creator: Hex): Promise<Ceremony | undefined> {
  if (!RESUME) return undefined;
  const saved = (JSON.parse(readFileSync(RESUME, 'utf8')) as typeof secrets).ceremonies[name];
  if (!saved) return undefined;
  const org = new Organizer(host, saved.organizer);
  const members = saved.members.map((mn) => new Member(host, saved.cid, mn));
  for (const m of members) await retrying(`${name} approveRoster`, () => m.approveRoster());
  const view = await reader.getCeremony(saved.cid);
  expect(view.phase).toBe(3);
  const manager = (functionName: string, args: readonly unknown[]) =>
    client.readContract({ address: MANAGER, abi: COUNCIL_MANAGER_ABI, functionName, args } as never) as Promise<boolean>;
  expect(await manager('isAdapterAllowed', [saved.cid, ADAPTER])).toBe(true);
  expect(await manager('isCreatorAuthorized', [saved.cid, creator])).toBe(true);
  secrets.ceremonies[name] = saved;
  writeSecrets();
  record.ceremonies[name] = { cid: saved.cid, policy: saved.policy };
  record.notes.push(`${name}: resumed ceremony ${saved.cid} from an earlier run`);
  log(`${name}: resumed ${saved.cid} (${saved.policy}), creator ${creator}`);
  return { name, cid: saved.cid, org, members, ...(saved.openAt && { openAt: BigInt(saved.openAt) }) };
}

/** Members `indexes` post proven partials for `rid` through the relayer, once the gate is open in a finalized snapshot. */
async function decrypt(label: string, cer: Ceremony, rid: Hex, indexes: number[]): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      if (await reader.isDecryptionOpen(cer.cid)) break; // authenticated: at the finalized anchor
    } catch (err) {
      if (!transient(err)) throw err;
    }
    await sleep(FINALITY_POLL_MS);
  }
  log(`${label}: the gate of ${cer.name} is open in a finalized snapshot (${ms(Date.now() - started)})`);
  for (const index of indexes) {
    const m = cer.members.find((x) => x.index === index) as Member;
    const t0 = Date.now();
    const action = await retrying(`${label} partial`, () => m.partial(rid));
    log(`${label}: member ${index} partial proven in ${ms(Date.now() - t0)}`);
    await relay(`${label} partial`, action, `submitPartial (member ${index})`);
  }
}

// ─── DAVINCI ────────────────────────────────────────────────────────────────────────────────

const network = {
  name: 'gnosis (Council test registry)',
  chainId: deployment.chainId,
  processRegistry: REGISTRY,
  startBlock: deployment.davinci.deploymentBlock,
  rpcUrls: RPCS,
};

/** Files on disk, served at FILES_URL to this host and to the test sequencer (private hosts allowed on both). */
const uploader: Uploader = {
  upload: async ({ data, sha256 }) => {
    const name = `${sha256.slice(2)}.json`;
    mkdirSync(FILES_DIR, { recursive: true });
    writeFileSync(path.join(FILES_DIR, `${name}.tmp`), data);
    renameSync(path.join(FILES_DIR, `${name}.tmp`), path.join(FILES_DIR, name));
    return `${FILES_URL}/${name}`;
  },
};

/** The SDK keeps checked circuit files here between runs (one file per sha256). */
const artifactMemory = new Map<string, Uint8Array>();
const artifactCache = {
  get(sha256: string): Uint8Array | undefined {
    const file = path.join(ARTIFACT_CACHE, sha256.replace(/^0x/, '').toLowerCase());
    let data = artifactMemory.get(file);
    if (!data && existsSync(file)) artifactMemory.set(file, (data = new Uint8Array(readFileSync(file))));
    return data;
  },
  set(sha256: string, data: Uint8Array): void {
    const file = path.join(ARTIFACT_CACHE, sha256.replace(/^0x/, '').toLowerCase());
    mkdirSync(ARTIFACT_CACHE, { recursive: true });
    artifactMemory.set(file, data);
    writeFileSync(file, data);
  },
};

function davinci(signer: Wallet): DavinciSDK {
  return new DavinciSDK({
    signer,
    network,
    sequencerUrls: [SEQUENCER_URL],
    uploader,
    documents: { allowPrivateHosts: true },
    artifacts: { cache: artifactCache },
  });
}

interface Proc {
  label: string;
  pid: string;
  rid: Hex;
  cer: Ceremony;
  creationBlock: number;
}

/** Cast `ballots`, one voter each, retrying while the node is not serving the process yet. */
async function castVotes(p: Proc, voters: Wallet[], ballots: number[][]): Promise<void> {
  const rec = record.processes[p.label]!;
  const casts = await Promise.all(
    voters.map(async (w, i) => {
      const sdk = davinci(w);
      await sdk.init();
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        try {
          const t0 = Date.now();
          const r = await sdk.submitVote({ processId: p.pid, choices: ballots[i]! });
          log(`${p.label}: voter ${i} cast ${r.voteId} (ballot proven and sent in ${ms(Date.now() - t0)})`);
          return { sdk, voteId: r.voteId, node: r.node, sentAt: Date.now() };
        } catch (err) {
          const retry = err instanceof VoteError && ['busy', 'unavailable', 'not-started'].includes(err.reason);
          if (!retry || Date.now() > deadline) throw err;
          log(`${p.label}: voter ${i}: ${err.reason}, retrying`);
          await sleep(10_000);
        }
      }
    }),
  );
  await Promise.all(
    casts.map(async (c) => {
      const statuses: string[] = [];
      for await (const s of c.sdk.watchVoteStatus(p.pid, c.voteId, { node: c.node, timeoutMs: 45 * 60_000 })) {
        statuses.push(s.status);
        if (s.status === VoteStatus.Error) throw new Error(`${p.label}: vote ${c.voteId} failed: ${s.error}`);
      }
      expect(statuses.at(-1)).toBe(VoteStatus.Settled);
      rec.votes.push({ voteId: c.voteId, statuses, settledAfterMs: Date.now() - c.sentAt });
      log(`${p.label}: ${c.voteId} ${statuses.join(' > ')}`);
      writeRecord();
    }),
  );
}

/**
 * Samples the results state, the registry status and the request flag every 10 s until the
 * results are on chain, recording every change: the evidence that the sequencer requested the
 * decryption while the Council gate was still closed.
 */
function sample(sdk: DavinciSDK, p: Proc): { stop: () => void; done: Promise<void> } {
  let stopped = false;
  const rec = record.processes[p.label]!;
  const done = (async () => {
    let last = '';
    while (!stopped) {
      try {
        const [st, onchain] = await Promise.all([sdk.getResultsStatus(p.pid), sdk.registry.getProcess(p.pid)]);
        const s: StateSample = {
          at: new Date().toISOString(),
          state: st.state,
          status: Number(onchain.status),
          resultsRequested: Boolean(onchain.dkg?.resultsRequested),
        };
        const key = `${s.state}|${s.status}|${s.resultsRequested}`;
        if (key !== last) {
          last = key;
          rec.states.push(s);
          if (s.resultsRequested && !rec.requestedAt) rec.requestedAt = s.at;
          if (s.state === 'results' && !rec.resultsAt) rec.resultsAt = s.at;
          log(`${p.label}: state ${s.state}, status ${s.status}, resultsRequested ${s.resultsRequested}`);
          writeRecord();
        }
        if (st.state === 'results' || st.state === 'canceled') return;
      } catch (err) {
        log(`${p.label}: sample failed (${(err as Error).message.split('\n')[0]})`);
      }
      await sleep(10_000);
    }
  })();
  return { stop: () => (stopped = true), done };
}

/** Until the sampler saw the request land while the gate was closed. */
async function untilRequestedWhileClosed(p: Proc, timeoutMs: number): Promise<StateSample> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = record.processes[p.label]!.states.find((s) => s.state === 'awaiting-opening' && s.resultsRequested);
    if (hit) return hit;
    const passed = record.processes[p.label]!.states.find((s) => ['decrypting', 'finalizable', 'results'].includes(s.state));
    if (passed) throw new Error(`${p.label}: reached ${passed.state} without an 'awaiting-opening' request first`);
    if (Date.now() > deadline) throw new Error(`${p.label}: no decryption request within ${ms(timeoutMs)}`);
    await sleep(5_000);
  }
}

/** waitForResults through the SDK, recording each state it reports. */
function results(sdk: DavinciSDK, p: Proc): Promise<ProcessResults> {
  const rec = record.processes[p.label]!;
  return sdk.waitForResults(p.pid, {
    timeoutMs: 3 * 60 * 60_000,
    pollIntervalMs: 10_000,
    onStatus: (s: ResultsStatus) => {
      rec.waitForResultsStates.push(s.state);
      const opening = s.decryptionOpening
        ? ` (${s.decryptionOpening.mode}, opens ${s.decryptionOpening.opensAt?.toISOString() ?? 'when the organizer opens it'})`
        : '';
      log(`${p.label}: waitForResults ${s.state}${opening}`);
      writeRecord();
    },
  });
}

/**
 * The process's registry events and its Council request's events, each transaction's gas and
 * sender added to the record (the sequencer's settlements, request and finalization, the
 * relayer's combines, the organizer's creation and end).
 */
async function collectEvents(sdk: DavinciSDK, p: Proc): Promise<void> {
  const events = await retrying('registry events', () => sdk.registry.queryEvents({ processId: p.pid, fromBlock: p.creationBlock }));
  const council = await retrying('council events', async () => {
    const out: { name: string; block: number; tx: string }[] = [];
    for (const eventName of ['RequestSubmitted', 'FieldsCombined'] as const) {
      const logs = await client.getContractEvents({
        address: MANAGER,
        abi: COUNCIL_MANAGER_ABI,
        eventName,
        args: { requestId: p.rid },
        fromBlock: BigInt(p.creationBlock),
      } as never);
      for (const l of logs as { blockNumber: bigint; transactionHash: Hex }[]) {
        out.push({ name: `${eventName} (Council)`, block: Number(l.blockNumber), tx: l.transactionHash });
      }
    }
    return out;
  });
  const all = [...events.map((e) => ({ name: e.name, block: e.blockNumber, tx: e.transactionHash })), ...council].sort(
    (x, y) => x.block - y.block,
  );
  record.processes[p.label]!.events = all;
  const seen = new Set(record.txs.map((t) => t.hash.toLowerCase()));
  for (const e of all) {
    if (seen.has(e.tx.toLowerCase())) continue;
    seen.add(e.tx.toLowerCase());
    const r = await receiptOf(e.tx as Hex);
    const from = r.from.toLowerCase();
    const via = from === record.sequencer.toLowerCase() ? 'sequencer' : from === record.relayer ? 'relayer (worker)' : from === record.davinciOrganizer ? 'organizer' : 'other';
    const names = all.filter((x) => x.tx === e.tx).map((x) => x.name);
    track(`(${p.label}) ${names[0]}`, [...new Set(names)].join(' + '), via, r);
  }
  writeRecord();
}

// ─── the run ────────────────────────────────────────────────────────────────────────────────

describe.sequential('DAVINCI + Council on Gnosis (n=3, t=2, real proofs)', () => {
  const orgKey = (() => {
    let k = readFileSync(ORGANIZER_KEY_FILE, 'utf8').trim();
    if (!k.startsWith('0x')) k = `0x${k}`;
    return k;
  })();
  const provider = new FailoverRpcProvider(RPCS, deployment.chainId);
  const orgWallet = new Wallet(orgKey, provider);
  const creator = orgWallet.address.toLowerCase() as Hex;
  let sdk: DavinciSDK;
  let A: Ceremony;
  let B: Ceremony;
  const procs: Record<'a' | 'b' | 'c', Proc> = {} as never;
  const voters: Record<'a' | 'b', Wallet[]> = {
    a: A_BALLOTS.map(() => new Wallet(Wallet.createRandom().privateKey)),
    b: B_BALLOTS.map(() => new Wallet(Wallet.createRandom().privateKey)),
  };
  const balanceOf = async (a: string) => client.getBalance({ address: a as Hex });
  const watched: string[] = [];

  beforeAll(async () => {
    mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
    secrets.voters = { a: voters.a.map((w) => w.privateKey), b: voters.b.map((w) => w.privateKey) };
    writeSecrets();
    const health = await relayer.health();
    record.relayer = health.relayer.toLowerCase();
    record.davinciOrganizer = creator;
    const info = (await (await fetch(`${SEQUENCER_URL}/info`)).json()) as { sequencerAddress: string };
    record.sequencer = info.sequencerAddress;
    watched.push(record.relayer, creator, record.sequencer);
    for (const a of watched) record.balances[a] = { start: (await balanceOf(a)).toString() };
    log(`run record ${RECORD_OUT}; secrets ${SECRETS_OUT} (0600)`);
  });

  afterAll(async () => {
    for (const a of watched) {
      const b = record.balances[a];
      if (b) b.end = (await balanceOf(a).catch(() => 0n)).toString();
    }
    record.finishedAt = new Date().toISOString();
    if (record.result === 'incomplete') record.result = 'failed';
    writeRecord();
    log(`run record: ${RECORD_OUT}`);
    for (const [a, b] of Object.entries(record.balances)) {
      log(`${a}: ${formatEther(BigInt(b.start))} -> ${formatEther(BigInt(b.end ?? b.start))} xDAI`);
    }
  });

  it('preflight: the registry, its Council adapter, the sequencer, the relayer', async () => {
    await timed('preflight', async () => {
      sdk = davinci(orgWallet);
      await sdk.init(); // checks the registry pins and the node's /info against it
      expect((await sdk.registry.getCouncilAdapter())?.toLowerCase()).toBe(ADAPTER);
      expect(sdk.nodeChecks.map((n) => n.status)).toEqual(['usable']);
      expect(await reader.getCircuitReleaseId()).toBe(deployment.council.circuitReleaseId);
      const health = await relayer.health();
      expect(health.manager.toLowerCase()).toBe(MANAGER);
      expect(BigInt(await orgWallet.provider!.getBalance(creator))).toBeGreaterThan(10n ** 15n);
    });
  });

  it('Council: ceremonies A (manual opening) and B (scheduled opening) go Live and grant the adapter and the creator', async () => {
    await timed('ceremonies A and B', async () => {
      const now = await chainNow();
      const resumedA = await resumedCeremony('A', creator);
      const resumedB = await resumedCeremony('B', creator);
      [A, B] = await Promise.all([
        resumedA ?? liveCeremony('A', { kind: 'manual', fallbackAt: now + 30n * 86_400n }, creator),
        resumedB ?? liveCeremony('B', { kind: 'scheduled', openAt: now + BigInt(B_OPEN_AFTER_MIN * 60) }, creator),
      ]);
      for (const c of [A, B]) {
        // Authenticated reads pin a finalized block: wait until it shows the ceremony Live.
        const deadline = Date.now() + 15 * 60_000;
        while ((await retrying('getCeremony', () => reader.getCeremony(c.cid))).phase !== 3 && Date.now() < deadline) {
          await sleep(FINALITY_POLL_MS);
        }
        const view = await reader.getCeremony(c.cid);
        expect(view.phase).toBe(3); // Live
        expect(view.qualBitmap).toBe(0b111);
        expect(await reader.isDecryptionOpen(c.cid)).toBe(false);
      }
    });
  });

  it('DAVINCI: three council-keyed processes, created through davinci-sdk with the ceremony key', async () => {
    await timed('create processes', async () => {
      const make = async (label: 'a' | 'b' | 'c', cer: Ceremony, q: typeof A_QUESTION, preset: unknown, members: string[], timing: unknown) => {
        const census = new OffchainCensus();
        census.add(members);
        const created = await sdk.createProcess({
          title: `Council on Gnosis, variant (${label})`,
          description: `davinci-sdk keyMode 'council', ceremony ${cer.name} (${cer.cid})`,
          census,
          maxVoters: 100,
          electionPreset: preset,
          questions: [{ title: q.title, choices: q.choices.map((title, value) => ({ title, value })) }],
          timing,
          keyMode: 'council',
          ceremonyId: cer.cid,
        } as never);
        const p = await sdk.registry.getProcess(created.processId);
        expect(p.keyMode).toBe(KeyMode.Council);
        expect(p.dkg?.council).toBe(true);
        expect(p.dkg?.epochId.toLowerCase()).toBe(cer.cid);
        const rid = (p.dkg?.aid ?? '').toLowerCase() as Hex;
        expect(rid).toBe(computeRequestId(CHAIN_ID, MANAGER, cer.cid, ADAPTER, created.processId as Hex));
        const key = await reader.getPublicKey(cer.cid, await reader.finalizedAnchor());
        expect({ x: p.encryptionKey.x, y: p.encryptionKey.y }).toEqual({ x: key.x, y: key.y });
        procs[label] = { label, pid: created.processId, rid, cer, creationBlock: Number(p.creationBlock) };
        record.processes[label] = {
          pid: created.processId,
          ceremony: cer.name,
          requestId: rid,
          createTx: created.transactionHash,
          votes: [],
          states: [],
          waitForResultsStates: [],
          events: [],
          expected: [],
        };
        log(`(${label}): process ${created.processId} on ${cer.name}, request ${rid} (tx ${created.transactionHash})`);
        writeRecord();
      };
      const now = await chainNow();
      if (B.openAt === undefined) throw new Error('ceremony B has no opening date');
      const bEnd = B.openAt - B_END_BEFORE_OPEN_S;
      if (bEnd - now < 600n) {
        throw new Error(`ceremony B opens at ${B.openAt}: too soon to vote and settle before ${bEnd} (now ${now})`);
      }
      await make('a', A, A_QUESTION, { type: 'rating', maxValue: 5 }, voters.a.map((w) => w.address), { duration: 3 * 3600 });
      await make('c', A, A_QUESTION, { type: 'rating', maxValue: 5 }, [creator], { duration: 3 * 3600 });
      await make('b', B, B_QUESTION, { type: 'single_choice' }, voters.b.map((w) => w.address), {
        endDate: new Date(Number(bEnd) * 1000),
      });
      record.processes.a!.expected = tally(A_BALLOTS).map(String);
      record.processes.b!.expected = tally(B_BALLOTS).map(String);
      record.processes.c!.expected = ['0', '0', '0'];
    });
  });

  it('the variants: (a) manual opening, (c) zero votes on the same ceremony, (b) scheduled opening', async () => {
    const samplers = (['a', 'b', 'c'] as const).map((l) => sample(sdk, procs[l]));
    const waits = { a: results(sdk, procs.a), b: results(sdk, procs.b), c: results(sdk, procs.c) };
    for (const w of Object.values(waits)) w.catch(() => undefined);

    // (c): no votes, ended at once.
    const c = (async () => {
      await sdk.endProcess(procs.c.pid);
      record.processes.c!.endedAt = new Date().toISOString();
      log('(c): ended with no votes');
      return untilRequestedWhileClosed(procs.c, 30 * 60_000);
    })();

    // (a): three voters, settled, then ended by the organizer.
    const aRequested = timed('(a) vote, settle, end, request', async () => {
      await castVotes(procs.a, voters.a, A_BALLOTS);
      await sdk.endProcess(procs.a.pid);
      record.processes.a!.endedAt = new Date().toISOString();
      log('(a): ended');
      return untilRequestedWhileClosed(procs.a, 30 * 60_000);
    });

    // (b): three voters; the process ends by its date, a few minutes before B opens.
    const b = timed('(b) vote, settle, end by date, request, scheduled opening, decrypt', async () => {
      await castVotes(procs.b, voters.b, B_BALLOTS);
      const hit = await untilRequestedWhileClosed(procs.b, 90 * 60_000);
      expect(BigInt(Math.floor(Date.parse(hit.at) / 1000))).toBeLessThan(B.openAt as bigint);
      log(`(b): requested while closed; B opens at ${new Date(Number(B.openAt) * 1000).toISOString()}`);
      while ((await chainNow()) < (B.openAt as bigint)) await sleep(15_000);
      record.ceremonies.B!.openedAt = new Date(Number(B.openAt) * 1000).toISOString();
      record.processes.b!.decryptors = [2, 3];
      await decrypt('(b)', B, procs.b.rid, [2, 3]);
      return waits.b;
    });

    // A opens once both of its processes wait on it.
    const a = timed('(a)+(c) manual opening, decrypt, results', async () => {
      await Promise.all([aRequested, c]);
      expect(await reader.isDecryptionOpen(A.cid)).toBe(false);
      const opened = await relay('A open', await A.org.openDecryption(A.cid), 'openDecryption (organizer)');
      record.ceremonies.A!.openedAt = new Date().toISOString();
      record.ceremonies.A!.openTx = opened.transactionHash;
      record.processes.a!.decryptors = [1, 3];
      await decrypt('(a)', A, procs.a.rid, [1, 3]);
      return Promise.all([waits.a, waits.c]);
    });

    const [[ra, rc], rb] = await Promise.all([a, b]);
    for (const s of samplers) s.stop();
    await Promise.all(samplers.map((s) => s.done));

    const check = async (label: 'a' | 'b' | 'c', r: ProcessResults, voterCount: number) => {
      const rec = record.processes[label]!;
      rec.values = r.values.map(String);
      const want = rec.expected.map(BigInt);
      expect(want.map((_, i) => r.values[i] ?? 0n), `(${label}) tally`).toEqual(want);
      expect(r.voters, `(${label}) voters`).toBe(voterCount);
      const info = await sdk.getProcess(procs[label].pid);
      expect(info.status).toBe(ProcessStatus.RESULTS);
      expect(rec.waitForResultsStates).toContain('awaiting-opening');
      expect(rec.waitForResultsStates.at(-1)).toBe('results');
      expect(rec.waitForResultsStates.indexOf('awaiting-opening')).toBeLessThan(rec.waitForResultsStates.indexOf('results'));
      await collectEvents(sdk, procs[label]);
    };
    await check('a', ra, A_BALLOTS.length);
    await check('b', rb, B_BALLOTS.length);
    await check('c', rc, 0);
    // (c) never reached the Council side: the binding has no ciphertexts.
    expect((await reader.getRequestMeta(procs.c.rid)).fieldCount).toBe(0);
    // The committee's plaintexts, read back authenticated (pinned to a finalized block, so the
    // last combine may need a few minutes to be visible).
    for (const l of ['a', 'b'] as const) {
      const deadline = Date.now() + 15 * 60_000;
      let pt = await retrying('getPlaintexts', () => reader.getPlaintexts(procs[l].rid));
      while (!pt.ready && Date.now() < deadline) {
        await sleep(FINALITY_POLL_MS);
        pt = await retrying('getPlaintexts', () => reader.getPlaintexts(procs[l].rid));
      }
      expect(pt.ready, `(${l}) plaintexts`).toBe(true);
      expect(pt.values, `(${l}) plaintexts`).toEqual(record.processes[l]!.expected.map(BigInt));
    }
    record.result = 'success';
    writeRecord();
  });
});
