// Generates tests/vectors/*.json (protocol §12). Standalone: depends only on the
// reference encodings in src/ (viem, noble, scure, poseidon-lite, zk-kit), never on the SDK.
// Deterministic: running it twice produces byte-identical files.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import * as P from "../src/protocol.ts";
import * as S from "../src/scenario.ts";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "vectors");

const pt = (p: P.Point) => [P.dec(p[0]), P.dec(p[1])];
const lower = (h: string) => h.toLowerCase();

function json(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_k, v) => {
        if (typeof v === "bigint") return v.toString(10);
        if (v instanceof Uint8Array) return toHex(v);
        return v;
      },
      2,
    ) + "\n"
  );
}

function write(name: string, value: unknown) {
  writeFileSync(join(OUT, name), json(value));
  console.log(`wrote tests/vectors/${name}`);
}

const fieldsJson = (fields: P.Field[]) =>
  fields.map((f) => ({ type: f.type, value: typeof f.value === "number" ? String(f.value) : f.value }));

function traceJson(t: P.DeriveTrace) {
  return {
    counter: t.counter,
    info0: t.info0,
    attempts: t.attempts.map((a) => ({ counter: a.counter, u: hex(a.u), ...(a.rejected ? { rejected: a.rejected } : {}) })),
    value: t.value,
  };
}

const hex = (x: bigint): Hex => P.hex32(x);

// --------------------------------------------------------------------------------------------
// sanity checks of the pinned constants (fail loudly instead of emitting wrong vectors)
// --------------------------------------------------------------------------------------------

function checkConstants() {
  P.checkCurveImplementation();
  if (((1n << 256n) / P.R) * P.R !== P.LIMIT_R || (1n << 256n) / P.R !== 42n) throw new Error("LIMIT_R");
  if (BigInt(P.tagHash(P.TAGS.shareMaskPoseidon)) % P.P !== P.MASK_CONST) throw new Error("MASK_CONST");
  for (const [tag, h] of Object.entries(P.PINNED_TAG_HASHES)) if (P.tagHash(tag) !== h) throw new Error(`tag ${tag}`);
  if (P.R * 8n !== P.CURVE_ORDER) throw new Error("curve order");
  if ((P.K_MAP * P.K_MAP) % P.P !== P.mod(-P.A_TE, P.P)) throw new Error("K^2 != -a");
  if ((P.K_MAP * P.K_INV) % P.P !== 1n) throw new Error("K_INV");
  if (P.toReducedX(P.G[0]) !== P.REDUCED_G_X) throw new Error("reduced G");
  if (keccak256(toBytes(P.EIP712_DOMAIN_TYPE)) !== "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f")
    throw new Error("domain typehash");
  for (const [name, fields] of Object.entries(P.EIP712_TYPES)) {
    const s = `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
    if (s !== P.ENCODE_TYPES[name as P.StructName]) throw new Error(`encodeType ${name}`);
  }
  // the reduced chart is a = -1: check G maps onto it
  const xr = P.REDUCED_G_X;
  const y = P.G[1];
  const lhs = P.mod(-xr * xr + y * y, P.P);
  const dRed = P.mod(-P.D_TE * P.invMod(P.A_TE, P.P), P.P);
  if (lhs !== P.mod(1n + ((dRed * xr * xr) % P.P) * y * y, P.P)) throw new Error("reduced chart");
}

// --------------------------------------------------------------------------------------------

function fixedBaseExceptional() {
  // EscalarMulFix(251, Base8): first segment of 249 bits, 83 windows, compensation
  // Q = 2·8^83 + Σ_{j<83} 8^j = 2^250 + (2^249 − 1)/7 (protocol §8.5 gadget rules).
  const Q = (1n << 250n) + ((1n << 249n) - 1n) / 7n;
  const sStar = P.R - Q;
  return {
    Q,
    sStar,
    scalars: [sStar, sStar + (1n << 249n), sStar + 2n * (1n << 249n)],
  };
}

function constantsJson() {
  const ex = fixedBaseExceptional();
  return {
    description: "Council v1 constants (protocol §2); every pinned value of §2 plus circuit constants",
    curve: {
      p: P.P,
      a: P.A_TE,
      d: P.D_TE,
      r: P.R,
      cofactor: P.COFACTOR,
      curveOrder: P.CURVE_ORDER,
      identity: pt(P.O),
      G: pt(P.G),
      G246: pt(P.mulG(1n << 246n)),
      rMinus1G: pt(P.mulG(P.R - 1n)),
    },
    teToReduced: {
      K: P.K_MAP,
      K_INV: P.K_INV,
      KSquaredEqualsMinusA: P.mod(-P.A_TE, P.P),
      reducedG: [P.dec(P.REDUCED_G_X), P.dec(P.G[1])],
    },
    secp256k1n: P.SECP256K1_N,
    qBN: P.Q_BN,
    sizes: {
      MAX_N: P.MAX_N,
      MAX_T: P.MAX_T,
      MAX_FIELDS: P.MAX_FIELDS,
      RESULT_BOUND: P.RESULT_BOUND,
      MAX_COMBINE_FIELDS: P.MAX_COMBINE_FIELDS,
      MAX_INVITES: P.MAX_INVITES,
      MIN_DEALING_DURATION: P.MIN_DEALING_DURATION,
    },
    tags: Object.values(P.TAGS).map((tag) => ({ tag, keccak256: P.tagHash(tag) })),
    MASK_CONST: P.MASK_CONST,
    LIMIT_R: P.LIMIT_R,
    LIMIT_R_multiple: 42,
    LIMIT_SECP256K1N: P.SECP256K1_N,
    derivation: {
      hkdfHash: "SHA-256",
      hkdfSalt: P.HKDF_SALT,
      bip39Passphrase: "",
      derivationVersion: P.DERIVATION_VERSION,
      purposes: Object.values(P.PURPOSES).map((purpose) => ({ purpose, keccak256: P.tagHash(purpose) })),
    },
    eip712: {
      domainType: P.EIP712_DOMAIN_TYPE,
      domainTypeHash: keccak256(toBytes(P.EIP712_DOMAIN_TYPE)),
      name: "DAVINCI DKG Council",
      version: "1",
      encodeTypes: Object.entries(P.ENCODE_TYPES).map(([name, s]) => ({ name, encodeType: s, typeHash: keccak256(toBytes(s)) })),
    },
    poseidon7: {
      inputs: [1n, 2n, 3n, 4n, 5n, 6n, 7n],
      output: P.poseidon7Hash([1n, 2n, 3n, 4n, 5n, 6n, 7n]),
    },
    fixedBaseExceptional: {
      note: "EscalarMulFix(251, Base8) fails witness generation for these canonical scalars; circuits use the 246+5 split",
      compensationQ: ex.Q,
      sStar: ex.sStar,
      scalars: ex.scalars,
      products: ex.scalars.map((s) => pt(P.mulG(s))),
    },
  };
}

// --------------------------------------------------------------------------------------------

function findHashToScalarRejection() {
  const tag = "davinci-dkg-council/v1/test-vector/hash-to-scalar";
  for (let i = 0; ; i++) {
    const fields: P.Field[] = [{ type: "uint256", value: BigInt(i) }];
    const t = P.hashToScalar(tag, fields);
    if (t.counter > 0) return { tag, fields, t };
  }
}

function findDeriveRejection(prk: Uint8Array, ceremonyId: Hex) {
  // share-encryption-bjj with a varying account index until counter 0 is rejected (u >= LIMIT_R)
  for (let accountIndex = 0; ; accountIndex++) {
    const ctx = P.ceremonyContext(S.CHAIN_ID, S.MANAGER, ceremonyId, accountIndex);
    const t = P.deriveScalar(prk, P.R, P.PURPOSES.shareEncryption, ctx, false);
    if (t.counter > 0) return { accountIndex, ctx, t };
  }
}

function derivationJson(scA: S.Scenario) {
  const htsPlain = [0n, 1n, 2n].map((i) => {
    const fields: P.Field[] = [{ type: "uint256", value: i }];
    const t = P.hashToScalar("davinci-dkg-council/v1/test-vector/hash-to-scalar", fields);
    return { tag: "davinci-dkg-council/v1/test-vector/hash-to-scalar", fields: fieldsJson(fields), ...htsTrace(t) };
  });
  const rej = findHashToScalarRejection();
  const seed = P.seedFromMnemonic(S.TEST_MNEMONIC);
  const prk = P.prkFromSeed(seed);
  const dRej = findDeriveRejection(prk, scA.ceremonyId);

  const ctxFields = P.ceremonyContext(S.CHAIN_ID, S.MANAGER, scA.ceremonyId);
  const auth = P.deriveScalar(prk, P.SECP256K1_N, P.PURPOSES.auth, ctxFields, false);
  const share = P.deriveScalar(prk, P.R, P.PURPOSES.shareEncryption, ctxFields, false);
  const org = P.deriveScalar(prk, P.SECP256K1_N, P.PURPOSES.organizerAuth, P.organizerContext(S.CHAIN_ID, S.MANAGER), false);
  const invites = [0, 1, 2].map((inviteId) => {
    const c = P.inviteContext(S.CHAIN_ID, S.MANAGER, scA.ceremonyId, inviteId);
    const k = P.deriveScalar(prk, P.SECP256K1_N, P.PURPOSES.inviteCapability, c, false);
    return { inviteId, context: fieldsJson(c), ...traceJson(k), secret: hex(k.value), address: lower(P.secpAddress(k.value)) };
  });
  // dealer derivations, as if this root were dealer 1 of scenario A's frozen roster
  const frozen: P.DealerFrozen = {
    chainId: S.CHAIN_ID,
    manager: S.MANAGER,
    ceremonyId: scA.ceremonyId,
    accountIndex: 0,
    rosterHash: scA.rosterHash,
    dealerIndex: 1,
    t: scA.spec.t,
    circuitReleaseId: scA.circuitReleaseId,
  };
  const base = P.dealerFrozenContext(frozen);
  const coeffs = Array.from({ length: scA.spec.t }, (_, k) => {
    const c = [...base, { type: "uint8", value: k }];
    return { k, context: fieldsJson(c), ...traceJson(P.deriveScalar(prk, P.R, P.PURPOSES.dealerCoefficient, c, true)) };
  });
  const eph = P.deriveScalar(prk, P.R, P.PURPOSES.dealerEphemeral, base, false);

  return {
    description: "HashToScalar (§3.1) and DeriveScalar (§5.1) vectors, and every §5.2 derivation from the pinned mnemonic",
    hashToScalar: {
      examples: htsPlain,
      rejection: { tag: rej.tag, fields: fieldsJson(rej.fields), ...htsTrace(rej.t) },
    },
    deriveScalar: {
      note: "share-encryption-bjj from the pinned mnemonic with an account index chosen so counter 0 is rejected (u >= LIMIT_R); secp256k1n rejections (prob ~2^-128) cannot be exhibited",
      rejection: {
        purpose: P.PURPOSES.shareEncryption,
        modulus: P.R,
        allowZero: false,
        context: fieldsJson(dRej.ctx),
        ...traceJson(dRej.t),
      },
    },
    pinnedMnemonic: {
      mnemonic: S.TEST_MNEMONIC,
      passphrase: "",
      seed: toHex(seed),
      hkdfSalt: P.HKDF_SALT,
      prk: toHex(prk),
      chainId: S.CHAIN_ID,
      manager: S.MANAGER,
      ceremonyId: scA.ceremonyId,
      accountIndex: 0,
      derivationVersion: P.DERIVATION_VERSION,
      organizerAuth: {
        purpose: P.PURPOSES.organizerAuth,
        context: fieldsJson(P.organizerContext(S.CHAIN_ID, S.MANAGER)),
        ...traceJson(org),
        secret: hex(org.value),
        address: lower(P.secpAddress(org.value)),
      },
      auth: {
        purpose: P.PURPOSES.auth,
        context: fieldsJson(ctxFields),
        ...traceJson(auth),
        secret: hex(auth.value),
        address: lower(P.secpAddress(auth.value)),
      },
      shareEncryption: {
        purpose: P.PURPOSES.shareEncryption,
        context: fieldsJson(ctxFields),
        ...traceJson(share),
        secret: share.value,
        publicKey: pt(P.mulG(share.value)),
      },
      inviteCapability: invites.map((i) => ({ purpose: P.PURPOSES.inviteCapability, ...i })),
      dealer: {
        frozen: { ...frozen },
        dealerCoefficient: coeffs.map((c) => ({ purpose: P.PURPOSES.dealerCoefficient, ...c })),
        dealerEphemeral: { purpose: P.PURPOSES.dealerEphemeral, context: fieldsJson(base), ...traceJson(eph) },
      },
    },
  };
}

function htsTrace(t: P.HashToScalarTrace) {
  return {
    attempts: t.attempts.map((a) => ({ counter: a.counter, u: hex(a.u), accepted: a.accepted })),
    counter: t.counter,
    value: t.value,
  };
}

// --------------------------------------------------------------------------------------------

function scenarioHeader(sc: S.Scenario) {
  return {
    name: sc.spec.name,
    chainId: S.CHAIN_ID,
    manager: S.MANAGER,
    ceremonyId: sc.ceremonyId,
    t: sc.spec.t,
    n: sc.spec.n,
  };
}

function identifiersJson(scs: S.Scenario[]) {
  const other = {
    chainId: 100n,
    manager: "0x00000000000000000000000000000000000c0c1a",
    organizer: scs[0].organizer.address,
    nonce: 0xdeadbeefn,
  };
  return {
    description: "Identifiers (§4): ceremony id, invites, roster hash, circuit release id, deal context, request id",
    circuitRelease: {
      note: "test-only release id: sha256 inputs are sha256(utf8('davinci-dkg-council/v1/test-vector/{deal,partial}-vkey')), not real vkeys",
      dealVkeySha256: S.TEST_DEAL_VKEY_SHA256,
      partialVkeySha256: S.TEST_PARTIAL_VKEY_SHA256,
      circuitReleaseId: S.TEST_CIRCUIT_RELEASE_ID,
    },
    ceremonyIdExamples: [
      ...scs.map((sc) => ({
        chainId: S.CHAIN_ID,
        manager: S.MANAGER,
        organizer: sc.organizer.address,
        nonce: sc.spec.nonce,
        fullHash: P.taggedHash(P.TAGS.ceremony, [
          { type: "uint256", value: S.CHAIN_ID },
          { type: "address", value: S.MANAGER },
          { type: "address", value: sc.organizer.address },
          { type: "uint64", value: sc.spec.nonce },
        ]),
        ceremonyId: sc.ceremonyId,
      })),
      { ...other, ceremonyId: P.ceremonyIdOf(other.chainId, other.manager as Hex, other.organizer, other.nonce) },
    ],
    scenarios: scs.map((sc) => ({
      ...scenarioHeader(sc),
      organizer: {
        mnemonic: S.TEST_MNEMONIC,
        secret: hex(sc.organizer.key.value),
        address: sc.organizer.address,
      },
      nonce: sc.spec.nonce,
      registrationDeadline: S.REGISTRATION_DEADLINE,
      dealingDuration: S.DEALING_DURATION,
      invites: sc.invites.map((i) => ({
        inviteId: i.inviteId,
        secret: hex(i.key.value),
        address: i.address,
        linkFragment: `v1.${i.inviteId}.${hex(i.key.value).slice(2)}`,
        initial: i.inviteId < sc.spec.initialInvites,
      })),
      members: sc.members.map((m) => ({
        index: m.index,
        inviteId: m.inviteId,
        mnemonic: m.mnemonic,
        prk: toHex(m.prk),
        authSecret: hex(m.auth.value),
        authAddress: m.authAddress,
        shareSecret: m.share.value,
        X: pt(m.X),
        XReducedX: P.toReducedX(m.X[0]),
        pop: {
          note: "test-only deterministic nonce; production nonces come from the CSPRNG",
          k: m.popNonce,
          A: pt(m.pop.A),
          AReducedX: P.toReducedX(m.pop.A[0]),
          c: m.pop.c,
          cCounter: m.pop.cTrace.counter,
          z: m.pop.z,
        },
      })),
      rosterHash: sc.rosterHash,
      circuitReleaseId: sc.circuitReleaseId,
      ctx: sc.ctx,
      ctxHi: P.limbs(sc.ctx).hi,
      ctxLo: P.limbs(sc.ctx).lo,
      request: {
        adapter: S.ADAPTER,
        creator: S.CREATOR,
        processId: sc.processId,
        requestId: sc.requestId,
      },
    })),
  };
}

// --------------------------------------------------------------------------------------------

async function eip712Json(sc: S.Scenario) {
  const org = sc.organizer.key.value;
  const m1 = sc.members[0];
  const d1 = sc.dealings[0].dealing;
  const dealPayload = P.dealPayloadHash(sc.ctx, d1.C, d1.E, d1.masked, S.PLACEHOLDER_PROOF);
  const D1 = P.partialWitnessInput(sc.memberKeys[0], sc.shares[0], sc.cts.map((c) => c.C1)).D.map(
    (d) => [BigInt(d[0]), BigInt(d[1])] as P.Point,
  );
  const partialPayload = P.partialPayloadHash(sc.requestId, D1, S.PLACEHOLDER_PROOF);
  const actions: [P.StructName, Record<string, unknown>, bigint][] = [
    [
      "CreateCeremony",
      {
        organizer: sc.organizer.address,
        nonce: sc.spec.nonce,
        threshold: sc.spec.t,
        registrationDeadline: S.REGISTRATION_DEADLINE,
        dealingDuration: S.DEALING_DURATION,
        inviteKeys: sc.invites.slice(0, sc.spec.initialInvites).map((i) => i.address),
        validUntil: S.VALID_UNTIL,
      },
      org,
    ],
    [
      "AddInvites",
      {
        ceremonyId: sc.ceremonyId,
        firstInviteId: sc.spec.initialInvites,
        inviteKeys: sc.invites.slice(sc.spec.initialInvites).map((i) => i.address),
        validUntil: S.VALID_UNTIL,
      },
      org,
    ],
    [
      "Invite",
      {
        ceremonyId: sc.ceremonyId,
        inviteId: m1.inviteId,
        participant: m1.authAddress,
        pkX: m1.X[0],
        pkY: m1.X[1],
        validUntil: S.VALID_UNTIL,
      },
      sc.invites[m1.inviteId].key.value,
    ],
    [
      "Join",
      {
        ceremonyId: sc.ceremonyId,
        participant: m1.authAddress,
        inviteId: m1.inviteId,
        pkX: m1.X[0],
        pkY: m1.X[1],
        popAx: m1.pop.A[0],
        popAy: m1.pop.A[1],
        popZ: m1.pop.z,
        validUntil: S.VALID_UNTIL,
      },
      m1.auth.value,
    ],
    ["CloseRegistration", { ceremonyId: sc.ceremonyId, participantCount: sc.spec.n, validUntil: S.VALID_UNTIL }, org],
    ["AllowAdapter", { ceremonyId: sc.ceremonyId, adapter: S.ADAPTER, validUntil: S.VALID_UNTIL }, org],
    ["AuthorizeCreator", { ceremonyId: sc.ceremonyId, creator: S.CREATOR, validUntil: S.VALID_UNTIL }, org],
    [
      "Deal",
      { ceremonyId: sc.ceremonyId, dealerIndex: d1.dealerIndex, payloadHash: dealPayload, validUntil: S.VALID_UNTIL },
      sc.members[d1.dealerIndex - 1].auth.value,
    ],
    [
      "Partial",
      {
        ceremonyId: sc.ceremonyId,
        requestId: sc.requestId,
        participantIndex: 1,
        payloadHash: partialPayload,
        validUntil: S.VALID_UNTIL,
      },
      m1.auth.value,
    ],
  ];
  const out = [];
  for (const [name, message, key] of actions) {
    const s = await P.signAction(S.CHAIN_ID, S.MANAGER, name, message, key);
    out.push({
      struct: name,
      encodeType: P.ENCODE_TYPES[name],
      typeHash: s.typeHash,
      message,
      structHash: s.structHash,
      digest: s.digest,
      signer: lower(s.signer),
      signature: s.signature,
    });
  }
  return {
    description:
      "EIP-712 (§7): domain separator and one digest + deterministic (RFC 6979, low-s) signature per §7.2 struct, scenario A. Deal/Partial payload hashes use the placeholder proof words of dealing.json/combine.json",
    domain: { ...P.domainOf(S.CHAIN_ID, S.MANAGER), domainSeparator: P.domainSeparator(S.CHAIN_ID, S.MANAGER) },
    actions: out,
  };
}

// --------------------------------------------------------------------------------------------

function dealingJson(scs: S.Scenario[]) {
  return {
    description:
      "Complete honest dealings (§8.3, §8.5): derivation, coefficients, shares, ECDH points, masks, masked shares, payload hash (placeholder proof words), circuit witness input with the pinned keys, and the 87-word public input vector",
    placeholderProof: S.PLACEHOLDER_PROOF,
    scenarios: scs.map((sc) => ({
      ...scenarioHeader(sc),
      rosterHash: sc.rosterHash,
      circuitReleaseId: sc.circuitReleaseId,
      ctx: sc.ctx,
      roster: P.paddedRoster(sc.members.map((m) => m.X)).map(pt),
      qual: sc.spec.qual,
      dealings: sc.dealings.map(({ frozen, coeffs, eph, dealing: d }) => {
        const witnessInput = P.dealWitnessInput(
          sc.ctx,
          d,
          sc.members.map((m) => m.X),
        );
        return {
          dealerIndex: d.dealerIndex,
          frozenContext: fieldsJson(P.dealerFrozenContext(frozen)),
          coefficientCounters: coeffs.map((c) => c.counter),
          ephemeralCounter: eph.counter,
          a: d.a,
          e: d.e,
          C: d.C.map(pt),
          E: pt(d.E),
          shares: d.s,
          S: d.S.map(pt),
          masks: d.h,
          masked: d.masked,
          payloadHash: P.dealPayloadHash(sc.ctx, d.C, d.E, d.masked, S.PLACEHOLDER_PROOF),
          witnessInput,
          publicInputs: P.dealPublicInputs(witnessInput),
        };
      }),
    })),
  };
}

function recoveryJson(scs: S.Scenario[]) {
  return {
    description: "Share recovery (§8.6) and finalization (§8.4) for the dealing.json ceremonies",
    scenarios: scs.map((sc) => ({
      ...scenarioHeader(sc),
      ctx: sc.ctx,
      qual: sc.spec.qual,
      qualBitmap: sc.spec.qual.reduce((b, j) => b | (1 << (j - 1)), 0),
      aggregates: sc.aggregates.map(pt),
      publicKey: pt(sc.publicKey),
      members: sc.members.map((m) => ({
        index: m.index,
        shareSecret: m.share.value,
        perDealer: sc.dealings.map(({ dealing: d }) => {
          const r = P.recoverShare(sc.ctx, d, m.index, m.share.value);
          return { dealerIndex: d.dealerIndex, S: pt(r.S), mask: r.h, masked: d.masked[m.index - 1], share: r.s };
        }),
        share: sc.shares[m.index - 1],
        PK: pt(sc.memberKeys[m.index - 1]),
      })),
    })),
  };
}

function subsetsFor(sc: S.Scenario): number[][] {
  if (sc.spec.n === 3) return [[1, 2], [1, 3], [2, 3]];
  return [Array.from({ length: 16 }, (_, i) => i + 1)];
}

function combineJson(scs: S.Scenario[]) {
  return {
    description:
      "Requests, partial decryptions (§10.1) with the circuit witness input and the 67-word public input vector, Lagrange coefficients and combine equations (§10.3). Encryption randomness is test-only (HashToScalar over a test tag)",
    placeholderProof: S.PLACEHOLDER_PROOF,
    scenarios: scs.map((sc) => {
      const C1 = sc.cts.map((c) => c.C1);
      const partials = sc.members.map((m) => {
        const w = P.partialWitnessInput(sc.memberKeys[m.index - 1], sc.shares[m.index - 1], C1);
        const D = w.D.map((d) => [BigInt(d[0]), BigInt(d[1])] as P.Point);
        return {
          index: m.index,
          D: w.D,
          payloadHash: P.partialPayloadHash(sc.requestId, D, S.PLACEHOLDER_PROOF),
          witnessInput: w,
          publicInputs: P.partialPublicInputs(w),
        };
      });
      const combines = subsetsFor(sc).map((set) => {
        const lambdas = P.lagrange(set);
        const fields = sc.cts.map((ct, k) => {
          let sum: P.Point = P.O;
          set.forEach((i, idx) => {
            const D = partials[i - 1].D[k];
            sum = P.pointAdd(sum, P.mul([BigInt(D[0]), BigInt(D[1])], lambdas[idx]));
          });
          const M = P.pointAdd(ct.C2, P.pointNeg(sum));
          const m = sc.spec.plaintexts[k];
          if (!P.eqPoint(M, P.mulG(m))) throw new Error("combine check failed");
          return { field: k, sumLambdaD: pt(sum), M: pt(M), plaintext: m, plaintextG: pt(P.mulG(m)) };
        });
        return { memberSet: set, lambdas, fields };
      });
      return {
        ...scenarioHeader(sc),
        request: {
          adapter: S.ADAPTER,
          processId: sc.processId,
          requestId: sc.requestId,
          fieldCount: sc.cts.length,
          plaintexts: sc.spec.plaintexts,
          randomness: sc.rho,
          cts: sc.cts.map((c) => [P.dec(c.C1[0]), P.dec(c.C1[1]), P.dec(c.C2[0]), P.dec(c.C2[1])]),
        },
        publicKey: pt(sc.publicKey),
        partials,
        combines,
      };
    }),
  };
}

async function main() {
  checkConstants();
  mkdirSync(OUT, { recursive: true });
  const scs = S.SPECS.map(S.buildScenario);
  write("constants.json", constantsJson());
  write("derivation.json", derivationJson(scs[0]));
  write("identifiers.json", identifiersJson(scs));
  write("eip712.json", await eip712Json(scs[0]));
  write("dealing.json", dealingJson(scs));
  write("recovery.json", recoveryJson(scs));
  write("combine.json", combineJson(scs));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
