// Multi-party Groth16 phase 2 for the Council circuits (audit H-01): the production replacement
// for build.sh's single-party DEV setup. Phase 1 is the Hermez/PPoT powersOfTau28_hez_final_18
// (blake2b-pinned); phase 2 is a chain of independent contributions, each verified against the
// r1cs and the ptau before the next one starts, closed by a public random beacon announced
// before it exists (a drand quicknet round, BLS-verified here, or a finalized block hash). The
// toxic waste is safe if ONE contributor destroyed theirs.
//
// Coordinator:   init → (send head, accept)×N → announce-beacon → beacon → export → install
// Contributor:   contribute (see CONTRIBUTOR.md)
// Anyone:        verify (re-checks a published ceremony directory from scratch)
//
//   make ceremony ARGS="<command> [options]"      (from the repository root; README.md)
//
// Every step appends to <dir>/transcript.log and updates <dir>/ceremony.json, the state the next
// step checks; attestations and the full snarkjs verification output of every step are kept.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { sha256 as sha256Bytes } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as snarkjs from "snarkjs";
import { releaseManifest } from "../release-manifest.ts";

const CIRCUITS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_DIR = resolve(CIRCUITS_DIR, "..");
const SNARKJS_BIN = join(CIRCUITS_DIR, "node_modules", ".bin", "snarkjs");
const CIRCUITS = ["deal", "partial"] as const;
type CircuitName = (typeof CIRCUITS)[number];
const VERIFIER: Record<CircuitName, string> = { deal: "DealVerifier", partial: "PartialVerifier" };

const FORMAT = "davinci-dkg-council-ceremony/v1";
const ATTESTATION_FORMAT = "davinci-dkg-council-ceremony-attestation/v1";

/** The Hermez/PPoT phase-1 file for 2^18 constraints, as build.sh and scripts/ci-fetch-ptau.sh pin it. */
const PTAU = {
  name: "powersOfTau28_hez_final_18.ptau",
  url: "https://circom.info/powersOfTau28_hez_final_18.ptau",
  blake2b:
    "7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e",
};
const DEFAULT_PTAU = join(homedir(), ".davinci-dkg-council", "ptau", PTAU.name);

/** drand quicknet (League of Entropy): unchained BLS12-381, G1 signatures over sha256(round). */
const QUICKNET = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesis: 1692803367,
  period: 3,
  dst: "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_",
  relays: ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"],
};
/** snarkjs zkey beacon: 2^10 iterations of the beacon hash (snarkjs' minimum, the common choice). */
const BEACON_ITERATIONS_EXP = 10;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._@()-]{0,63}$/;

// ─── State ────────────────────────────────────────────────────────────────────────────────

interface ZkeyRecord {
  file: string;
  sha256: string;
  /** snarkjs' 64-byte contribution hash (hex), absent for the initial zkey. */
  contributionHash?: string;
}

interface Contribution {
  index: number;
  name: string;
  acceptedAt: string;
  attestation: { file: string; sha256: string };
  zkeys: Record<CircuitName, ZkeyRecord>;
}

type Announcement =
  | { source: "drand"; chain: "quicknet"; chainHash: string; round: number; roundTime: string; announcedAt: string }
  | { source: "block"; chainId: number; number: number; rpcs: string[]; announcedAt: string };

interface BeaconValue {
  value: string;
  time: string;
  evidence: Record<string, unknown>;
}

interface State {
  format: string;
  tag: string;
  createdAt: string;
  toolchain: { circom: string; snarkjs: string };
  ptau: { file: string; sha256: string; blake2b: string; source: string };
  circuits: Record<CircuitName, { r1cs: string; wasm: string; circuitHash: string; sameCircuitsAs: string | null }>;
  initial: Record<CircuitName, ZkeyRecord>;
  contributions: Contribution[];
  beacon: null | { announcement: Announcement; fetched?: BeaconValue };
  final: null | { finishedAt: string; zkeys: Record<CircuitName, ZkeyRecord> };
  release: null | { circuitReleaseId: string; files: Record<string, string> };
}

const now = () => new Date().toISOString();
function die(msg: string): never {
  throw new Error(msg);
}

function loadState(dir: string): State {
  const p = join(dir, "ceremony.json");
  if (!existsSync(p)) die(`${p} not found: run init first`);
  const s = JSON.parse(readFileSync(p, "utf8")) as State;
  if (s.format !== FORMAT) die(`${p}: unknown format ${s.format}`);
  return s;
}

function saveState(dir: string, s: State) {
  writeFileSync(join(dir, "ceremony.json"), JSON.stringify(s, null, 2) + "\n");
}

function log(dir: string, line: string) {
  const entry = `[${now()}] ${line}`;
  appendFileSync(join(dir, "transcript.log"), entry + "\n");
  console.log(line);
}

const sha256File = (path: string) => "0x" + createHash("sha256").update(readFileSync(path)).digest("hex");

function blake2bFile(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash("blake2b512");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("end", () => ok(h.digest("hex")))
      .on("error", fail);
  });
}

const zkeyPath = (dir: string, c: CircuitName, index: number) =>
  join(dir, `${c}_${String(index).padStart(4, "0")}.zkey`);

// ─── snarkjs, with its log captured ───────────────────────────────────────────────────────

/** A snarkjs logger that keeps every message (verify reports contributions only there). */
function capture() {
  const lines: string[] = [];
  const rec =
    (level: string) =>
    (...m: unknown[]) =>
      lines.push(`${level}: ${m.join(" ")}`);
  return { lines, logger: { debug: () => {}, info: rec("INFO"), warn: rec("WARN"), error: rec("ERROR") } };
}

interface ParsedContribution {
  index: number;
  name: string;
  hash: string;
  beacon?: { generator: string; iterationsExp: number };
}

/** The circuit hash and the contribution list of a `zkey verify` log. */
function parseVerifyLog(lines: string[]) {
  let circuitHash = "";
  const contributions: ParsedContribution[] = [];
  const hexOf = (rest: string[]) => rest.join("").replace(/\s+/g, "");
  for (const line of lines) {
    const msg = line.replace(/^INFO: /, "");
    const parts = msg.split("\n");
    if (parts[0]?.startsWith("Circuit Hash:")) circuitHash = hexOf(parts.slice(1));
    const m = /^contribution #(\d+) (.*):$/.exec(parts[0] ?? "");
    if (m) contributions.push({ index: Number(m[1]), name: m[2] as string, hash: hexOf(parts.slice(1)) });
    const g = /^Beacon generator: ([0-9a-f]+)$/.exec(msg);
    if (g && contributions.length) {
      const last = contributions[contributions.length - 1] as ParsedContribution;
      last.beacon = { generator: g[1] as string, iterationsExp: -1 };
    }
    const it = /^Beacon iterations Exp: (\d+)$/.exec(msg);
    if (it && contributions[contributions.length - 1]?.beacon) {
      (contributions[contributions.length - 1] as ParsedContribution).beacon!.iterationsExp = Number(it[1]);
    }
  }
  contributions.sort((a, b) => a.index - b.index);
  return { circuitHash, contributions };
}

/** `zkey verify` from the r1cs and the ptau (the whole chain); the log goes to `logFile`. */
async function verifyZkey(r1cs: string, ptau: string, zkey: string, logFile: string) {
  const { lines, logger } = capture();
  const ok = await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, zkey, logger as never);
  mkdirSync(dirname(logFile), { recursive: true });
  writeFileSync(logFile, lines.join("\n") + "\n");
  if (ok !== true) die(`zkey verify FAILED for ${zkey} (log: ${logFile}):\n${lines.filter((l) => l.startsWith("ERROR")).join("\n")}`);
  return parseVerifyLog(lines);
}

const hashHex = (h: unknown) => bytesToHex(h as Uint8Array);

async function shutdown() {
  const g = globalThis as { curve_bn128?: { terminate(): Promise<void> } };
  if (g.curve_bn128) await g.curve_bn128.terminate();
}

// ─── Beacon sources ───────────────────────────────────────────────────────────────────────

const roundTime = (round: number) => QUICKNET.genesis + (round - 1) * QUICKNET.period;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function drand(path: string): Promise<{ round: number; signature: string; randomness: string; relay: string }> {
  const errors: string[] = [];
  for (const relay of QUICKNET.relays) {
    try {
      const j = (await fetchJson(`${relay}/${QUICKNET.chainHash}/public/${path}`)) as Record<string, unknown>;
      return { round: Number(j.round), signature: String(j.signature), randomness: String(j.randomness), relay };
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return die(`no drand relay answered: ${errors.join("; ")}`);
}

/** The relay's answer is only transport: the signature is checked against the pinned group key. */
function verifyDrand(round: number, signatureHex: string): string {
  const sig = hexToBytes(signatureHex);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(round));
  const ss = bls12_381.shortSignatures;
  const point = ss.hash(sha256Bytes(msg), QUICKNET.dst);
  if (!ss.verify(sig, point, hexToBytes(QUICKNET.publicKey))) die(`drand round ${round}: invalid BLS signature`);
  return bytesToHex(sha256Bytes(sig));
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const j = (await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })) as { result?: unknown; error?: unknown };
  if (j.error || j.result === undefined) throw new Error(`${url} ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function fetchBeacon(a: Announcement): Promise<BeaconValue> {
  if (a.source === "drand") {
    const r = await drand(String(a.round));
    if (r.round !== a.round) die(`drand relay ${r.relay} answered round ${r.round}, not ${a.round}`);
    const value = verifyDrand(a.round, r.signature);
    if (value !== r.randomness) die(`drand round ${a.round}: randomness is not sha256(signature)`);
    return {
      value,
      time: new Date(roundTime(a.round) * 1000).toISOString(),
      evidence: { chainHash: QUICKNET.chainHash, round: a.round, signature: r.signature, relay: r.relay },
    };
  }
  const blocks: { hash: string; timestamp: number; rpc: string }[] = [];
  for (const url of a.rpcs) {
    if (Number(await rpc(url, "eth_chainId", [])) !== a.chainId) die(`${url} is not chain ${a.chainId}`);
    const fin = (await rpc(url, "eth_getBlockByNumber", ["finalized", false])) as { number: string } | null;
    if (!fin || Number(fin.number) < a.number) die(`block ${a.number} is not finalized yet on ${url}`);
    const b = (await rpc(url, "eth_getBlockByNumber", ["0x" + a.number.toString(16), false])) as {
      hash: string;
      timestamp: string;
    };
    blocks.push({ hash: b.hash.toLowerCase(), timestamp: Number(b.timestamp), rpc: url });
  }
  if (new Set(blocks.map((b) => b.hash)).size !== 1) die(`the RPCs disagree on block ${a.number}: ${JSON.stringify(blocks)}`);
  const b = blocks[0]!;
  return {
    value: b.hash.replace(/^0x/, ""),
    time: new Date(b.timestamp * 1000).toISOString(),
    evidence: { chainId: a.chainId, number: a.number, hash: b.hash, rpcs: a.rpcs },
  };
}

// ─── Commands ─────────────────────────────────────────────────────────────────────────────

const CIRCOM = process.env.CIRCOM || join(homedir(), ".local", "bin", "circom");

async function cmdInit(o: { dir: string; tag: string; ptau: string }) {
  const dir = resolve(o.dir);
  if (existsSync(join(dir, "ceremony.json"))) die(`${dir} already holds a ceremony`);
  if (!/^circuits-v\d+[a-z0-9.-]*$/.test(o.tag)) die(`tag ${o.tag}: expected circuits-vN`);
  mkdirSync(join(dir, "build"), { recursive: true });
  mkdirSync(join(dir, "zkeys"), { recursive: true });
  log(dir, `init ${o.tag} in ${dir}`);

  if (!existsSync(o.ptau)) die(`no ptau at ${o.ptau}: fetch it with scripts/ci-fetch-ptau.sh ${o.ptau}`);
  const b2 = await blake2bFile(o.ptau);
  if (b2 !== PTAU.blake2b) die(`${o.ptau} is not the Hermez ${PTAU.name} (blake2b ${b2})`);
  const ptauSha = sha256File(o.ptau);
  log(dir, `phase 1: ${o.ptau} blake2b ${b2.slice(0, 16)}… = Hermez ${PTAU.name}, sha256 ${ptauSha}`);

  const circomVersion = execFileSync(CIRCOM, ["--version"], { encoding: "utf8" }).trim();
  if (!circomVersion.includes("2.2.3")) die(`circom 2.2.3 required, ${CIRCOM} is ${circomVersion}`);
  const pinned = JSON.parse(readFileSync(join(CIRCUITS_DIR, "release", "release.json"), "utf8"));
  const circuits = {} as State["circuits"];
  const initial = {} as State["initial"];
  for (const c of CIRCUITS) {
    // exactly build.sh's compilation (deterministic: the r1cs/wasm bytes are the circuit's identity)
    execFileSync(CIRCOM, [`${c}.circom`, "--r1cs", "--wasm", "--sym", "--O2", "-l", "node_modules", "-o", join(dir, "build")], {
      cwd: CIRCUITS_DIR,
      stdio: "ignore",
    });
    const r1cs = sha256File(join(dir, "build", `${c}.r1cs`));
    const wasm = sha256File(join(dir, "build", `${c}_js`, `${c}.wasm`));
    const same = pinned[c].r1cs.sha256 === r1cs && pinned[c].wasm.sha256 === wasm;
    log(dir, `${c}: r1cs ${r1cs}, wasm ${wasm} (${same ? `the circuits of ${pinned.tag}` : `NEW circuits, not ${pinned.tag}`})`);

    const z = zkeyPath(join(dir, "zkeys"), c, 0);
    const csHash = await snarkjs.zKey.newZKey(join(dir, "build", `${c}.r1cs`), o.ptau, z, undefined as never);
    if (!csHash) die(`zkey new failed for ${c}`);
    const v = await verifyZkey(join(dir, "build", `${c}.r1cs`), o.ptau, z, join(dir, "verify", `0000_${c}.log`));
    if (v.contributions.length !== 0) die(`${z}: an initial zkey carries contributions`);
    circuits[c] = { r1cs, wasm, circuitHash: v.circuitHash, sameCircuitsAs: same ? pinned.tag : null };
    initial[c] = { file: `zkeys/${basename(z)}`, sha256: sha256File(z) };
    log(dir, `${c}: initial zkey ${initial[c].sha256} verified (circuit hash ${v.circuitHash.slice(0, 16)}…)`);
  }
  saveState(dir, {
    format: FORMAT,
    tag: o.tag,
    createdAt: now(),
    toolchain: { circom: "2.2.3", snarkjs: "0.7.6" },
    ptau: { file: basename(o.ptau), sha256: ptauSha, blake2b: b2, source: `Hermez/PPoT ${PTAU.name} (${PTAU.url})` },
    circuits,
    initial,
    contributions: [],
    beacon: null,
    final: null,
    release: null,
  });
  log(dir, `ready: send zkeys/deal_0000.zkey, zkeys/partial_0000.zkey and ceremony.json to contributor #1`);
}

const head = (s: State): { index: number; zkeys: Record<CircuitName, ZkeyRecord> } => {
  const last = s.contributions[s.contributions.length - 1];
  return last ? { index: last.index, zkeys: last.zkeys } : { index: 0, zkeys: s.initial };
};

async function readEntropy(): Promise<string> {
  // snarkjs mixes 64 more bytes of its own CSPRNG output into this; typed text only adds to it.
  let extra = "";
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    extra = await rl.question("Type some random text (adds entropy, never stored), then Enter: ");
    rl.close();
  }
  return randomBytes(64).toString("hex") + extra;
}

async function cmdContribute(o: { in: string; out: string; name: string; tag?: string }) {
  if (!NAME_RE.test(o.name)) die(`--name: 1..64 of letters, digits, space . _ @ ( ) -`);
  const inDir = resolve(o.in);
  const outDir = resolve(o.out);
  // the highest NNNN for which both zkeys are present
  const indexes = CIRCUITS.map(
    (c) =>
      new Set(
        readdirSync(inDir)
          .map((f) => new RegExp(`^${c}_(\\d{4})\\.zkey$`).exec(f)?.[1])
          .filter((x): x is string => !!x)
          .map(Number),
      ),
  );
  const both = [...indexes[0]!].filter((i) => indexes[1]!.has(i));
  if (!both.length) die(`${inDir}: no deal_NNNN.zkey + partial_NNNN.zkey pair`);
  const prev = Math.max(...both);
  const index = prev + 1;
  const tag = o.tag ?? (existsSync(join(inDir, "ceremony.json")) ? loadState(inDir).tag : die("--tag (or ceremony.json in --in)"));
  mkdirSync(outDir, { recursive: true });

  const entropy = await readEntropy();
  const inputs = {} as Record<CircuitName, ZkeyRecord>;
  const outputs = {} as Record<CircuitName, ZkeyRecord>;
  for (const c of CIRCUITS) {
    const from = zkeyPath(inDir, c, prev);
    const to = zkeyPath(outDir, c, index);
    inputs[c] = { file: basename(from), sha256: sha256File(from) };
    console.log(`contributing to ${basename(from)} → ${basename(to)} …`);
    const h = await snarkjs.zKey.contribute(from, to, o.name, entropy, undefined as never);
    if (!h) die(`zkey contribute failed for ${c}`);
    outputs[c] = { file: basename(to), sha256: sha256File(to), contributionHash: hashHex(h) };
  }
  const attestation = {
    format: ATTESTATION_FORMAT,
    tag,
    index,
    name: o.name,
    timestamp: now(),
    software: { snarkjs: "0.7.6", node: process.version, platform: `${platform()} ${arch()}` },
    inputs,
    outputs,
    statement:
      `I, ${o.name}, made contribution #${index} to the ${tag} phase 2 of DAVINCI DKG Council on a machine ` +
      "under my control, with fresh randomness, and kept no copy of that randomness or any intermediate secret.",
  };
  const file = join(outDir, `attestation_${String(index).padStart(4, "0")}.json`);
  writeFileSync(file, JSON.stringify(attestation, null, 2) + "\n");
  console.log(`\ncontribution #${index} by ${o.name}:`);
  for (const c of CIRCUITS) console.log(`  ${c}: contribution hash ${outputs[c].contributionHash}`);
  console.log(`\nSend back: ${CIRCUITS.map((c) => outputs[c].file).join(", ")}, ${basename(file)} (+ its signature).`);
  console.log(`Publish the contribution hashes above yourself, e.g.:`);
  console.log(`  ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n davinci-dkg-council-ceremony ${file}`);
}

async function cmdAccept(o: { dir: string; from: string }) {
  const dir = resolve(o.dir);
  const s = loadState(dir);
  if (s.beacon?.fetched || s.final) die("the beacon is applied: the ceremony is closed");
  const h = head(s);
  const index = h.index + 1;
  const from = resolve(o.from);
  const attFile = join(from, `attestation_${String(index).padStart(4, "0")}.json`);
  if (!existsSync(attFile)) die(`${attFile} not found (expected contribution #${index})`);
  const att = JSON.parse(readFileSync(attFile, "utf8"));
  if (att.format !== ATTESTATION_FORMAT || att.tag !== s.tag || att.index !== index)
    die(`${attFile}: not contribution #${index} of ${s.tag}`);
  if (!NAME_RE.test(att.name)) die(`${attFile}: bad name`);
  if (s.contributions.some((c) => c.name === att.name)) die(`${att.name} already contributed`);

  const zkeys = {} as Record<CircuitName, ZkeyRecord>;
  for (const c of CIRCUITS) {
    if (att.inputs?.[c]?.sha256 !== h.zkeys[c].sha256)
      die(`${c}: the contribution was made on ${att.inputs?.[c]?.sha256}, the head is ${h.zkeys[c].sha256}`);
    const src = zkeyPath(from, c, index);
    const dst = zkeyPath(join(dir, "zkeys"), c, index);
    copyFileSync(src, dst);
    const sha = sha256File(dst);
    if (sha !== att.outputs?.[c]?.sha256) die(`${c}: ${basename(src)} is not the attested file`);
    const v = await verifyZkey(
      join(dir, "build", `${c}.r1cs`),
      ptauPath(dir, s),
      dst,
      join(dir, "verify", `${String(index).padStart(4, "0")}_${c}.log`),
    );
    if (v.circuitHash !== s.circuits[c].circuitHash) die(`${c}: another circuit`);
    if (v.contributions.length !== index) die(`${c}: ${v.contributions.length} contributions, expected ${index}`);
    s.contributions.forEach((prev, i) => {
      if (v.contributions[i]?.hash !== prev.zkeys[c].contributionHash) die(`${c}: contribution #${i + 1} was rewritten`);
    });
    const last = v.contributions[index - 1]!;
    if (last.hash !== att.outputs[c].contributionHash || last.name !== att.name || last.beacon)
      die(`${c}: the zkey's contribution #${index} is not the attested one`);
    zkeys[c] = { file: `zkeys/${basename(dst)}`, sha256: sha, contributionHash: last.hash };
    log(dir, `#${index} ${att.name}: ${c} verified from r1cs + ptau, contribution hash ${last.hash.slice(0, 16)}…`);
  }
  mkdirSync(join(dir, "attestations"), { recursive: true });
  const kept = join(dir, "attestations", basename(attFile));
  copyFileSync(attFile, kept);
  for (const f of readdirSync(from)) {
    if (f.startsWith(basename(attFile)) && f !== basename(attFile)) copyFileSync(join(from, f), join(dir, "attestations", f));
  }
  s.contributions.push({
    index,
    name: att.name,
    acceptedAt: now(),
    attestation: { file: `attestations/${basename(attFile)}`, sha256: sha256File(kept) },
    zkeys,
  });
  saveState(dir, s);
  log(dir, `accepted contribution #${index} (${att.name}); send the new head to the next contributor`);
}

function ptauPath(dir: string, s: State): string {
  const p = process.env.COUNCIL_PTAU || DEFAULT_PTAU;
  if (!existsSync(p)) die(`no ptau at ${p} (COUNCIL_PTAU)`);
  if (sha256File(p) !== s.ptau.sha256) die(`${p} is not the ceremony's phase-1 file`);
  return p;
}

async function cmdAnnounce(o: { dir: string; drandRound?: string; drandIn?: string; block?: string; chainId?: string; rpc?: string }) {
  const dir = resolve(o.dir);
  const s = loadState(dir);
  if (s.beacon) die(`a beacon is already announced (${JSON.stringify(s.beacon.announcement)}); a new one needs a new ceremony`);
  let a: Announcement;
  if (o.drandRound || o.drandIn) {
    const latest = await drand("latest");
    verifyDrand(latest.round, latest.signature);
    const round = o.drandRound ? Number(o.drandRound) : latest.round + Math.ceil(Number(o.drandIn) / QUICKNET.period);
    if (!Number.isSafeInteger(round) || round <= latest.round) die(`drand round ${round} is not in the future (latest ${latest.round})`);
    a = {
      source: "drand",
      chain: "quicknet",
      chainHash: QUICKNET.chainHash,
      round,
      roundTime: new Date(roundTime(round) * 1000).toISOString(),
      announcedAt: now(),
    };
  } else if (o.block) {
    const rpcs = (o.rpc ?? "").split(",").filter(Boolean);
    if (!rpcs.length || !o.chainId) die("--block needs --chain-id and --rpc url[,url…]");
    const number = Number(o.block);
    for (const url of rpcs) {
      const latest = Number(await rpc(url, "eth_blockNumber", []));
      if (number <= latest) die(`block ${number} is not in the future on ${url} (latest ${latest})`);
    }
    a = { source: "block", chainId: Number(o.chainId), number, rpcs, announcedAt: now() };
  } else {
    return die("announce-beacon: --drand-round R | --drand-in SECONDS | --block N --chain-id ID --rpc URLS");
  }
  s.beacon = { announcement: a };
  saveState(dir, s);
  log(dir, `beacon announced: ${JSON.stringify(a)}`);
  log(dir, "publish this announcement now; contributions accepted after the beacon exists are refused");
}

async function cmdBeacon(o: { dir: string; wait: boolean }) {
  const dir = resolve(o.dir);
  const s = loadState(dir);
  if (!s.beacon) die("announce the beacon first");
  if (s.final) die("the beacon is already applied");
  if (s.contributions.length < 1) die("no contribution accepted");
  const a = s.beacon.announcement;
  if (o.wait && a.source === "drand") {
    const wait = roundTime(a.round) * 1000 - Date.now() + 2_000;
    if (wait > 0) {
      console.log(`waiting ${Math.ceil(wait / 1000)} s for drand round ${a.round}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  const b = await fetchBeacon(a);
  // the beacon must not have existed while any contribution was being made or accepted
  const lastAccepted = s.contributions[s.contributions.length - 1]!.acceptedAt;
  if (!(Date.parse(b.time) > Date.parse(lastAccepted)) || !(Date.parse(b.time) > Date.parse(a.announcedAt)))
    die(`the beacon (${b.time}) predates the last accepted contribution (${lastAccepted}) or its announcement`);
  log(dir, `beacon ${b.value} (${a.source}, ${b.time}) verified: ${JSON.stringify(b.evidence)}`);

  const h = head(s);
  const zkeys = {} as Record<CircuitName, ZkeyRecord>;
  for (const c of CIRCUITS) {
    const out = join(dir, "build", `${c}_final.zkey`);
    const name = `${s.tag} beacon ${a.source === "drand" ? `drand quicknet round ${a.round}` : `block ${a.chainId}:${a.number}`}`;
    const res = await snarkjs.zKey.beacon(join(dir, h.zkeys[c].file), out, name, b.value, BEACON_ITERATIONS_EXP, undefined as never);
    if (!res) die(`zkey beacon failed for ${c}`);
    const v = await verifyZkey(join(dir, "build", `${c}.r1cs`), ptauPath(dir, s), out, join(dir, "verify", `final_${c}.log`));
    const last = v.contributions[v.contributions.length - 1];
    if (v.contributions.length !== h.index + 1 || last?.beacon?.generator !== b.value || last.beacon.iterationsExp !== BEACON_ITERATIONS_EXP)
      die(`${c}: the final zkey does not end with this beacon`);
    zkeys[c] = { file: `build/${c}_final.zkey`, sha256: sha256File(out), contributionHash: last.hash };
    log(dir, `${c}: final zkey ${zkeys[c].sha256} verified (${v.contributions.length} contributions incl. the beacon)`);
  }
  s.beacon.fetched = b;
  s.final = { finishedAt: now(), zkeys };
  saveState(dir, s);
}

function snarkjsCli(args: string[]) {
  execFileSync(SNARKJS_BIN, args, { stdio: "ignore" });
}

async function cmdExport(o: { dir: string }) {
  const dir = resolve(o.dir);
  const s = loadState(dir);
  if (!s.final || !s.beacon?.fetched) die("apply the beacon first");
  const build = join(dir, "build");
  const out = join(dir, "release");
  mkdirSync(out, { recursive: true });
  for (const c of CIRCUITS) {
    if (sha256File(join(build, `${c}_final.zkey`)) !== s.final.zkeys[c].sha256) die(`${c}_final.zkey changed`);
    // the snarkjs CLI, as build.sh: the vkey file bytes are what the release id hashes
    snarkjsCli(["zkey", "export", "verificationkey", join(build, `${c}_final.zkey`), join(build, `${c}_vkey.json`)]);
    const raw = join(build, `${VERIFIER[c]}.raw.sol`);
    snarkjsCli(["zkey", "export", "solidityverifier", join(build, `${c}_final.zkey`), raw]);
    const lines = readFileSync(raw, "utf8").split("\n");
    const sol = [
      lines[0],
      `// Generated by circuits/scripts/ceremony from ${c}_final.zkey (snarkjs 0.7.6). Do not edit.`,
      `// ${s.tag}: multi-party phase 2, ${s.contributions.length} contributions + public beacon (release.json "ceremony").`,
      ...lines.slice(1),
    ]
      .join("\n")
      .replace("contract Groth16Verifier ", `contract ${VERIFIER[c]} `);
    if (!sol.includes(`contract ${VERIFIER[c]} `)) die(`verifier rename failed for ${c}`);
    writeFileSync(join(out, `${VERIFIER[c]}.sol`), sol);
  }
  const a = s.beacon.announcement;
  const manifest = await releaseManifest(build, {
    tag: s.tag,
    setup:
      `CEREMONY: phase 1 the Hermez/PPoT ${PTAU.name}; phase 2 ${s.contributions.length} independent ` +
      `contributions, each verified from the r1cs and the ptau, then a public beacon announced in advance ` +
      `(${a.source === "drand" ? `drand quicknet round ${a.round}` : `block ${a.number} of chain ${a.chainId}`}). ` +
      "Sound unless every contributor kept their randomness.",
    developmentSetup: false,
    ptauFile: ptauPath(dir, s),
    ceremony: {
      format: FORMAT,
      ptau: s.ptau,
      contributions: s.contributions.map((c) => ({
        index: c.index,
        name: c.name,
        attestationSha256: c.attestation.sha256,
        contributionHashes: Object.fromEntries(CIRCUITS.map((k) => [k, c.zkeys[k].contributionHash])),
      })),
      beacon: {
        announcement: a,
        value: s.beacon.fetched.value,
        time: s.beacon.fetched.time,
        evidence: s.beacon.fetched.evidence,
        iterationsExp: BEACON_ITERATIONS_EXP,
      },
    },
  });
  writeFileSync(join(build, "release.json"), JSON.stringify(manifest, null, 2) + "\n");
  const files: Record<string, string> = {};
  const put = (src: string, name: string) => {
    copyFileSync(src, join(out, name));
    files[name] = sha256File(join(out, name));
  };
  put(join(build, "release.json"), "release.json");
  for (const c of CIRCUITS) {
    put(join(build, `${c}_js`, `${c}.wasm`), `${c}.wasm`);
    put(join(build, `${c}_final.zkey`), `${c}_final.zkey`);
    put(join(build, `${c}_vkey.json`), `${c}_vkey.json`);
    files[`${VERIFIER[c]}.sol`] = sha256File(join(out, `${VERIFIER[c]}.sol`));
  }
  s.release = { circuitReleaseId: manifest.circuitReleaseId, files };
  saveState(dir, s);
  log(dir, `exported ${s.tag} (circuitReleaseId ${manifest.circuitReleaseId}) to ${out}`);
}

async function cmdInstall(o: { dir: string; repo: string; noPin: boolean }) {
  const dir = resolve(o.dir);
  const repo = resolve(o.repo);
  const s = loadState(dir);
  if (!s.release) die("export first");
  const rel = join(dir, "release");
  for (const [name, sha] of Object.entries(s.release.files)) {
    if (sha256File(join(rel, name)) !== sha) die(`${rel}/${name} changed since export`);
  }
  const copy = (from: string, to: string) => {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  };
  for (const name of ["release.json", "deal_vkey.json", "partial_vkey.json"]) copy(join(rel, name), join(repo, "circuits", "release", name));
  for (const c of CIRCUITS) copy(join(rel, `${VERIFIER[c]}.sol`), join(repo, "solidity", "src", "verifiers", `${VERIFIER[c]}.sol`));
  // circuits/build: what the circuit tests and the proof fixtures (make fixtures) read
  const build = join(repo, "circuits", "build");
  for (const c of CIRCUITS) {
    for (const f of [`${c}.r1cs`, `${c}.sym`, `${c}_final.zkey`, `${c}_vkey.json`]) copy(join(dir, "build", f), join(build, f));
    cpSync(join(dir, "build", `${c}_js`), join(build, `${c}_js`), { recursive: true });
    writeFileSync(join(build, `${c}.setup.r1cs.sha256`), s.circuits[c].r1cs.slice(2) + "\n");
  }
  copy(join(rel, "release.json"), join(build, "release.json"));
  log(dir, `installed ${s.tag} into ${repo}`);
  if (o.noPin) return;
  const forge = process.env.FORGE || (existsSync(join(homedir(), ".foundry", "bin", "forge")) ? join(homedir(), ".foundry", "bin", "forge") : "forge");
  execFileSync(forge, ["build"], { cwd: join(repo, "solidity"), stdio: "inherit" });
  execFileSync(join(CIRCUITS_DIR, "node_modules", ".bin", "tsx"), [join(CIRCUITS_DIR, "scripts", "pin.ts")], {
    stdio: "inherit",
    env: { ...process.env, COUNCIL_REPO_ROOT: repo },
  });
  log(dir, `re-pinned ${repo} (CouncilRelease.sol, sdk/src/artifacts.ts); next: make fixtures, the test suites, publish`);
}

/** Re-checks a published ceremony directory from scratch: what an auditor runs. */
async function cmdVerify(o: { dir: string; repo?: string; offline: boolean }) {
  const dir = resolve(o.dir);
  const s = loadState(dir);
  if (!s.final || !s.beacon?.fetched) die("the ceremony is not finished");
  const ptau = ptauPath(dir, s);
  if ((await blake2bFile(ptau)) !== PTAU.blake2b) die("the phase-1 file is not the Hermez ptau");
  const fetched = s.beacon.fetched;
  if (!o.offline) {
    const again = await fetchBeacon(s.beacon.announcement);
    if (again.value !== fetched.value) die(`the beacon source now says ${again.value}, the transcript ${fetched.value}`);
  }
  for (const [i, c] of s.contributions.entries()) {
    if (c.index !== i + 1) die(`contribution #${i + 1} out of order`);
    if (sha256File(join(dir, c.attestation.file)) !== c.attestation.sha256) die(`attestation #${c.index} changed`);
    const att = JSON.parse(readFileSync(join(dir, c.attestation.file), "utf8"));
    for (const k of CIRCUITS) {
      if (att.outputs[k].contributionHash !== c.zkeys[k].contributionHash) die(`attestation #${c.index} disagrees (${k})`);
    }
  }
  for (const c of CIRCUITS) {
    const r1cs = join(dir, "build", `${c}.r1cs`);
    if (sha256File(r1cs) !== s.circuits[c].r1cs) die(`${c}.r1cs changed`);
    const fin = join(dir, s.final.zkeys[c].file);
    if (sha256File(fin) !== s.final.zkeys[c].sha256) die(`${c}_final.zkey changed`);
    const v = await verifyZkey(r1cs, ptau, fin, join(dir, "verify", `audit_${c}.log`));
    if (v.contributions.length !== s.contributions.length + 1) die(`${c}: contribution count`);
    s.contributions.forEach((k, i) => {
      if (v.contributions[i]!.hash !== k.zkeys[c].contributionHash || v.contributions[i]!.name !== k.name)
        die(`${c}: contribution #${i + 1} differs from the transcript`);
    });
    const last = v.contributions[s.contributions.length]!;
    if (last.beacon?.generator !== fetched.value || last.beacon.iterationsExp !== BEACON_ITERATIONS_EXP)
      die(`${c}: the final contribution is not the announced beacon`);
    const vk = join(dir, "verify", `audit_${c}_vkey.json`);
    snarkjsCli(["zkey", "export", "verificationkey", fin, vk]);
    if (sha256File(vk) !== sha256File(join(dir, "release", `${c}_vkey.json`))) die(`${c}_vkey.json is not the final zkey's key`);
    console.log(`${c}: ${v.contributions.length - 1} contributions + beacon verified from r1cs + Hermez ptau`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, "release", "release.json"), "utf8"));
  if (manifest.circuitReleaseId !== s.release?.circuitReleaseId || manifest.developmentSetup !== false) die("release.json");
  if (o.repo) {
    const repo = resolve(o.repo);
    for (const f of ["release.json", "deal_vkey.json", "partial_vkey.json"]) {
      if (sha256File(join(repo, "circuits", "release", f)) !== sha256File(join(dir, "release", f))) die(`${repo}: circuits/release/${f} differs`);
    }
  }
  console.log(`OK: ${s.tag}, circuitReleaseId ${manifest.circuitReleaseId}, ${s.contributions.map((c) => c.name).join(", ")} + beacon`);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────────────

const USAGE = `usage: make ceremony ARGS="<command> …"  (= circuits/node_modules/.bin/tsx circuits/scripts/ceremony/ceremony.ts …)
  init             --dir D --tag circuits-vN [--ptau P]
  contribute       --in DIR --out DIR --name NAME [--tag circuits-vN]
  accept           --dir D --from DIR
  announce-beacon  --dir D (--drand-round R | --drand-in SECONDS | --block N --chain-id ID --rpc URL[,URL…])
  beacon           --dir D [--wait]
  export           --dir D
  install          --dir D [--repo ROOT] [--no-pin]
  verify           --dir D [--repo ROOT] [--offline]
COUNCIL_PTAU: the Hermez ptau (default ${DEFAULT_PTAU}); CIRCOM: circom 2.2.3.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values: v } = parseArgs({
    args: rest,
    options: {
      dir: { type: "string" },
      tag: { type: "string" },
      ptau: { type: "string" },
      in: { type: "string" },
      out: { type: "string" },
      name: { type: "string" },
      from: { type: "string" },
      "drand-round": { type: "string" },
      "drand-in": { type: "string" },
      block: { type: "string" },
      "chain-id": { type: "string" },
      rpc: { type: "string" },
      wait: { type: "boolean", default: false },
      repo: { type: "string" },
      "no-pin": { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
    },
  });
  const need = (k: keyof typeof v) => (v[k] as string | undefined) ?? die(`${cmd}: --${k} is required\n${USAGE}`);
  switch (cmd) {
    case "init":
      return cmdInit({ dir: need("dir"), tag: need("tag"), ptau: v.ptau ?? process.env.COUNCIL_PTAU ?? DEFAULT_PTAU });
    case "contribute":
      return cmdContribute({ in: need("in"), out: need("out"), name: need("name"), tag: v.tag });
    case "accept":
      return cmdAccept({ dir: need("dir"), from: need("from") });
    case "announce-beacon":
      return cmdAnnounce({
        dir: need("dir"),
        drandRound: v["drand-round"],
        drandIn: v["drand-in"],
        block: v.block,
        chainId: v["chain-id"],
        rpc: v.rpc,
      });
    case "beacon":
      return cmdBeacon({ dir: need("dir"), wait: v.wait });
    case "export":
      return cmdExport({ dir: need("dir") });
    case "install":
      return cmdInstall({ dir: need("dir"), repo: v.repo ?? REPO_DIR, noPin: v["no-pin"] });
    case "verify":
      return cmdVerify({ dir: need("dir"), repo: v.repo, offline: v.offline });
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

try {
  await main();
} catch (e) {
  console.error(`ceremony: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await shutdown();
}
