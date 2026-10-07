// Generates tests/vectors/*.json (protocol §12). Standalone: depends only on the
// reference encodings in src/ (viem, noble, scure, poseidon-lite, zk-kit), never on the SDK.
// Deterministic: running it twice produces byte-identical files.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import * as P from "../src/protocol.ts";
import * as S from "../src/scenario.ts";
import * as Sch from "../src/schedule.ts";

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
    description: "Council protocol v2 constants (protocol §2); every pinned value of §2 plus circuit constants",
    protocolVersion: P.PROTOCOL_VERSION,
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
      MAX_DEALING_DURATION: P.MAX_DEALING_DURATION,
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
      version: P.EIP712_VERSION,
      encodeTypes: Object.entries(P.ENCODE_TYPES).map(([name, s]) => ({ name, encodeType: s, typeHash: keccak256(toBytes(s)) })),
    },
    phaseModes: { ...P.PHASE_MODES },
    compressed: {
      rule: "compressed(x, y) = x | ((y & 1) << 255); bit 254 reserved zero (protocol §2.5)",
      G: P.compressHex(P.G),
      minusG: P.compressHex(P.pointNeg(P.G)),
      identity: P.compressHex(P.O),
      orderTwo: P.compressHex([0n, P.P - 1n]),
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
      registrationMode: sc.spec.policy.registrationMode,
      registrationDeadline: sc.spec.policy.registrationDeadline,
      dealingDuration: sc.spec.policy.dealingDuration,
      decryptionMode: sc.spec.policy.decryptionMode,
      decryptionOpenAt: sc.spec.policy.decryptionOpenAt,
      manualDecryptionFallbackAt: sc.spec.policy.manualDecryptionFallbackAt,
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
        XCompressed: P.compressHex(m.X),
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
        registrationMode: sc.spec.policy.registrationMode,
        registrationDeadline: sc.spec.policy.registrationDeadline,
        dealingDuration: sc.spec.policy.dealingDuration,
        decryptionMode: sc.spec.policy.decryptionMode,
        decryptionOpenAt: sc.spec.policy.decryptionOpenAt,
        manualDecryptionFallbackAt: sc.spec.policy.manualDecryptionFallbackAt,
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
    ["OpenDecryption", { ceremonyId: sc.ceremonyId, validUntil: S.VALID_UNTIL }, org],
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
      "EIP-712 (§7), domain version \"2\": domain separator and one digest + deterministic (RFC 6979, low-s) signature per §7.2 struct, scenario A (its v2 phase policy in CreateCeremony). Deal/Partial payload hashes use the placeholder proof words of dealing.json/combine.json",
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
    description:
      "Share recovery (§8.6, v2: ephemeral E_j + masked shares + the aggregate check s·G == Horner(A, m), no per-dealer commitments) and finalization (§8.4) for the dealing.json ceremonies; compressed words per §2.5, aggregates also in their biased (x+1, y+1) storage encoding (§8.3)",
    scenarios: scs.map((sc) => ({
      ...scenarioHeader(sc),
      ctx: sc.ctx,
      qual: sc.spec.qual,
      qualBitmap: sc.spec.qual.reduce((b, j) => b | (1 << (j - 1)), 0),
      aggregates: sc.aggregates.map(pt),
      aggregatesBiased: sc.aggregates.map((a) => [P.dec(a[0] + 1n), P.dec(a[1] + 1n)]),
      publicKey: pt(sc.publicKey),
      dealers: sc.dealings.map(({ dealing: d }) => ({
        dealerIndex: d.dealerIndex,
        E: pt(d.E),
        compressedE: P.compressHex(d.E),
      })),
      members: sc.members.map((m) => ({
        index: m.index,
        compressedX: P.compressHex(m.X),
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
      "Requests, partial decryptions (§10.1) with the circuit witness input, the 67-word public input vector and the v2 durable partialDataHash (§10.2), Lagrange coefficients and combine equations (§10.3). Encryption randomness is test-only (HashToScalar over a test tag)",
    placeholderProof: S.PLACEHOLDER_PROOF,
    scenarios: scs.map((sc) => {
      const C1 = sc.cts.map((c) => c.C1);
      const partials = sc.members.map((m) => {
        const w = P.partialWitnessInput(sc.memberKeys[m.index - 1], sc.shares[m.index - 1], C1);
        const D = w.D.map((d) => [BigInt(d[0]), BigInt(d[1])] as P.Point);
        return {
          index: m.index,
          D: w.D,
          partialDataHash: P.partialDataHash(S.CHAIN_ID, S.MANAGER, sc.ceremonyId, sc.requestId, m.index, C1.length, D),
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
          compressedCts: sc.cts.map((c) => [P.compressHex(c.C1), P.compressHex(c.C2)]),
        },
        publicKey: pt(sc.publicKey),
        partials,
        combines,
      };
    }),
  };
}


// --------------------------------------------------------------------------------------------
// §2.5 compressed points
// --------------------------------------------------------------------------------------------

const T8: P.Point = [
  17545522957889784193459637215142187266023652151580582754000402781682644312291n,
  17061719626832259898845741003733890968968767993363194771977168648564009544074n,
];

function codecJson() {
  if (P.twoAdicity() !== 28) throw new Error("v2(p-1)");
  if (!P.onCurve(T8) || P.eqPoint(P.mul(T8, 4n), P.O) || !P.eqPoint(P.mul(T8, 8n), P.O)) throw new Error("T8 order");
  const firstWithParity = (parity: bigint): { k: bigint; p: P.Point } => {
    for (let k = 2n; ; k++) {
      const q = P.mulG(k);
      if ((q[1] & 1n) === parity) return { k, p: q };
    }
  };
  const even = firstWithParity(0n);
  const odd = firstWithParity(1n);
  // y² = 0 exactly at a·x² = 1: the two order-4 points (±x4, 0). Their only root is y = 0, so an
  // odd parity bit would name y = p — not canonical, and a strict decoder must refuse it.
  const x4 = P.sqrtModP(P.invMod(P.A_TE, P.P));
  if (x4 === null || !P.onCurve([x4, 0n]) || !P.onCurve([P.P - x4, 0n])) throw new Error("order-4 x");
  const named: [string, P.Point][] = [
    ["G", P.G],
    ["minusG", P.pointNeg(P.G)],
    ["identity", P.O],
    ["orderTwo", [0n, P.P - 1n]],
    ["torsion8", T8],
    ["torsionShiftedG", P.pointAdd(P.G, T8)],
    ["orderFour", [x4, 0n]],
    ["orderFourNeg", [P.P - x4, 0n]],
    [`yParityEven(${even.k}G)`, even.p],
    [`yParityOdd(${odd.k}G)`, odd.p],
    ...[0, 1, 2, 3].map(
      (i) =>
        [
          `random${i}`,
          P.mulG(P.hashToScalar("davinci-dkg-council/v2/test-vector/codec", [{ type: "uint8", value: i }]).value),
        ] as [string, P.Point],
    ),
  ];
  const points = named.map(([name, q]) => {
    const w = P.compress(q);
    const back = P.decompress(w);
    if (!P.eqPoint(back, q)) throw new Error(`codec round trip ${name}`);
    return {
      name,
      point: pt(q),
      compressed: hex(w),
      onCurve: P.onCurve(q),
      inPrimeSubgroup: P.inPrimeSubgroup(q),
      identity: P.eqPoint(q, P.O),
    };
  });
  // pinned table of protocol §2.5
  const pinned: Record<string, string> = {
    G: "0x8bb77a6ad63e739b4eacb2e09d6277c12ab8d8010534e0b62893f3f6bb957051",
    minusG: "0xa4acd4080af32c8e69a392d5e41ee09bfd7b104774848fdb1b4e019d346a8fb0",
    identity: "0x8000000000000000000000000000000000000000000000000000000000000000",
    orderTwo: "0x0000000000000000000000000000000000000000000000000000000000000000",
  };
  for (const [name, w] of Object.entries(pinned)) {
    if (points.find((q) => q.name === name)!.compressed !== w) throw new Error(`pinned compressed ${name}`);
  }

  const nonResidueX = (() => {
    for (let x = 1n; ; x++) {
      const r = P.decompressChecked(x);
      if ("rejected" in r && r.rejected === "nonResidue") return x;
    }
  })();
  const g = P.compress(P.G);
  const gParity = P.G[1] & 1n;
  const rejections: [string, bigint, P.DecodeRejection][] = [
    ["bit254SetOnG", g | (1n << 254n), "bit254"],
    ["allOnes", (1n << 256n) - 1n, "bit254"],
    ["xEqualsPParity0", P.P, "xNotCanonical"],
    ["xEqualsPParity1", P.P | (1n << 255n), "xNotCanonical"],
    ["xPlusPAliasOfG", (P.G[0] + P.P) | (gParity << 255n), "xNotCanonical"],
    ["xMaxBelowBit254", (1n << 254n) - 1n, "xNotCanonical"],
    ["nonResidue", nonResidueX, "nonResidue"],
    ["nonResidueOddParity", nonResidueX | (1n << 255n), "nonResidue"],
    ["orderFourOddParity", x4 | (1n << 255n), "zeroRootOddParity"],
    ["orderFourNegOddParity", (P.P - x4) | (1n << 255n), "zeroRootOddParity"],
  ];
  const decodeRejections = rejections.map(([name, word, reason]) => {
    const r = P.decompressChecked(word);
    if (!("rejected" in r) || r.rejected !== reason) throw new Error(`decode rejection ${name}`);
    return { name, word: hex(word), reason };
  });

  const two = P.mulG(2n);
  const zero = 0n;
  const idWord = P.compress(P.O);
  const auth: [string, bigint, readonly [bigint, bigint], P.AuthResult][] = [
    ["valid", g, P.G, "ok"],
    ["sameCompressedOffCurve", g, [P.G[0], P.G[1] + 2n], "InvalidPoint"],
    ["xAlias", g, [P.G[0] + P.P, P.G[1]], "NonCanonical"],
    ["yAlias", g, [P.G[0], P.G[1] + P.P], "NonCanonical"],
    ["negated", g, P.pointNeg(P.G), "CompressedPointMismatch"],
    ["otherPoint", g, two, "CompressedPointMismatch"],
    ["torsionShifted", g, P.pointAdd(P.G, T8), "CompressedPointMismatch"],
    ["torsionShiftedValid", P.compress(P.pointAdd(P.G, T8)), P.pointAdd(P.G, T8), "ok"],
    ["identityValid", idWord, P.O, "ok"],
    ["orderTwoValid", zero, [0n, P.P - 1n], "ok"],
    ["identityVsZeroWord", zero, P.O, "CompressedPointMismatch"],
    ["orderTwoVsIdentityWord", idWord, [0n, P.P - 1n], "CompressedPointMismatch"],
    ["zeroZeroOffCurve", zero, [0n, 0n], "InvalidPoint"],
    ["storedBit254Set", g | (1n << 254n), P.G, "CompressedPointMismatch"],
  ];
  const authentication = auth.map(([name, stored, supplied, expect]) => {
    if (P.authenticate(stored, supplied) !== expect) throw new Error(`authentication ${name}`);
    return { name, stored: hex(stored), supplied: [P.dec(supplied[0]), P.dec(supplied[1])], expect };
  });

  return {
    description:
      "Compressed point encoding (§2.5): encodings, client-side strict decode rejections and the contract's square-root-free authentication of a supplied full point against a stored word (order: (1) x < p and y < p else NonCanonical, (2) TE on curve else InvalidPoint, (3) exact compressed equality else CompressedPointMismatch). The codec validates encodings only: subgroup and non-identity policy belong to the caller",
    rule: "compressed(x, y) = x | ((y & 1) << 255); bit 254 reserved zero",
    v2OfPMinus1: P.twoAdicity(),
    points,
    decodeRejections,
    authentication,
  };
}

// --------------------------------------------------------------------------------------------
// §10.2 partial-data commitment
// --------------------------------------------------------------------------------------------

type PdPreimage = {
  chainId: bigint;
  manager: `0x${string}`;
  ceremonyId: `0x${string}`;
  requestId: `0x${string}`;
  participantIndex: number;
  fieldCount: number;
  D: P.Point[];
};

const pdHash = (x: PdPreimage) =>
  P.partialDataHash(x.chainId, x.manager, x.ceremonyId, x.requestId, x.participantIndex, x.fieldCount, x.D);

const pdJson = (x: PdPreimage) => ({
  chainId: x.chainId,
  manager: x.manager,
  ceremonyId: x.ceremonyId,
  requestId: x.requestId,
  participantIndex: x.participantIndex,
  fieldCount: x.fieldCount,
  D: x.D.map(pt),
  partialDataHash: pdHash(x),
});

function paddedD(sc: S.Scenario, index: number): P.Point[] {
  const w = P.partialWitnessInput(sc.memberKeys[index - 1], sc.shares[index - 1], sc.cts.map((c) => c.C1));
  return w.D.map((d) => [BigInt(d[0]), BigInt(d[1])] as P.Point);
}

function partialDataJson(scs: S.Scenario[]) {
  const [A, B] = scs;
  const base: PdPreimage = {
    chainId: S.CHAIN_ID,
    manager: S.MANAGER,
    ceremonyId: A.ceremonyId,
    requestId: A.requestId,
    participantIndex: 1,
    fieldCount: A.cts.length,
    D: paddedD(A, 1),
  };
  const f = base.fieldCount;
  const withD = (edit: (D: P.Point[]) => void): PdPreimage => {
    const D = [...base.D];
    edit(D);
    return { ...base, D };
  };
  const other = P.mulG(P.hashToScalar("davinci-dkg-council/v2/test-vector/partial-data", [{ type: "uint8", value: 0 }]).value);
  const mutations: [string, PdPreimage][] = [
    ["chainId", { ...base, chainId: 100n }],
    ["manager", { ...base, manager: "0x00000000000000000000000000000000000c0c1a" }],
    ["ceremonyId", { ...base, ceremonyId: B.ceremonyId }],
    ["requestId", { ...base, requestId: B.requestId }],
    ["participantIndex", { ...base, participantIndex: 2 }],
    ["fieldCount", { ...base, fieldCount: f - 1 }],
    ["dPointChanged", withD((D) => (D[0] = other))],
    ["dPermuted", withD((D) => ([D[0], D[1]] = [D[1], D[0]]))],
    ["dTruncatedSlice", withD((D) => (D[f - 1] = P.O))],
    ["dPaddedSlice", withD((D) => (D[f] = P.G))],
    ["otherMembersVector", { ...base, D: paddedD(A, 2) }],
  ];
  const baseHash = pdHash(base);
  const seen = new Set<string>([baseHash]);
  for (const [name, m] of mutations) {
    const h = pdHash(m);
    if (seen.has(h)) throw new Error(`partial-data mutation ${name} does not change the hash`);
    seen.add(h);
  }
  return {
    description:
      "Durable partial-data commitment (§10.2): partialDataHash = K('davinci-dkg-council/v2/partial-data', uint256 chainId, address manager, bytes12 ceremonyId, bytes32 requestId, uint8 participantIndex, uint8 fieldCount, uint256[2][16] D) over the identity-padded D vector; one mutation of every bound preimage field, and every member's hash for the combine.json scenarios",
    tag: P.TAGS.partialData,
    tagHash: P.tagHash(P.TAGS.partialData),
    preimageTypes: ["bytes32", "uint256", "address", "bytes12", "bytes32", "uint8", "uint8", "uint256[2][16]"],
    base: pdJson(base),
    mutations: mutations.map(([name, m]) => ({ name, ...pdJson(m) })),
    scenarios: scs.map((sc) => ({
      name: sc.spec.name,
      chainId: S.CHAIN_ID,
      manager: S.MANAGER,
      ceremonyId: sc.ceremonyId,
      requestId: sc.requestId,
      fieldCount: sc.cts.length,
      partials: sc.members.map((m) => {
        const D = paddedD(sc, m.index);
        return {
          index: m.index,
          D: D.map(pt),
          partialDataHash: P.partialDataHash(S.CHAIN_ID, S.MANAGER, sc.ceremonyId, sc.requestId, m.index, sc.cts.length, D),
        };
      }),
    })),
  };
}

// --------------------------------------------------------------------------------------------
// §8.1 / §8.3 / §8.4 / §8.7 phase policies
// --------------------------------------------------------------------------------------------

function scheduleJson() {
  const { Manual: M, Scheduled: SC } = P.PHASE_MODES;
  const NOW = 1850000000n;
  const R = 1900000000n;
  const D = 86400n;
  const END = R + D;
  const U = Sch.U64_MAX;
  const base: Sch.Policy = {
    registrationMode: M,
    registrationDeadline: 0n,
    dealingDuration: D,
    decryptionMode: M,
    decryptionOpenAt: 0n,
    manualDecryptionFallbackAt: 0n,
  };
  const createSpecs: [string, Partial<Sch.Policy>, bigint?][] = [
    // the four mode combinations
    ["manualManualNoExpiryNoFallback", {}],
    ["manualManualExpiryFallback", { registrationDeadline: R, manualDecryptionFallbackAt: 1901000000n }],
    ["scheduledScheduled", { registrationMode: SC, registrationDeadline: R, decryptionMode: SC, decryptionOpenAt: 1900100000n }],
    ["manualScheduled", { decryptionMode: SC, decryptionOpenAt: 1900100000n }],
    ["scheduledManualNoFallback", { registrationMode: SC, registrationDeadline: R }],
    ["scheduledManualFallback", { registrationMode: SC, registrationDeadline: R, manualDecryptionFallbackAt: 1901000000n }],
    // mode bytes
    ["registrationModeByte2", { registrationMode: 2 }],
    ["registrationModeByte2WithDeadline", { registrationMode: 2, registrationDeadline: R }],
    ["decryptionModeByte2", { decryptionMode: 2 }],
    ["decryptionModeByte2WithOpenAt", { decryptionMode: 2, decryptionOpenAt: 1900100000n }],
    ["decryptionModeByte255", { decryptionMode: 255 }],
    // dealing duration (BadDuration precedes every BadSchedule rule)
    ["dealingDuration599", { dealingDuration: 599n }],
    ["dealingDuration600", { dealingDuration: 600n }],
    ["dealingDuration599BeatsBadSchedule", { dealingDuration: 599n, registrationMode: 2 }],
    ["dealingDuration365Days", { dealingDuration: 31_536_000n }],
    ["dealingDuration365DaysPlus1", { dealingDuration: 31_536_001n }],
    ["dealingDuration365DaysPlus1BeatsBadSchedule", { dealingDuration: 31_536_001n, registrationMode: 2 }],
    // Scheduled registration deadline
    ["scheduledDeadlineNowMinus1", { registrationMode: SC, registrationDeadline: NOW - 1n }],
    ["scheduledDeadlineNow", { registrationMode: SC, registrationDeadline: NOW }],
    ["scheduledDeadlineNowPlus1", { registrationMode: SC, registrationDeadline: NOW + 1n }],
    ["scheduledDeadlineZero", { registrationMode: SC, registrationDeadline: 0n }],
    // Manual registration expiry
    ["manualExpiryNowMinus1", { registrationDeadline: NOW - 1n }],
    ["manualExpiryNow", { registrationDeadline: NOW }],
    ["manualExpiryNowPlus1", { registrationDeadline: NOW + 1n }],
    ["manualNoExpiryMaxDuration", { dealingDuration: U }],
    // uint64 overflow of deadline + duration
    ["scheduledSumOverflows", { registrationMode: SC, registrationDeadline: U - 599n, dealingDuration: 600n }],
    ["scheduledSumFits", { registrationMode: SC, registrationDeadline: U - 600n, dealingDuration: 600n }],
    ["manualExpirySumOverflows", { registrationDeadline: U - 599n, dealingDuration: 600n }],
    ["manualExpirySumFits", { registrationDeadline: U - 600n, dealingDuration: 600n }],
    // Scheduled decryption
    ["scheduledOpenAtNowMinus1", { decryptionMode: SC, decryptionOpenAt: NOW - 1n }],
    ["scheduledOpenAtNow", { decryptionMode: SC, decryptionOpenAt: NOW }],
    ["scheduledOpenAtNowPlus1", { decryptionMode: SC, decryptionOpenAt: NOW + 1n }],
    ["scheduledOpenAtZero", { decryptionMode: SC, decryptionOpenAt: 0n }],
    ["scheduledWithFallback", { decryptionMode: SC, decryptionOpenAt: 1900100000n, manualDecryptionFallbackAt: 1901000000n }],
    // Manual decryption
    ["manualWithOpenAt", { decryptionOpenAt: 1900100000n }],
    ["manualFallbackNowMinus1", { manualDecryptionFallbackAt: NOW - 1n }],
    ["manualFallbackNow", { manualDecryptionFallbackAt: NOW }],
    ["manualFallbackNowPlus1", { manualDecryptionFallbackAt: NOW + 1n }],
    // the Scheduled-registration cross rule
    ["crossOpenAtEndMinus1", { registrationMode: SC, registrationDeadline: R, decryptionMode: SC, decryptionOpenAt: END - 1n }],
    ["crossOpenAtEnd", { registrationMode: SC, registrationDeadline: R, decryptionMode: SC, decryptionOpenAt: END }],
    ["crossOpenAtEndPlus1", { registrationMode: SC, registrationDeadline: R, decryptionMode: SC, decryptionOpenAt: END + 1n }],
    ["crossFallbackEndMinus1", { registrationMode: SC, registrationDeadline: R, manualDecryptionFallbackAt: END - 1n }],
    ["crossFallbackEnd", { registrationMode: SC, registrationDeadline: R, manualDecryptionFallbackAt: END }],
    ["crossFallbackEndPlus1", { registrationMode: SC, registrationDeadline: R, manualDecryptionFallbackAt: END + 1n }],
    // the cross rule does not apply to Manual registration (with or without expiry)
    ["manualExpiryOpenAtBeforeEnd", { registrationDeadline: R, decryptionMode: SC, decryptionOpenAt: END }],
    ["manualExpiryOpenAtBeforeDeadline", { registrationDeadline: R, decryptionMode: SC, decryptionOpenAt: R - 1n }],
    ["manualExpiryFallbackAtEnd", { registrationDeadline: R, manualDecryptionFallbackAt: END }],
  ];
  const expected: Record<string, Sch.CreateResult> = {};
  const create = createSpecs.map(([name, over, now = NOW]) => {
    const p = { ...base, ...over };
    const expect = Sch.validateCreate(p, now);
    expected[name] = expect;
    return { name, now, threshold: 2, ...p, expect };
  });
  // spot checks of the reference implementation against the spec text
  const want: Record<string, Sch.CreateResult> = {
    manualManualNoExpiryNoFallback: "ok",
    scheduledScheduled: "ok",
    registrationModeByte2: "BadSchedule",
    dealingDuration599: "BadDuration",
    dealingDuration599BeatsBadSchedule: "BadDuration",
    scheduledDeadlineNow: "BadSchedule",
    scheduledDeadlineNowPlus1: "ok",
    scheduledDeadlineZero: "BadSchedule",
    manualExpiryNow: "BadSchedule",
    manualNoExpiryMaxDuration: "BadDuration",
    dealingDuration365Days: "ok",
    dealingDuration365DaysPlus1: "BadDuration",
    dealingDuration365DaysPlus1BeatsBadSchedule: "BadDuration",
    scheduledSumOverflows: "BadSchedule",
    scheduledSumFits: "ok",
    manualExpirySumOverflows: "BadSchedule",
    manualExpirySumFits: "ok",
    scheduledOpenAtNow: "BadSchedule",
    scheduledOpenAtNowPlus1: "ok",
    scheduledWithFallback: "BadSchedule",
    manualWithOpenAt: "BadSchedule",
    manualFallbackNow: "BadSchedule",
    manualFallbackNowPlus1: "ok",
    crossOpenAtEnd: "BadSchedule",
    crossOpenAtEndPlus1: "ok",
    crossFallbackEnd: "BadSchedule",
    crossFallbackEndPlus1: "ok",
    manualExpiryOpenAtBeforeEnd: "ok",
    manualExpiryOpenAtBeforeDeadline: "ok",
    manualExpiryFallbackAtEnd: "ok",
  };
  for (const [k, v] of Object.entries(want)) if (expected[k] !== v) throw new Error(`schedule create ${k}: ${expected[k]} != ${v}`);

  const registration: unknown[] = [];
  const regCase = (name: string, st: Sch.RegistrationState, now: bigint) => {
    const close = Sch.closeRegistrationResult(st, now);
    const sched = Sch.closeRegistrationScheduledResult(st, now);
    const abort = Sch.abortRegistrationResult(st, now);
    if (abort === "ok" && (close.result === "ok" || sched.result === "ok")) throw new Error(`close and abort both valid: ${name}`);
    registration.push({
      name,
      registrationMode: st.registrationMode,
      registrationDeadline: st.registrationDeadline,
      dealingDuration: st.dealingDuration,
      threshold: st.threshold,
      joined: st.joined,
      now,
      expect: {
        join: Sch.joinResult(st, now),
        closeRegistration: close.result,
        closeRegistrationScheduled: sched.result,
        abort,
        scheduledRegistrationCloseDue: sched.result === "ok",
        dealingDeadline: { closeRegistration: close.dealingDeadline, closeRegistrationScheduled: sched.dealingDeadline },
      },
    });
  };
  const instants: [string, bigint][] = [
    ["deadlineMinus1", R - 1n],
    ["deadline", R],
    ["deadlinePlus1", R + 1n],
    ["endMinus1", END - 1n],
    ["end", END],
    ["endPlus1", END + 1n],
  ];
  for (const [mname, mode] of [
    ["scheduled", SC],
    ["manualExpiry", M],
  ] as const) {
    for (const joined of [1, 2, 3]) {
      for (const [iname, now] of instants) {
        regCase(`${mname}_joined${joined}_${iname}`, { registrationMode: mode, registrationDeadline: R, dealingDuration: D, threshold: 2, joined }, now);
      }
    }
  }
  for (const joined of [1, 2]) {
    for (const [iname, now] of [
      ["early", NOW + 100n],
      ["atR", R],
      ["afterEnd", END + 1n],
    ] as [string, bigint][]) {
      regCase(`manualNoExpiry_joined${joined}_${iname}`, { registrationMode: M, registrationDeadline: 0n, dealingDuration: D, threshold: 2, joined }, now);
    }
  }

  const DL = END;
  const dealing: unknown[] = [];
  for (const dealt of [1, 2, 3]) {
    for (const [iname, now] of [
      ["deadlineMinus1", DL - 1n],
      ["deadline", DL],
      ["deadlinePlus1", DL + 1n],
    ] as [string, bigint][]) {
      const st: Sch.DealingState = { dealingDeadline: DL, threshold: 2, n: 3, dealt };
      const fin = Sch.finalizeResult(st, now);
      const ab = Sch.abortDealingResult(st, now);
      if (fin === "ok" && ab === "ok") throw new Error("finalize and abort both valid");
      dealing.push({
        name: `dealt${dealt}_${iname}`,
        ...st,
        now,
        expect: { deal: Sch.dealResult(st, now), finalize: fin, abort: ab },
      });
    }
  }

  const OPEN = 1900100000n;
  const FB = 1901000000n;
  const OPENED = 1900200000n;
  const decSpecs: [string, Sch.DecryptionState, bigint][] = [
    ...([
      ["openAtMinus1", OPEN - 1n],
      ["openAt", OPEN],
      ["openAtPlus1", OPEN + 1n],
    ] as [string, bigint][]).map(
      ([n, now]) =>
        [`scheduled_${n}`, { decryptionMode: SC, decryptionOpenAt: OPEN, manualDecryptionFallbackAt: 0n, manualOpenedAt: 0n }, now] as [
          string,
          Sch.DecryptionState,
          bigint,
        ],
    ),
    ...([
      ["fallbackMinus1", FB - 1n],
      ["fallback", FB],
      ["fallbackPlus1", FB + 1n],
    ] as [string, bigint][]).map(
      ([n, now]) =>
        [`manualFallback_${n}`, { decryptionMode: M, decryptionOpenAt: 0n, manualDecryptionFallbackAt: FB, manualOpenedAt: 0n }, now] as [
          string,
          Sch.DecryptionState,
          bigint,
        ],
    ),
    ["manualNoFallback_notOpened_early", { decryptionMode: M, decryptionOpenAt: 0n, manualDecryptionFallbackAt: 0n, manualOpenedAt: 0n }, OPENED],
    ["manualNoFallback_notOpened_late", { decryptionMode: M, decryptionOpenAt: 0n, manualDecryptionFallbackAt: 0n, manualOpenedAt: 0n }, 1950000000n],
    ["manualNoFallback_opened_sameBlock", { decryptionMode: M, decryptionOpenAt: 0n, manualDecryptionFallbackAt: 0n, manualOpenedAt: OPENED }, OPENED],
    ["manualNoFallback_opened_later", { decryptionMode: M, decryptionOpenAt: 0n, manualDecryptionFallbackAt: 0n, manualOpenedAt: OPENED }, 1950000000n],
    ["manualFallback_openedBefore_sameBlock", { decryptionMode: M, decryptionOpenAt: 0n, manualDecryptionFallbackAt: FB, manualOpenedAt: OPENED }, OPENED],
    ["manualFallback_openedBefore_fallbackMinus1", { decryptionMode: M, decryptionOpenAt: 0n, manualDecryptionFallbackAt: FB, manualOpenedAt: OPENED }, FB - 1n],
    ["manualFallback_openedBefore_fallbackPlus1", { decryptionMode: M, decryptionOpenAt: 0n, manualDecryptionFallbackAt: FB, manualOpenedAt: OPENED }, FB + 1n],
  ];
  const decryption = decSpecs.map(([name, st, now]) => {
    if (st.manualOpenedAt !== 0n && (st.manualOpenedAt > now || Sch.isDecryptionOpen({ ...st, manualOpenedAt: 0n }, st.manualOpenedAt)))
      throw new Error(`decryption case ${name}: impossible manualOpenedAt`);
    return {
      name,
      ...st,
      now,
      expect: { isDecryptionOpen: Sch.isDecryptionOpen(st, now), openDecryption: Sch.openDecryptionResult(st, now) },
    };
  });

  return {
    description:
      "Phase policies (§8.1 create-time validation; §8.2/§8.3 join and the two registration closes; §8.4 finalize/abort; §8.7 decryption opening) at -1 / equal / +1 of every timestamp. Error names and precedence are the CouncilManager's: create checks BadDuration (dealingDuration outside [600 s, 365 days]) before every BadSchedule rule; closeRegistration: WrongMode, RegistrationEnded, BelowThreshold; closeRegistrationScheduled: WrongMode, RegistrationNotDue, Expired, BelowThreshold; openDecryption (Live, valid signature): WrongMode, AlreadyOpen. Registration cases assume phase Registration, a free roster slot and participantCount == joined; dealing cases a member that has not dealt; decryption cases a Live ceremony. Timestamps and durations are decimal strings",
    phaseModes: { ...P.PHASE_MODES },
    minDealingDuration: P.MIN_DEALING_DURATION,
    maxDealingDuration: P.MAX_DEALING_DURATION,
    create,
    registration,
    dealing,
    decryption,
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
  write("codec.json", codecJson());
  write("partialdata.json", partialDataJson(scs));
  write("schedule.json", scheduleJson());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
