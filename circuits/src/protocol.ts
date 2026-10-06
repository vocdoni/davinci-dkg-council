// Standalone reference implementation of the Council v1 encodings (docs/protocol.md), used only to
// generate the cross-implementation vectors and the circuit tests. It must never import the SDK.
import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  toBytes,
  toHex,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { sha256 } from "@noble/hashes/sha2.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { poseidon7 } from "poseidon-lite";
import { addPoint, mulPointEscalar } from "@zk-kit/baby-jubjub";

// ---------------------------------------------------------------------------------------------
// §2 constants
// ---------------------------------------------------------------------------------------------

export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const R = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
export const A_TE = 168700n;
export const D_TE = 168696n;
export const COFACTOR = 8n;
export const CURVE_ORDER = 21888242871839275222246405745257275088614511777268538073601725287587578984328n;
export const SECP256K1_N = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;
export const Q_BN = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
export const K_MAP = 15527681003928902128179717624703512672403908117992798440346960750464748824729n;
export const K_INV = 1911982854305225074381251344103329931637610209014896889891168275855466657090n;
export const LIMIT_R = 114913275077156194916793630162600694215226186830659824886409057759834789667722n;
export const MASK_CONST = 10214054970402064552395134490408265161209242095674905809605444618984955431150n;

export const MAX_N = 16;
export const MAX_T = 16;
export const MAX_FIELDS = 16;
export const RESULT_BOUND = 1n << 40n;
export const MAX_COMBINE_FIELDS = 4;
export const MAX_INVITES = 64;
export const MIN_DEALING_DURATION = 600;

export type Point = readonly [bigint, bigint];
export const O: Point = [0n, 1n];
export const G: Point = [
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n,
];
export const REDUCED_G_X = 9671717474070082183213120605117400219616337014328744928644933853176787189663n;

export const TAGS = {
  ceremony: "davinci-dkg-council/v1/ceremony",
  roster: "davinci-dkg-council/v1/roster",
  dealContext: "davinci-dkg-council/v1/deal-context",
  dealPayload: "davinci-dkg-council/v1/deal-payload",
  joinPop: "davinci-dkg-council/v1/join-pop",
  request: "davinci-dkg-council/v1/request",
  partialPayload: "davinci-dkg-council/v1/partial-payload",
  circuitRelease: "davinci-dkg-council/v1/circuit-release",
  shareMaskPoseidon: "davinci-dkg-council/v1/share-mask-poseidon",
} as const;

export const PINNED_TAG_HASHES: Record<string, Hex> = {
  "davinci-dkg-council/v1/ceremony": "0xecb738c07e6a59197a7fd9e2f5e6116948f75ddf4ac1167be6d353868161465f",
  "davinci-dkg-council/v1/roster": "0x2c9d4948616c1a88c354348793d30f18ea38d1f04ad5854da9e32746a3b11ac9",
  "davinci-dkg-council/v1/deal-context": "0xdbb35e5b108ffc795df6963925b9215f480adc307c37d7301c3e91d8e2b7bb7c",
  "davinci-dkg-council/v1/deal-payload": "0x1326b87fc239e1401c315964035b32e39ac95374aecd1472e03710d68890394e",
  "davinci-dkg-council/v1/join-pop": "0xf82c8d4d3410e2766e553a29e47765d8dca7d7bb5d3c8d1226c3736cb39bbb19",
  "davinci-dkg-council/v1/request": "0x2044a532478c345d057d687f1827a3c194b5c92d1c7471f6aa59fe10fe010ba7",
  "davinci-dkg-council/v1/partial-payload": "0x790ea2a939d8ccdf25ac8c84f7bffca5476a976d584b89ca4a7f365b8e85c589",
  "davinci-dkg-council/v1/circuit-release": "0x9e489062d0e615d54b9cf250918652a1541571f981e4892e70d382d1536fdf5c",
  "davinci-dkg-council/v1/share-mask-poseidon": "0xd8262d0eb7248e9458410cb71d8ace07c8eabd235f11ed9fb71812260a9dc8f2",
};

export const DERIVE_PREFIX = "davinci-dkg-council/v1/derive/";
export const PURPOSES = {
  auth: DERIVE_PREFIX + "auth-secp256k1",
  shareEncryption: DERIVE_PREFIX + "share-encryption-bjj",
  organizerAuth: DERIVE_PREFIX + "organizer-auth-secp256k1",
  inviteCapability: DERIVE_PREFIX + "invite-capability-secp256k1",
  dealerCoefficient: DERIVE_PREFIX + "dealer-coefficient",
  dealerEphemeral: DERIVE_PREFIX + "dealer-ephemeral",
} as const;
export const HKDF_SALT = "davinci-dkg-council/seed/v1";
export const DERIVATION_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// field helpers
// ---------------------------------------------------------------------------------------------

export const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m;

export function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let result = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

export const invMod = (a: bigint, m: bigint): bigint => {
  if (mod(a, m) === 0n) throw new Error("inverse of zero");
  return modPow(a, m - 2n, m); // m is prime for every use here
};

export const dec = (x: bigint | number): string => BigInt(x).toString(10);
export const hex32 = (x: bigint): Hex => toHex(x, { size: 32 });

// ---------------------------------------------------------------------------------------------
// BabyJubJub, circomlib twisted Edwards chart. Extended coordinates for speed; the unified
// addition law is complete on this curve (a square, d non-square). Cross-checked against
// @zk-kit/baby-jubjub by checkCurveImplementation().
// ---------------------------------------------------------------------------------------------

type Ext = { X: bigint; Y: bigint; Z: bigint; T: bigint };
const toExt = (p: Point): Ext => ({ X: p[0], Y: p[1], Z: 1n, T: (p[0] * p[1]) % P });
const fromExt = (q: Ext): Point => {
  const zi = invMod(q.Z, P);
  return [(q.X * zi) % P, (q.Y * zi) % P];
};
function extAdd(p: Ext, q: Ext): Ext {
  const a = (p.X * q.X) % P;
  const b = (p.Y * q.Y) % P;
  const c = (((D_TE * p.T) % P) * q.T) % P;
  const d = (p.Z * q.Z) % P;
  const e = mod((p.X + p.Y) * (q.X + q.Y) - a - b, P);
  const f = mod(d - c, P);
  const g = (d + c) % P;
  const h = mod(b - A_TE * a, P);
  return { X: (e * f) % P, Y: (g * h) % P, T: (e * h) % P, Z: (f * g) % P };
}

export function pointAdd(p: Point, q: Point): Point {
  return fromExt(extAdd(toExt(p), toExt(q)));
}

export function pointNeg(p: Point): Point {
  return [mod(-p[0], P), p[1]];
}

/** k·Q for any k >= 0 (not reduced mod r: callers pass canonical scalars or small multipliers). */
export function mul(q: Point, k: bigint): Point {
  if (k < 0n) throw new Error("negative scalar");
  let acc: Ext = toExt(O);
  let base = toExt(q);
  while (k > 0n) {
    if (k & 1n) acc = extAdd(acc, base);
    base = extAdd(base, base);
    k >>= 1n;
  }
  return fromExt(acc);
}

export const mulG = (k: bigint): Point => mul(G, k);
export const eqPoint = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];

export function onCurve(p: Point): boolean {
  const [x, y] = p;
  const x2 = (x * x) % P;
  const y2 = (y * y) % P;
  return mod(A_TE * x2 + y2 - 1n - ((D_TE * x2) % P) * y2, P) === 0n;
}

export const inPrimeSubgroup = (p: Point): boolean => onCurve(p) && eqPoint(mul(p, R), O);

export const toReducedX = (xTe: bigint): bigint => (xTe * K_MAP) % P;

export function checkCurveImplementation(): void {
  const samples = [1n, 2n, 7n, 123456789n, R - 1n, 2n ** 200n + 5n];
  for (const k of samples) {
    const ours = mulG(k);
    const theirs = mulPointEscalar([G[0], G[1]], k);
    if (ours[0] !== theirs[0] || ours[1] !== theirs[1]) throw new Error(`curve mismatch at ${k}`);
  }
  const a = mulG(11n);
  const b = mulG(29n);
  const theirs = addPoint([a[0], a[1]], [b[0], b[1]]);
  if (!eqPoint(pointAdd(a, b), [theirs[0], theirs[1]])) throw new Error("add mismatch");
  if (!eqPoint(mulG(R), O)) throw new Error("G does not have order r");
}

// ---------------------------------------------------------------------------------------------
// §1 tagged hash, §3 HashToScalar, §3.2 Poseidon7
// ---------------------------------------------------------------------------------------------

export type Field = { type: string; value: unknown };
const params = (fields: Field[]): AbiParameter[] => fields.map((f) => ({ type: f.type }));
const values = (fields: Field[]): unknown[] => fields.map((f) => f.value);

export const tagHash = (tag: string): Hex => keccak256(toBytes(tag));
export const abiEncode = (fields: Field[]): Hex => encodeAbiParameters(params(fields), values(fields) as never);

/** K(tag, f1..fk) = keccak256(abi.encode(keccak256(utf8(tag)), f1, .., fk)) */
export function taggedHash(tag: string, fields: Field[]): Hex {
  return keccak256(abiEncode([{ type: "bytes32", value: tagHash(tag) }, ...fields]));
}

export type HashToScalarTrace = { value: bigint; counter: number; attempts: { counter: number; u: bigint; accepted: boolean }[] };

export function hashToScalar(tag: string, fields: Field[]): HashToScalarTrace {
  const attempts: HashToScalarTrace["attempts"] = [];
  for (let counter = 0; counter <= 255; counter++) {
    const u = BigInt(
      keccak256(abiEncode([{ type: "bytes32", value: tagHash(tag) }, ...fields, { type: "uint32", value: counter }])),
    );
    const accepted = u < LIMIT_R;
    attempts.push({ counter, u, accepted });
    if (accepted) return { value: u % R, counter, attempts };
  }
  throw new Error("HashToScalar exhausted");
}

export const poseidon7Hash = (inputs: bigint[]): bigint => {
  if (inputs.length !== 7) throw new Error("poseidon7 takes 7 inputs");
  return poseidon7(inputs);
};

export function limbs(b32: Hex): { hi: bigint; lo: bigint } {
  const v = BigInt(b32);
  return { hi: v >> 128n, lo: v & ((1n << 128n) - 1n) };
}

// ---------------------------------------------------------------------------------------------
// §5 keys
// ---------------------------------------------------------------------------------------------

export function seedFromMnemonic(mnemonic: string): Uint8Array {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("invalid mnemonic");
  return mnemonicToSeedSync(mnemonic, "");
}

export const prkFromSeed = (seed: Uint8Array): Uint8Array => extract(sha256, seed, toBytes(HKDF_SALT));

export type DeriveTrace = {
  value: bigint;
  counter: number;
  info0: Hex;
  attempts: { counter: number; u: bigint; rejected?: "limit" | "zero" }[];
};

export function deriveScalar(prk: Uint8Array, q: bigint, purpose: string, context: Field[], allowZero: boolean): DeriveTrace {
  const limit = ((1n << 256n) / q) * q;
  const contextHash = keccak256(abiEncode(context));
  const attempts: DeriveTrace["attempts"] = [];
  let info0: Hex = "0x";
  for (let counter = 0; counter <= 0xffffffff; counter++) {
    const info = abiEncode([
      { type: "bytes32", value: tagHash(purpose) },
      { type: "bytes32", value: contextHash },
      { type: "uint32", value: counter },
    ]);
    if (counter === 0) info0 = info;
    const u = BigInt(toHex(expand(sha256, prk, toBytes(info), 32)));
    if (u >= limit) {
      attempts.push({ counter, u, rejected: "limit" });
      continue;
    }
    const v = u % q;
    if (v === 0n && !allowZero) {
      attempts.push({ counter, u, rejected: "zero" });
      continue;
    }
    attempts.push({ counter, u });
    return { value: v, counter, info0, attempts };
  }
  throw new Error("DeriveScalar exhausted");
}

export const ceremonyContext = (chainId: bigint, manager: Address, ceremonyId: Hex, accountIndex = 0): Field[] => [
  { type: "uint256", value: chainId },
  { type: "address", value: manager },
  { type: "bytes12", value: ceremonyId },
  { type: "uint32", value: accountIndex },
  { type: "uint32", value: DERIVATION_VERSION },
];

export const organizerContext = (chainId: bigint, manager: Address, accountIndex = 0): Field[] => [
  { type: "uint256", value: chainId },
  { type: "address", value: manager },
  { type: "uint32", value: accountIndex },
  { type: "uint32", value: DERIVATION_VERSION },
];

export const inviteContext = (chainId: bigint, manager: Address, ceremonyId: Hex, inviteId: number): Field[] => [
  { type: "uint256", value: chainId },
  { type: "address", value: manager },
  { type: "bytes12", value: ceremonyId },
  { type: "uint32", value: inviteId },
  { type: "uint32", value: DERIVATION_VERSION },
];

export type DealerFrozen = {
  chainId: bigint;
  manager: Address;
  ceremonyId: Hex;
  accountIndex: number;
  rosterHash: Hex;
  dealerIndex: number;
  t: number;
  circuitReleaseId: Hex;
};

export const dealerFrozenContext = (f: DealerFrozen): Field[] => [
  { type: "uint256", value: f.chainId },
  { type: "address", value: f.manager },
  { type: "bytes12", value: f.ceremonyId },
  { type: "uint32", value: f.accountIndex },
  { type: "uint32", value: DERIVATION_VERSION },
  { type: "bytes32", value: f.rosterHash },
  { type: "uint8", value: f.dealerIndex },
  { type: "uint8", value: f.t },
  { type: "bytes32", value: f.circuitReleaseId },
];

export const secpAddress = (d: bigint): Address => privateKeyToAddress(hex32(d));

// ---------------------------------------------------------------------------------------------
// §4 identifiers
// ---------------------------------------------------------------------------------------------

export function ceremonyIdOf(chainId: bigint, manager: Address, organizer: Address, nonce: bigint): Hex {
  const full = taggedHash(TAGS.ceremony, [
    { type: "uint256", value: chainId },
    { type: "address", value: manager },
    { type: "address", value: organizer },
    { type: "uint64", value: nonce },
  ]);
  return full.slice(0, 2 + 24) as Hex;
}

export function rosterHashOf(
  chainId: bigint,
  manager: Address,
  ceremonyId: Hex,
  t: number,
  auth: Address[],
  keys: Point[],
): Hex {
  return taggedHash(TAGS.roster, [
    { type: "uint256", value: chainId },
    { type: "address", value: manager },
    { type: "bytes12", value: ceremonyId },
    { type: "uint8", value: t },
    { type: "uint8", value: auth.length },
    { type: "address[]", value: auth },
    { type: "uint256[]", value: keys.map((k) => k[0]) },
    { type: "uint256[]", value: keys.map((k) => k[1]) },
  ]);
}

export function dealContextOf(chainId: bigint, manager: Address, ceremonyId: Hex, rosterHash: Hex, circuitReleaseId: Hex): Hex {
  return taggedHash(TAGS.dealContext, [
    { type: "uint256", value: chainId },
    { type: "address", value: manager },
    { type: "bytes12", value: ceremonyId },
    { type: "bytes32", value: rosterHash },
    { type: "bytes32", value: circuitReleaseId },
  ]);
}

export function circuitReleaseIdOf(dealVkeySha256: Hex, partialVkeySha256: Hex): Hex {
  return taggedHash(TAGS.circuitRelease, [
    { type: "bytes32", value: dealVkeySha256 },
    { type: "bytes32", value: partialVkeySha256 },
  ]);
}

export function requestIdOf(chainId: bigint, manager: Address, ceremonyId: Hex, adapter: Address, processId: Hex): Hex {
  return taggedHash(TAGS.request, [
    { type: "uint256", value: chainId },
    { type: "address", value: manager },
    { type: "bytes12", value: ceremonyId },
    { type: "address", value: adapter },
    { type: "bytes31", value: processId },
  ]);
}

// ---------------------------------------------------------------------------------------------
// §8.2 join proof of possession (the nonce is a parameter: the vectors pin a test-only nonce,
// production nonces come from the CSPRNG)
// ---------------------------------------------------------------------------------------------

export function joinPop(
  chainId: bigint,
  manager: Address,
  ceremonyId: Hex,
  participant: Address,
  x: bigint,
  k: bigint,
): { X: Point; A: Point; c: bigint; z: bigint; cTrace: HashToScalarTrace } {
  const X = mulG(x);
  const A = mulG(k);
  const cTrace = hashToScalar(TAGS.joinPop, [
    { type: "uint256", value: chainId },
    { type: "address", value: manager },
    { type: "bytes12", value: ceremonyId },
    { type: "address", value: participant },
    { type: "uint256", value: X[0] },
    { type: "uint256", value: X[1] },
    { type: "uint256", value: A[0] },
    { type: "uint256", value: A[1] },
  ]);
  const c = cTrace.value;
  const z = (k + c * x) % R;
  if (!eqPoint(mulG(z), pointAdd(A, mul(X, c)))) throw new Error("PoP self-check failed");
  return { X, A, c, z, cTrace };
}

// ---------------------------------------------------------------------------------------------
// §8.3 dealing, §8.5 witness and public inputs
// ---------------------------------------------------------------------------------------------

export type Dealing = {
  dealerIndex: number;
  t: number;
  n: number;
  a: bigint[]; // length MAX_T, zero for k >= t
  e: bigint;
  C: Point[]; // length MAX_T, identity for k >= t
  E: Point;
  s: bigint[]; // length MAX_N, zero for i >= n
  S: Point[]; // ECDH points for active slots
  h: bigint[]; // masks for active slots
  masked: bigint[]; // length MAX_N, zero for i >= n
};

export const evalPoly = (a: bigint[], z: bigint): bigint => {
  let acc = 0n;
  for (let k = a.length - 1; k >= 0; k--) acc = (acc * z + a[k]) % R;
  return acc;
};

export function maskOf(ctx: Hex, dealerIndex: number, member: number, S: Point): bigint {
  const { hi, lo } = limbs(ctx);
  return poseidon7Hash([MASK_CONST, hi, lo, BigInt(dealerIndex), BigInt(member), S[0], S[1]]);
}

/** Horner(C, m) = Σ_k m^k·C_k evaluated over the full padded vector, as the circuit does. */
export function hornerPoints(C: Point[], m: number): Point {
  let acc = C[C.length - 1];
  for (let k = C.length - 2; k >= 0; k--) acc = pointAdd(mul(acc, BigInt(m)), C[k]);
  return acc;
}

export function makeDealing(ctx: Hex, dealerIndex: number, t: number, roster: Point[], coeffs: bigint[], e: bigint): Dealing {
  const n = roster.length;
  if (coeffs.length !== t) throw new Error("need t coefficients");
  if (!(1 <= t && t <= n && n <= MAX_N)) throw new Error("bad t/n");
  if (e === 0n || e >= R) throw new Error("bad ephemeral");
  const a = [...coeffs, ...Array(MAX_T - t).fill(0n)];
  const C = a.map((ak, k) => (k < t ? mulG(ak) : O));
  const E = mulG(e);
  const s: bigint[] = [];
  const S: Point[] = [];
  const h: bigint[] = [];
  const masked: bigint[] = [];
  for (let i = 0; i < MAX_N; i++) {
    if (i < n) {
      const m = i + 1;
      const si = evalPoly(coeffs, BigInt(m));
      const Si = mul(roster[i], e);
      const hi = maskOf(ctx, dealerIndex, m, Si);
      s.push(si);
      S.push(Si);
      h.push(hi);
      masked.push((si + hi) % P);
    } else {
      s.push(0n);
      masked.push(0n);
    }
  }
  return { dealerIndex, t, n, a, e, C, E, s, S, h, masked };
}

export const paddedRoster = (roster: Point[]): Point[] => [...roster, ...Array(MAX_N - roster.length).fill(G)];

export function dealWitnessInput(ctx: Hex, d: Dealing, roster: Point[]) {
  const { hi, lo } = limbs(ctx);
  return {
    ctxHi: dec(hi),
    ctxLo: dec(lo),
    dealerIndex: dec(d.dealerIndex),
    n: dec(d.n),
    t: dec(d.t),
    C: d.C.map((c) => [dec(c[0]), dec(c[1])]),
    E: [dec(d.E[0]), dec(d.E[1])],
    X: paddedRoster(roster).map((x) => [dec(x[0]), dec(x[1])]),
    masked: d.masked.map(dec),
    a: d.a.map(dec),
    e: dec(d.e),
    s: d.s.map(dec),
  };
}

export type DealWitnessInput = ReturnType<typeof dealWitnessInput>;

/** The 87-word public input vector, protocol §8.5 table order. */
export function dealPublicInputs(w: DealWitnessInput): string[] {
  return [
    w.ctxHi,
    w.ctxLo,
    w.dealerIndex,
    w.n,
    w.t,
    ...w.C.flat(),
    ...w.E,
    ...w.X.flat(),
    ...w.masked,
  ];
}

// ---------------------------------------------------------------------------------------------
// §7.2 payload hashes and proof words
// ---------------------------------------------------------------------------------------------

export type ProofWords = { pA: [bigint, bigint]; pB: [[bigint, bigint], [bigint, bigint]]; pC: [bigint, bigint] };

export function dealPayloadHash(ctx: Hex, C: Point[], E: Point, masked: bigint[], proof: ProofWords): Hex {
  return keccak256(
    abiEncode([
      { type: "bytes32", value: tagHash(TAGS.dealPayload) },
      { type: "bytes32", value: ctx },
      { type: "uint256[2][16]", value: C.map((c) => [c[0], c[1]]) },
      { type: "uint256[2]", value: [E[0], E[1]] },
      { type: "uint256[16]", value: masked },
      { type: "uint256[2]", value: proof.pA },
      { type: "uint256[2][2]", value: proof.pB },
      { type: "uint256[2]", value: proof.pC },
    ]),
  );
}

export function partialPayloadHash(requestId: Hex, D: Point[], proof: ProofWords): Hex {
  return keccak256(
    abiEncode([
      { type: "bytes32", value: tagHash(TAGS.partialPayload) },
      { type: "bytes32", value: requestId },
      { type: "uint256[2][16]", value: D.map((d) => [d[0], d[1]]) },
      { type: "uint256[2]", value: proof.pA },
      { type: "uint256[2][2]", value: proof.pB },
      { type: "uint256[2]", value: proof.pC },
    ]),
  );
}

/** snarkjs proof JSON -> exportSolidityCallData word order (G2 limbs swapped). */
export function proofWords(proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }): ProofWords {
  return {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
  };
}

// ---------------------------------------------------------------------------------------------
// §8.4 finalize, §8.6 recovery, §10 partials, Lagrange, combine
// ---------------------------------------------------------------------------------------------

export function aggregate(dealings: Dealing[], t: number): Point[] {
  const A: Point[] = [];
  for (let k = 0; k < t; k++) A.push(dealings.reduce((acc, d) => pointAdd(acc, d.C[k]), O));
  return A;
}

export const memberKey = (A: Point[], m: number): Point => hornerPoints(A, m);

export function recoverShare(ctx: Hex, d: Dealing, member: number, x: bigint): { S: Point; h: bigint; s: bigint } {
  const S = mul(d.E, x);
  const h = maskOf(ctx, d.dealerIndex, member, S);
  const s = mod(d.masked[member - 1] - h, P);
  if (s >= R) throw new Error("recovered share not canonical");
  if (!eqPoint(mulG(s), hornerPoints(d.C, member))) throw new Error("Feldman check failed");
  return { S, h, s };
}

export function lagrange(set: number[]): bigint[] {
  return set.map((i) => {
    let num = 1n;
    let den = 1n;
    for (const h of set) {
      if (h === i) continue;
      num = (num * BigInt(h)) % R;
      den = (den * mod(BigInt(h - i), R)) % R;
    }
    return (num * invMod(den, R)) % R;
  });
}

export function partialWitnessInput(PK: Point, s: bigint, C1: Point[]) {
  const fieldCount = C1.length;
  if (fieldCount < 1 || fieldCount > MAX_FIELDS) throw new Error("bad field count");
  const C1p = [...C1, ...Array(MAX_FIELDS - fieldCount).fill(G)] as Point[];
  const D = C1p.map((c, k) => (k < fieldCount ? mul(c, s) : O));
  return {
    PK: [dec(PK[0]), dec(PK[1])],
    activeCount: dec(fieldCount),
    C1: C1p.map((c) => [dec(c[0]), dec(c[1])]),
    D: D.map((d) => [dec(d[0]), dec(d[1])]),
    s: dec(s),
  };
}

export type PartialWitnessInput = ReturnType<typeof partialWitnessInput>;

/** The 67-word public input vector, protocol §10.1 table order. */
export const partialPublicInputs = (w: PartialWitnessInput): string[] => [
  ...w.PK,
  w.activeCount,
  ...w.C1.flat(),
  ...w.D.flat(),
];

// ---------------------------------------------------------------------------------------------
// §7 EIP-712
// ---------------------------------------------------------------------------------------------

export const EIP712_DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
export const EIP712_TYPES = {
  CreateCeremony: [
    { name: "organizer", type: "address" },
    { name: "nonce", type: "uint64" },
    { name: "threshold", type: "uint8" },
    { name: "registrationDeadline", type: "uint64" },
    { name: "dealingDuration", type: "uint64" },
    { name: "inviteKeys", type: "address[]" },
    { name: "validUntil", type: "uint64" },
  ],
  AddInvites: [
    { name: "ceremonyId", type: "bytes12" },
    { name: "firstInviteId", type: "uint32" },
    { name: "inviteKeys", type: "address[]" },
    { name: "validUntil", type: "uint64" },
  ],
  CloseRegistration: [
    { name: "ceremonyId", type: "bytes12" },
    { name: "participantCount", type: "uint8" },
    { name: "validUntil", type: "uint64" },
  ],
  AllowAdapter: [
    { name: "ceremonyId", type: "bytes12" },
    { name: "adapter", type: "address" },
    { name: "validUntil", type: "uint64" },
  ],
  AuthorizeCreator: [
    { name: "ceremonyId", type: "bytes12" },
    { name: "creator", type: "address" },
    { name: "validUntil", type: "uint64" },
  ],
  Invite: [
    { name: "ceremonyId", type: "bytes12" },
    { name: "inviteId", type: "uint32" },
    { name: "participant", type: "address" },
    { name: "pkX", type: "uint256" },
    { name: "pkY", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
  Join: [
    { name: "ceremonyId", type: "bytes12" },
    { name: "participant", type: "address" },
    { name: "inviteId", type: "uint32" },
    { name: "pkX", type: "uint256" },
    { name: "pkY", type: "uint256" },
    { name: "popAx", type: "uint256" },
    { name: "popAy", type: "uint256" },
    { name: "popZ", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
  Deal: [
    { name: "ceremonyId", type: "bytes12" },
    { name: "dealerIndex", type: "uint8" },
    { name: "payloadHash", type: "bytes32" },
    { name: "validUntil", type: "uint64" },
  ],
  Partial: [
    { name: "ceremonyId", type: "bytes12" },
    { name: "requestId", type: "bytes32" },
    { name: "participantIndex", type: "uint8" },
    { name: "payloadHash", type: "bytes32" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export type StructName = keyof typeof EIP712_TYPES;

/** Pinned encodeType strings, protocol §7.2 (asserted against EIP712_TYPES). */
export const ENCODE_TYPES: Record<StructName, string> = {
  CreateCeremony:
    "CreateCeremony(address organizer,uint64 nonce,uint8 threshold,uint64 registrationDeadline,uint64 dealingDuration,address[] inviteKeys,uint64 validUntil)",
  AddInvites: "AddInvites(bytes12 ceremonyId,uint32 firstInviteId,address[] inviteKeys,uint64 validUntil)",
  CloseRegistration: "CloseRegistration(bytes12 ceremonyId,uint8 participantCount,uint64 validUntil)",
  AllowAdapter: "AllowAdapter(bytes12 ceremonyId,address adapter,uint64 validUntil)",
  AuthorizeCreator: "AuthorizeCreator(bytes12 ceremonyId,address creator,uint64 validUntil)",
  Invite: "Invite(bytes12 ceremonyId,uint32 inviteId,address participant,uint256 pkX,uint256 pkY,uint64 validUntil)",
  Join: "Join(bytes12 ceremonyId,address participant,uint32 inviteId,uint256 pkX,uint256 pkY,uint256 popAx,uint256 popAy,uint256 popZ,uint64 validUntil)",
  Deal: "Deal(bytes12 ceremonyId,uint8 dealerIndex,bytes32 payloadHash,uint64 validUntil)",
  Partial: "Partial(bytes12 ceremonyId,bytes32 requestId,uint8 participantIndex,bytes32 payloadHash,uint64 validUntil)",
};

export const domainOf = (chainId: bigint, manager: Address) => ({
  name: "DAVINCI DKG Council",
  version: "1",
  chainId,
  verifyingContract: manager,
});

export function domainSeparator(chainId: bigint, manager: Address): Hex {
  return keccak256(
    abiEncode([
      { type: "bytes32", value: keccak256(toBytes(EIP712_DOMAIN_TYPE)) },
      { type: "bytes32", value: keccak256(toBytes("DAVINCI DKG Council")) },
      { type: "bytes32", value: keccak256(toBytes("1")) },
      { type: "uint256", value: chainId },
      { type: "address", value: manager },
    ]),
  );
}

/** Manual EIP-712 hashStruct (no nested structs in Council; arrays are address[] only). */
export function structHash(name: StructName, message: Record<string, unknown>): Hex {
  const fields: Field[] = [{ type: "bytes32", value: keccak256(toBytes(ENCODE_TYPES[name])) }];
  for (const f of EIP712_TYPES[name]) {
    const v = message[f.name];
    if (f.type === "address[]") {
      fields.push({ type: "bytes32", value: keccak256(abiEncode((v as Address[]).map((a) => ({ type: "address", value: a })))) });
    } else {
      fields.push({ type: f.type, value: v });
    }
  }
  return keccak256(abiEncode(fields));
}

export async function signAction(
  chainId: bigint,
  manager: Address,
  name: StructName,
  message: Record<string, unknown>,
  signerKey: bigint,
): Promise<{ typeHash: Hex; structHash: Hex; digest: Hex; signature: Hex; signer: Address }> {
  const sh = structHash(name, message);
  const manual = keccak256(`0x1901${domainSeparator(chainId, manager).slice(2)}${sh.slice(2)}` as Hex);
  const typedData = {
    domain: domainOf(chainId, manager),
    types: { [name]: EIP712_TYPES[name] },
    primaryType: name,
    message,
  } as const;
  const digest = hashTypedData(typedData as never);
  if (digest !== manual) throw new Error(`EIP-712 digest mismatch for ${name}`);
  const account = privateKeyToAccount(hex32(signerKey));
  const signature = await account.signTypedData(typedData as never);
  return { typeHash: keccak256(toBytes(ENCODE_TYPES[name])), structHash: sh, digest, signature, signer: account.address };
}

export const sha256Hex = (data: Uint8Array): Hex => toHex(sha256(data));
