// Deterministic test ceremonies shared by the vector generator, the fixture generator and the
// circuit tests. Everything here is derived from pinned inputs; nothing is random.
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import * as P from "./protocol.ts";

export const TEST_MNEMONIC = "test test test test test test test test test test test junk";
export const CHAIN_ID = 31337n;
export const MANAGER: Address = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
export const ADAPTER: Address = "0xada0000000000000000000000000000000000001";
export const CREATOR: Address = "0xc0ea000000000000000000000000000000000001";
export const REGISTRATION_DEADLINE = 1900000000n;
export const DEALING_DURATION = 86400n;
export const VALID_UNTIL = 2000000000n;

/** Test-only circuit release: the vectors do not depend on any compiled artifact. */
export const TEST_DEAL_VKEY_SHA256 = P.sha256Hex(toBytes("davinci-dkg-council/v1/test-vector/deal-vkey"));
export const TEST_PARTIAL_VKEY_SHA256 = P.sha256Hex(toBytes("davinci-dkg-council/v1/test-vector/partial-vkey"));
export const TEST_CIRCUIT_RELEASE_ID = P.circuitReleaseIdOf(TEST_DEAL_VKEY_SHA256, TEST_PARTIAL_VKEY_SHA256);

export const participantMnemonic = (i: number): string =>
  entropyToMnemonic(toBytes(keccak256(toBytes(`davinci-dkg-council/v1/test-vector/participant/${i}`))).slice(0, 16), wordlist);

export type ScenarioSpec = {
  name: string;
  nonce: bigint;
  t: number;
  n: number;
  initialInvites: number;
  addedInvites: number;
  qual: number[];
  plaintexts: bigint[];
};

export const SPECS: ScenarioSpec[] = [
  {
    name: "A",
    nonce: 1n,
    t: 2,
    n: 3,
    initialInvites: 3,
    addedInvites: 2,
    qual: [1, 3], // member 2 never deals but still recovers its share
    plaintexts: [7n, 0n, P.RESULT_BOUND - 1n],
  },
  {
    name: "B",
    nonce: 2n,
    t: 16,
    n: 16,
    initialInvites: 16,
    addedInvites: 0,
    qual: Array.from({ length: 16 }, (_, i) => i + 1),
    plaintexts: Array.from({ length: 16 }, (_, k) => (k === 15 ? P.RESULT_BOUND - 1n : BigInt(k * 1000 + k))),
  },
];

export type Member = {
  index: number;
  mnemonic: string;
  seed: Uint8Array;
  prk: Uint8Array;
  inviteId: number;
  auth: P.DeriveTrace;
  authAddress: Address;
  share: P.DeriveTrace;
  X: P.Point;
  popNonce: bigint;
  pop: ReturnType<typeof P.joinPop>;
};

export type Scenario = {
  spec: ScenarioSpec;
  organizer: { seed: Uint8Array; prk: Uint8Array; key: P.DeriveTrace; address: Address };
  ceremonyId: Hex;
  invites: { inviteId: number; key: P.DeriveTrace; address: Address }[];
  members: Member[];
  rosterHash: Hex;
  circuitReleaseId: Hex;
  ctx: Hex;
  dealings: { frozen: P.DealerFrozen; coeffs: P.DeriveTrace[]; eph: P.DeriveTrace; dealing: P.Dealing }[];
  aggregates: P.Point[];
  publicKey: P.Point;
  memberKeys: P.Point[];
  shares: bigint[];
  processId: Hex;
  requestId: Hex;
  rho: bigint[];
  cts: { C1: P.Point; C2: P.Point }[];
};

export function buildScenario(spec: ScenarioSpec): Scenario {
  const orgSeed = P.seedFromMnemonic(TEST_MNEMONIC);
  const orgPrk = P.prkFromSeed(orgSeed);
  const orgKey = P.deriveScalar(orgPrk, P.SECP256K1_N, P.PURPOSES.organizerAuth, P.organizerContext(CHAIN_ID, MANAGER), false);
  const organizer = { seed: orgSeed, prk: orgPrk, key: orgKey, address: P.secpAddress(orgKey.value).toLowerCase() as Address };
  const ceremonyId = P.ceremonyIdOf(CHAIN_ID, MANAGER, organizer.address, spec.nonce);

  const invites = Array.from({ length: spec.initialInvites + spec.addedInvites }, (_, inviteId) => {
    const key = P.deriveScalar(
      orgPrk,
      P.SECP256K1_N,
      P.PURPOSES.inviteCapability,
      P.inviteContext(CHAIN_ID, MANAGER, ceremonyId, inviteId),
      false,
    );
    return { inviteId, key, address: P.secpAddress(key.value).toLowerCase() as Address };
  });

  const members: Member[] = [];
  for (let index = 1; index <= spec.n; index++) {
    const mnemonic = participantMnemonic(index);
    const seed = P.seedFromMnemonic(mnemonic);
    const prk = P.prkFromSeed(seed);
    const ctxFields = P.ceremonyContext(CHAIN_ID, MANAGER, ceremonyId);
    const auth = P.deriveScalar(prk, P.SECP256K1_N, P.PURPOSES.auth, ctxFields, false);
    const share = P.deriveScalar(prk, P.R, P.PURPOSES.shareEncryption, ctxFields, false);
    const authAddress = P.secpAddress(auth.value).toLowerCase() as Address;
    const popNonce = P.hashToScalar("davinci-dkg-council/v1/test-vector/pop-nonce", [
      { type: "bytes12", value: ceremonyId },
      { type: "uint8", value: index },
    ]).value;
    const pop = P.joinPop(CHAIN_ID, MANAGER, ceremonyId, authAddress, share.value, popNonce);
    members.push({ index, mnemonic, seed, prk, inviteId: index - 1, auth, authAddress, share, X: pop.X, popNonce, pop });
  }

  const roster = members.map((m) => m.X);
  const rosterHash = P.rosterHashOf(
    CHAIN_ID,
    MANAGER,
    ceremonyId,
    spec.t,
    members.map((m) => m.authAddress),
    roster,
  );
  const circuitReleaseId = TEST_CIRCUIT_RELEASE_ID;
  const ctx = P.dealContextOf(CHAIN_ID, MANAGER, ceremonyId, rosterHash, circuitReleaseId);

  const dealings = spec.qual.map((j) => {
    const m = members[j - 1];
    const frozen: P.DealerFrozen = {
      chainId: CHAIN_ID,
      manager: MANAGER,
      ceremonyId,
      accountIndex: 0,
      rosterHash,
      dealerIndex: j,
      t: spec.t,
      circuitReleaseId,
    };
    const base = P.dealerFrozenContext(frozen);
    const coeffs = Array.from({ length: spec.t }, (_, k) =>
      P.deriveScalar(m.prk, P.R, P.PURPOSES.dealerCoefficient, [...base, { type: "uint8", value: k }], true),
    );
    const eph = P.deriveScalar(m.prk, P.R, P.PURPOSES.dealerEphemeral, base, false);
    const dealing = P.makeDealing(
      ctx,
      j,
      spec.t,
      roster,
      coeffs.map((c) => c.value),
      eph.value,
    );
    return { frozen, coeffs, eph, dealing };
  });

  const aggregates = P.aggregate(
    dealings.map((d) => d.dealing),
    spec.t,
  );
  const publicKey = aggregates[0];
  const memberKeys = members.map((m) => P.memberKey(aggregates, m.index));
  const shares = members.map((m) => {
    let s = 0n;
    for (const d of dealings) s = (s + P.recoverShare(ctx, d.dealing, m.index, m.share.value).s) % P.R;
    if (!P.eqPoint(P.mulG(s), memberKeys[m.index - 1])) throw new Error("PK_m mismatch");
    return s;
  });

  const processId = keccak256(toBytes(`davinci-dkg-council/v1/test-vector/process/${spec.name}`)).slice(0, 2 + 62) as Hex;
  const requestId = P.requestIdOf(CHAIN_ID, MANAGER, ceremonyId, ADAPTER, processId);
  const rho = spec.plaintexts.map(
    (_, k) =>
      P.hashToScalar("davinci-dkg-council/v1/test-vector/encrypt-randomness", [
        { type: "bytes32", value: requestId },
        { type: "uint8", value: k },
      ]).value,
  );
  const cts = spec.plaintexts.map((m, k) => ({
    C1: P.mulG(rho[k]),
    C2: P.pointAdd(P.mulG(m), P.mul(publicKey, rho[k])),
  }));

  return {
    spec,
    organizer,
    ceremonyId,
    invites,
    members,
    rosterHash,
    circuitReleaseId,
    ctx,
    dealings,
    aggregates,
    publicKey,
    memberKeys,
    shares,
    processId,
    requestId,
    rho,
    cts,
  };
}

/** Placeholder proof words used only for the payload-hash encoding vectors (no circuit needed). */
export const PLACEHOLDER_PROOF: P.ProofWords = {
  pA: [1n, 2n],
  pB: [
    [3n, 4n],
    [5n, 6n],
  ],
  pC: [7n, 8n],
};
