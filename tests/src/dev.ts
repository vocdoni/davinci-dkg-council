/**
 * The local Council stack (`make dev`, `scripts/dev-stack.sh`) and its DAVINCI helper.
 *
 *   up        (default) Anvil, the real verifiers and CouncilManager bound to the dev circuit
 *             release, the circuit files over HTTP, a davinci-contracts ProcessRegistry on
 *             MockZiskVerifier, the relayer with its combine worker, the app (vite). Prints the
 *             URLs and stops everything on Ctrl-C.
 *   settle    --process <pid> --tally 7,0,3[,…] [--json]: end a DAVINCI process, settle that
 *             final tally (encrypted under the ceremony key) as its only state leaf, skip the
 *             grace window and request the results decryption — what the sequencer does at the
 *             end of a real vote, as in the e2e DAVINCI round-trip.
 *
 * State goes to .dev (stack.json, davinci-test.json, logs/); the app reads
 * ui/public/config.json, which `up` rewrites. Fixed ports, overridable:
 * COUNCIL_DEV_ANVIL_PORT (8545), COUNCIL_DEV_RELAYER_PORT (8788), COUNCIL_DEV_ARTIFACTS_PORT
 * (8789), COUNCIL_DEV_APP_PORT (5175). COUNCIL_DEV_DAVINCI=off skips the registry (no sibling
 * davinci-contracts / davinci-sdk checkouts needed).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { COUNCIL_ARTIFACTS, COUNCIL_MANAGER_ABI, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { createPublicClient, createTestClient, http, zeroHash, type Abi, type PublicClient } from 'viem';
import { foundry } from 'viem/chains';
import { ACCOUNT, anvilAccount, anvilKey, walletFor } from './accounts.js';
import {
  accumulator,
  buildDavinciContracts,
  buildDavinciTest,
  DAVINCI_CONTRACTS_DIR,
  DAVINCI_TEST_DIR,
  davinciArtifact,
  deployDavinciRegistry,
  latestStateRootSlot,
  resultsOnlyRoot,
  runCli,
} from './davinci.js';
import { deployCouncil, devCircuitRelease } from './deploy.js';
import { ARTIFACTS_DIR, buildPackages, forgeBuild, REPO_ROOT, startAnvil, startRelayer } from './infra.js';

const DEV_DIR = path.join(REPO_ROOT, '.dev');
const LOGS = path.join(DEV_DIR, 'logs');
const STACK_FILE = path.join(DEV_DIR, 'stack.json');
const CLI_CONFIG = path.join(DEV_DIR, 'davinci-test.json');
const APP_DIR = path.join(REPO_ROOT, 'ui');
const APP_CONFIG = path.join(APP_DIR, 'public', 'config.json');
const HOST = '127.0.0.1';

const port = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const v = raw ? Number(raw) : fallback;
  if (!Number.isInteger(v) || v <= 0 || v > 65535) throw new Error(`${name} must be a TCP port`);
  return v;
};

export interface DevStack {
  chainId: number;
  rpcUrl: string;
  appUrl: string;
  relayerUrl: string;
  artifactsUrl: string;
  manager: Hex;
  dealVerifier: Hex;
  partialVerifier: Hex;
  circuitReleaseId: Hex;
  relayer: Hex;
  davinci: null | {
    registry: Hex;
    adapter: Hex;
    /** The account davinci-test creates processes with (authorize it as the election organizer). */
    creator: Hex;
    /** davinci-test --config file for this stack. */
    cliConfig: string;
  };
}

export function readStack(): DevStack {
  if (!existsSync(STACK_FILE)) throw new Error(`no ${STACK_FILE}: start the stack with \`make dev\` first`);
  return JSON.parse(readFileSync(STACK_FILE, 'utf8')) as DevStack;
}

function freshDir(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function portFree(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once('error', () => resolve(false));
    srv.listen(p, HOST, () => srv.close(() => resolve(true)));
  });
}

/** The six pinned circuit files over HTTP, nothing else; the app verifies every byte against the SDK pins. */
function serveArtifacts(p: number): Promise<Server> {
  const files = new Map<string, string>();
  for (const circuit of ['deal', 'partial'] as const) {
    for (const kind of ['wasm', 'zkey', 'vkey'] as const) {
      const { url } = COUNCIL_ARTIFACTS[circuit][kind];
      const name = url.slice(url.lastIndexOf('/') + 1);
      files.set(`/${name}`, path.join(ARTIFACTS_DIR, name));
    }
  }
  const server = createHttpServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, HEAD' });
      res.end();
      return;
    }
    const file = files.get(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, cors);
      res.end();
      return;
    }
    res.writeHead(200, {
      ...cors,
      'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'content-length': String(statSync(file).size),
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, HOST, () => resolve(server));
  });
}

async function waitHttp(url: string, child: ChildProcess, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${what} exited with ${child.exitCode}; see ${LOGS}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${what} did not come up at ${url}; see ${LOGS}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function startApp(appPort: number): ChildProcess {
  const log = createWriteStream(path.join(LOGS, 'app.log'));
  const child = spawn(path.join(APP_DIR, 'node_modules', '.bin', 'vite'), ['--host', HOST, '--port', String(appPort), '--strictPort'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return child;
}

async function up(): Promise<void> {
  const ports = {
    anvil: port('COUNCIL_DEV_ANVIL_PORT', 8545),
    relayer: port('COUNCIL_DEV_RELAYER_PORT', 8788),
    artifacts: port('COUNCIL_DEV_ARTIFACTS_PORT', 8789),
    app: port('COUNCIL_DEV_APP_PORT', 5175),
  };
  for (const [name, p] of Object.entries(ports)) {
    if (!(await portFree(p))) throw new Error(`port ${p} (${name}) is in use: stop whatever holds it, or set COUNCIL_DEV_${name.toUpperCase()}_PORT`);
  }
  const withDavinci = (process.env.COUNCIL_DEV_DAVINCI ?? '').toLowerCase() !== 'off';
  mkdirSync(LOGS, { recursive: true });

  const step = (msg: string) => console.log(`• ${msg}`);
  step(`checking the dev circuit artifacts in ${ARTIFACTS_DIR} against the SDK pins`);
  const release = devCircuitRelease();
  step('building the SDK, the relayer and the contracts');
  buildPackages();
  forgeBuild();
  if (withDavinci) {
    step(`building davinci-contracts (${DAVINCI_CONTRACTS_DIR}) and davinci-test`);
    try {
      buildDavinciContracts();
      buildDavinciTest();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg}\n(the DAVINCI part needs davinci-contracts and a built davinci-sdk; COUNCIL_DEV_DAVINCI=off skips it)`);
    }
  }

  const stops: (() => Promise<void> | void)[] = [];
  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    console.log('\nstopping the dev stack…');
    for (const stop of stops.reverse()) {
      try {
        await stop();
      } catch {
        // best effort
      }
    }
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));

  try {
    step(`starting Anvil on ${HOST}:${ports.anvil}`);
    const anvil = await startAnvil({ port: ports.anvil, logDir: LOGS });
    stops.push(() => anvil.stop());
    void anvil.exited.then(() => {
      if (!stopping) {
        console.error(`Anvil exited; see ${LOGS}/anvil.log`);
        void shutdown(1);
      }
    });
    const client = createPublicClient({ chain: foundry, transport: http(anvil.rpcUrl) }) as PublicClient;
    const chainId = await client.getChainId();
    const deployer = walletFor(anvil.rpcUrl, ACCOUNT.deployer);

    step('deploying DealVerifier, PartialVerifier and CouncilManager (dev circuit release)');
    const council = await deployCouncil(deployer, client, release.releaseId);

    let davinci: DevStack['davinci'] = null;
    if (withDavinci) {
      step('deploying the DAVINCI ProcessRegistry (COUNCIL key mode, MockZiskVerifier)');
      const d = await deployDavinciRegistry(deployer, client, chainId, council.manager);
      const creator = anvilAccount(ACCOUNT.creator).address.toLowerCase() as Hex;
      writeFileSync(
        CLI_CONFIG,
        `${JSON.stringify(
          { rpcUrl: anvil.rpcUrl, registry: d.registry, manager: council.manager, organizerKey: anvilKey(ACCOUNT.creator), verify: 'off' },
          null,
          2,
        )}\n`,
      );
      davinci = { registry: d.registry, adapter: d.adapter, creator, cliConfig: CLI_CONFIG };
    }

    step(`serving the circuit files on ${HOST}:${ports.artifacts}`);
    const artifacts = await serveArtifacts(ports.artifacts);
    stops.push(() => new Promise<void>((resolve) => artifacts.close(() => resolve())));
    const artifactsUrl = `http://${HOST}:${ports.artifacts}`;

    const appOrigins = [`http://${HOST}:${ports.app}`, `http://localhost:${ports.app}`];
    step(`starting the relayer on ${HOST}:${ports.relayer} (Anvil account ${ACCOUNT.relayer}, combine worker and scheduler on)`);
    const relayer = await startRelayer(
      {
        COUNCIL_RPC_URL: anvil.rpcUrl,
        COUNCIL_MANAGER_ADDRESS: council.manager,
        COUNCIL_PRIVATE_KEY: anvilKey(ACCOUNT.relayer),
        // A fresh chain every run: the previous run's journal must not be rebroadcast.
        COUNCIL_DATA_DIR: freshDir(path.join(DEV_DIR, 'relayer')),
        COUNCIL_COMBINER_ENABLED: 'true',
        COUNCIL_COMBINER_POLL_MS: '1000',
        // v2 scheduled transitions (close, finalize, abort) fire by themselves.
        COUNCIL_SCHEDULER_ENABLED: 'true',
        COUNCIL_SCHEDULER_POLL_MS: '1000',
        COUNCIL_TX_POLL_MS: '500',
        // Open admission (no allow-list, no tokens), generous local limits.
        COUNCIL_DAILY_BUDGET_WEI: (100n * 10n ** 18n).toString(),
        COUNCIL_ORGANIZER_DAILY_CEREMONIES: '0',
        COUNCIL_RATE_LIMIT: '1000',
        COUNCIL_CEREMONY_RATE_LIMIT: '1000',
        COUNCIL_INGRESS_RATE_LIMIT: '100000',
        COUNCIL_CORS_ORIGINS: appOrigins.join(','),
      },
      { port: ports.relayer, logDir: LOGS },
    );
    stops.push(() => relayer.stop());
    relayer.child.once('exit', () => {
      if (!stopping) {
        console.error(`the relayer exited; see ${LOGS}/relayer.log`);
        void shutdown(1);
      }
    });

    // The app's runtime config: one local RPC, so devMode (permitted on 31337 only). With the
    // default ports this is byte-for-byte the committed ui/public/config.json.
    const appConfig = {
      chainId,
      devMode: true,
      manager: council.manager,
      rpcUrls: [anvil.rpcUrl],
      relayerUrl: relayer.url,
      artifactsBaseUrl: artifactsUrl,
      deploymentBlock: 0,
    };
    writeFileSync(APP_CONFIG, `${JSON.stringify(appConfig, null, 2).replace(/\[\n\s+("[^"]*")\n\s+\]/g, '[$1]')}\n`);

    const appUrl = appOrigins[0] as string;
    step(`starting the app on ${appUrl}`);
    const app = startApp(ports.app);
    stops.push(
      () =>
        new Promise<void>((resolve) => {
          if (app.exitCode !== null) return resolve();
          app.once('exit', () => resolve());
          app.kill('SIGTERM');
        }),
    );
    await waitHttp(appUrl, app, 'the app');
    app.once('exit', () => {
      if (!stopping) {
        console.error(`the app exited; see ${LOGS}/app.log`);
        void shutdown(1);
      }
    });

    const stack: DevStack = {
      chainId,
      rpcUrl: anvil.rpcUrl,
      appUrl,
      relayerUrl: relayer.url,
      artifactsUrl,
      manager: council.manager,
      dealVerifier: council.dealVerifier,
      partialVerifier: council.partialVerifier,
      circuitReleaseId: release.releaseId,
      relayer: anvilAccount(ACCOUNT.relayer).address.toLowerCase() as Hex,
      davinci,
    };
    writeFileSync(STACK_FILE, `${JSON.stringify(stack, null, 2)}\n`);
    stops.push(() => rmSync(STACK_FILE, { force: true }));

    const rel = (p: string) => path.relative(REPO_ROOT, p);
    const lines = [
      '',
      'Council dev stack is up',
      '',
      `  App        ${appUrl}`,
      `  Anvil      ${anvil.rpcUrl}  (chain ${chainId})`,
      `  Relayer    ${relayer.url}  (pays from ${stack.relayer}, combine worker on)`,
      `  Circuits   ${artifactsUrl}  (${ARTIFACTS_DIR})`,
      `  Manager    ${council.manager}`,
    ];
    if (davinci) {
      lines.push(
        `  DAVINCI    registry ${davinci.registry}`,
        '',
        'On the committee page, once the key is ready, approve:',
        `  Voting system connection  ${davinci.adapter}`,
        `  Election organizer        ${davinci.creator}`,
        '',
        'Then, from the repository root:',
        `  make dev-process CEREMONY=0x…            create a DAVINCI process on the committee key`,
        `  make dev-settle PROCESS=0x… TALLY=7,0,3  end it, settle that tally, request the decryption`,
        `  make dev-results PROCESS=0x…             read (and store) the decrypted results`,
      );
    }
    lines.push('', `Logs in ${rel(LOGS)}/. Ctrl-C stops everything.`, '');
    console.log(lines.join('\n'));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    await shutdown(1);
  }
  await new Promise(() => undefined); // until a signal
}

const STATUS = { READY: 0, ENDED: 1 } as const;
const KEY_MODE_COUNCIL = 3;
const MAX_FIELD_VALUE = 10n ** 12n; // the registry's maxValue * maxVoters cap, within the combiner's BSGS bound

interface RegistryProcess {
  status: number;
  keyMode: number;
  dkgEpochId: Hex;
  dkgAid: Hex;
  dkgResultsRequested: boolean;
}

async function settle(processId: string, tallyArg: string, json: boolean): Promise<void> {
  const stack = readStack();
  if (!stack.davinci) throw new Error('this dev stack runs without DAVINCI (COUNCIL_DEV_DAVINCI=off)');
  if (!/^0x[0-9a-fA-F]{62}$/.test(processId)) throw new Error('--process must be a bytes31 process id');
  const pid = processId.toLowerCase() as Hex;
  const tally = tallyArg.split(',').map((v) => {
    if (!/^\d+$/.test(v.trim())) throw new Error(`--tally: ${v} is not a non-negative integer`);
    const n = BigInt(v.trim());
    if (n > MAX_FIELD_VALUE) throw new Error(`--tally: ${v} is above 1e12`);
    return n;
  });
  if (tally.length < 1 || tally.length > 16) throw new Error('--tally takes 1 to 16 values');

  const { registry } = stack.davinci;
  const client = createPublicClient({ chain: foundry, transport: http(stack.rpcUrl), cacheTime: 0 }) as PublicClient;
  const test = createTestClient({ chain: foundry, mode: 'anvil', transport: http(stack.rpcUrl) });
  const artifact = davinciArtifact('ProcessRegistry.sol', 'ProcessRegistry');
  const abi = artifact.abi as Abi;
  const read = <T>(functionName: string, args: readonly unknown[]) =>
    client.readContract({ address: registry, abi, functionName, args } as never) as Promise<T>;

  let p = await read<RegistryProcess>('getProcess', [pid]);
  if (p.keyMode !== KEY_MODE_COUNCIL) throw new Error(`process ${pid} is not keyed by a Council ceremony`);
  if (p.dkgResultsRequested) throw new Error(`process ${pid} already requested its results decryption`);
  if (p.status === STATUS.READY) {
    const ended = await runCli(['end', '--config', stack.davinci.cliConfig, '--process', pid], {});
    if (ended.code !== 0) throw new Error(`davinci-test end failed: ${JSON.stringify(ended.out)} ${ended.stderr}`);
    p = await read<RegistryProcess>('getProcess', [pid]);
  }
  if (p.status !== STATUS.ENDED) throw new Error(`process ${pid} is in status ${p.status}, not ENDED`);

  const cid = p.dkgEpochId;
  const [x, y] = (await client.readContract({
    address: stack.manager,
    abi: COUNCIL_MANAGER_ABI,
    functionName: 'getPublicKey',
    args: [cid],
  })) as readonly [bigint, bigint];
  const acc = accumulator(
    tally.map((value) => ({ value })),
    { x, y },
  );
  await test.setStorageAt({ address: registry, index: latestStateRootSlot(artifact, pid), value: resultsOnlyRoot(acc) });

  const graceEnd = await read<bigint>('getProcessGraceEnd', [pid]);
  const now = (await client.getBlock({ blockTag: 'latest' })).timestamp;
  if (graceEnd >= now) {
    await test.increaseTime({ seconds: Number(graceEnd - now + 1n) });
    await test.mine({ blocks: 1 });
  }

  const requester = walletFor(stack.rpcUrl, ACCOUNT.direct);
  const { request } = await client.simulateContract({
    address: registry,
    abi,
    functionName: 'requestResultsDecryption',
    args: [pid, acc, [zeroHash]],
    account: requester.account ?? null,
  } as never);
  const hash = await requester.writeContract(request as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('requestResultsDecryption reverted');

  const out = { processId: pid, ceremonyId: cid, requestId: p.dkgAid, tally: tally.map(String), transactionHash: hash };
  if (json) console.log(JSON.stringify(out));
  else {
    console.log(
      [
        `process      ${pid}`,
        `ceremony     ${cid}`,
        `request id   ${p.dkgAid}`,
        `tally        ${tally.join(', ')} (encrypted under the committee key, decryption requested)`,
        '',
        'Members now see an unlock request on the committee page; once enough of them unlocked it,',
        `the relayer combines and \`make dev-results PROCESS=${pid}\` stores the tally.`,
      ].join('\n'),
    );
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { process: { type: 'string' }, tally: { type: 'string' }, json: { type: 'boolean' } },
  });
  const command = positionals[0] ?? 'up';
  if (command === 'up') return up();
  if (command === 'settle') {
    if (!values.process || !values.tally) throw new Error('usage: settle --process <pid> --tally 7,0,3[,…] [--json]');
    return settle(values.process, values.tally, values.json === true);
  }
  throw new Error(`unknown command ${command} (up | settle); davinci-test lives in ${DAVINCI_TEST_DIR}`);
}

main().catch((err: unknown) => {
  console.error(`dev: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
