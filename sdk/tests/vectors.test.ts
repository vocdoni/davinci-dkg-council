/**
 * Cross-implementation vector tests: constants, derivation, identifiers,
 * eip712 (protocol §12). Each suite skips with a clear message when the
 * vectors have not been generated.
 */

import { describe, expect, it } from 'vitest';
import { poseidon7 } from 'poseidon-lite/poseidon7';
import { keccak256, toBytes } from 'viem';
import {
  COFACTOR,
  CURVE_ORDER,
  DERIVATION_VERSION,
  EIP712_NAME,
  EIP712_VERSION,
  FORM_K,
  FORM_K_INV,
  LIMIT_R,
  MASK_CONST,
  MAX_COMBINE_FIELDS,
  MAX_FIELDS,
  MAX_INVITES,
  MAX_N,
  MAX_T,
  MIN_DEALING_DURATION,
  P,
  R,
  RESULT_BOUND,
  SECP256K1_N,
  SEED_SALT,
  TAG_HASHES,
  TE_A,
  TE_D,
} from '../src/constants.js';
import { G, IDENTITY, modP, mulBase, teToReduced } from '../src/curve.js';
import {
  abiEncode,
  bigIntToHex32,
  bytes32ToLimbs,
  ceremonyId,
  circuitReleaseId,
  dealContext,
  hashToScalar,
  requestId,
  rosterHash,
  tagHash,
  taggedHash,
  toDecimal,
} from '../src/encoding.js';
import {
  deriveScalar,
  dealerCoefficient,
  dealerEphemeral,
  inviteCapabilityKey,
  organizerAuthKey,
  participantAuthKey,
  rootFromMnemonic,
  shareEncryptionKey,
  type DealerContext,
} from '../src/keys.js';
import { actionDigest, encodeTypeOf, recoverActionSigner, type ActionStructName } from '../src/eip712.js';
import { popChallenge, provePossession, verifyPossession } from '../src/dealing.js';
import { TAG_CEREMONY } from '../src/constants.js';
import { bytesToHex, fieldList, loadVectors, skipMsg, vp, vectorMessage, type TypedField } from './helpers.js';
import type { Hex, Roster } from '../src/types.js';

// --- constants.json ---

interface ConstantsVectors {
  curve: Record<string, string | string[]>;
  teToReduced: { K: string; K_INV: string; KSquaredEqualsMinusA: string; reducedG: string[] };
  secp256k1n: string;
  qBN: string;
  sizes: Record<string, number | string>;
  tags: { tag: string; keccak256: Hex }[];
  MASK_CONST: string;
  LIMIT_R: string;
  LIMIT_R_multiple: number;
  LIMIT_SECP256K1N: string;
  derivation: {
    hkdfHash: string;
    hkdfSalt: string;
    bip39Passphrase: string;
    derivationVersion: number;
    purposes: { purpose: string; keccak256: Hex }[];
  };
  eip712: {
    domainType: string;
    domainTypeHash: Hex;
    name: string;
    version: string;
    encodeTypes: { name: string; encodeType: string; typeHash: Hex }[];
  };
  poseidon7: { inputs: string[]; output: string };
  fixedBaseExceptional: { scalars: string[]; products: string[][] };
}

const constants = loadVectors<ConstantsVectors>('constants');

describe.skipIf(!constants)(constants ? 'vectors: constants' : skipMsg('constants'), () => {
  const v = constants as ConstantsVectors;

  it('curve constants', () => {
    expect(BigInt(v.curve.p as string)).toBe(P);
    expect(BigInt(v.curve.r as string)).toBe(R);
    expect(BigInt(v.curve.a as string)).toBe(TE_A);
    expect(BigInt(v.curve.d as string)).toBe(TE_D);
    expect(BigInt(v.curve.cofactor as string)).toBe(COFACTOR);
    expect(BigInt(v.curve.curveOrder as string)).toBe(CURVE_ORDER);
    expect(vp(v.curve.identity as string[])).toEqual(IDENTITY);
    expect(vp(v.curve.G as string[])).toEqual(G);
    expect(mulBase(1n << 246n)).toEqual(vp(v.curve.G246 as string[]));
    expect(mulBase(R - 1n)).toEqual(vp(v.curve.rMinus1G as string[]));
  });

  it('TE <-> reduced map', () => {
    expect(BigInt(v.teToReduced.K)).toBe(FORM_K);
    expect(BigInt(v.teToReduced.K_INV)).toBe(FORM_K_INV);
    expect((FORM_K * FORM_K_INV) % P).toBe(1n);
    expect(BigInt(v.teToReduced.KSquaredEqualsMinusA)).toBe(modP(FORM_K * FORM_K));
    expect(modP(FORM_K * FORM_K)).toBe(modP(-TE_A));
    expect(teToReduced(G)).toEqual(vp(v.teToReduced.reducedG));
  });

  it('moduli and sizes', () => {
    expect(BigInt(v.secp256k1n)).toBe(SECP256K1_N);
    expect(BigInt(v.qBN)).toBe(21888242871839275222246405745257275088696311157297823662689037894645226208583n);
    expect(v.sizes.MAX_N).toBe(MAX_N);
    expect(v.sizes.MAX_T).toBe(MAX_T);
    expect(v.sizes.MAX_FIELDS).toBe(MAX_FIELDS);
    expect(BigInt(v.sizes.RESULT_BOUND as string)).toBe(RESULT_BOUND);
    expect(v.sizes.MAX_COMBINE_FIELDS).toBe(MAX_COMBINE_FIELDS);
    expect(v.sizes.MAX_INVITES).toBe(MAX_INVITES);
    expect(BigInt(v.sizes.MIN_DEALING_DURATION as number)).toBe(MIN_DEALING_DURATION);
  });

  it('tag hashes (pinned and recomputed)', () => {
    expect(v.tags).toHaveLength(Object.keys(TAG_HASHES).length);
    for (const { tag, keccak256: pinned } of v.tags) {
      expect(tagHash(tag)).toBe(pinned);
      expect(TAG_HASHES[tag]).toBe(pinned);
    }
  });

  it('mask constant and rejection limits', () => {
    expect(BigInt(v.MASK_CONST)).toBe(MASK_CONST);
    expect(MASK_CONST).toBe(BigInt(tagHash('davinci-dkg-council/v1/share-mask-poseidon')) % P);
    expect(BigInt(v.LIMIT_R)).toBe(LIMIT_R);
    expect(BigInt(v.LIMIT_R_multiple)).toBe(LIMIT_R / R);
    expect(LIMIT_R).toBe((2n ** 256n / R) * R);
    expect(BigInt(v.LIMIT_SECP256K1N)).toBe((2n ** 256n / SECP256K1_N) * SECP256K1_N);
  });

  it('derivation constants', () => {
    expect(v.derivation.hkdfSalt).toBe(SEED_SALT);
    expect(v.derivation.bip39Passphrase).toBe('');
    expect(v.derivation.derivationVersion).toBe(DERIVATION_VERSION);
    expect(v.derivation.purposes.map((p) => p.purpose).sort()).toEqual(
      [
        'davinci-dkg-council/v1/derive/auth-secp256k1',
        'davinci-dkg-council/v1/derive/share-encryption-bjj',
        'davinci-dkg-council/v1/derive/organizer-auth-secp256k1',
        'davinci-dkg-council/v1/derive/invite-capability-secp256k1',
        'davinci-dkg-council/v1/derive/dealer-coefficient',
        'davinci-dkg-council/v1/derive/dealer-ephemeral',
      ].sort(),
    );
    for (const p of v.derivation.purposes) {
      expect(keccak256(toBytes(p.purpose))).toBe(p.keccak256);
    }
  });

  it('eip712 constants', () => {
    expect(v.eip712.name).toBe(EIP712_NAME);
    expect(v.eip712.version).toBe(EIP712_VERSION);
    expect(keccak256(toBytes(v.eip712.domainType))).toBe(v.eip712.domainTypeHash);
    for (const entry of v.eip712.encodeTypes) {
      expect(encodeTypeOf(entry.name as ActionStructName)).toBe(entry.encodeType);
      expect(keccak256(toBytes(entry.encodeType))).toBe(entry.typeHash);
    }
  });

  it('poseidon7 parameterization', () => {
    const out = poseidon7(v.poseidon7.inputs.map(BigInt));
    expect(toDecimal(out)).toBe(v.poseidon7.output);
  });

  it('fixed-base exceptional scalars', () => {
    v.fixedBaseExceptional.scalars.forEach((s, i) => {
      expect(mulBase(BigInt(s) % R)).toEqual(vp(v.fixedBaseExceptional.products[i] as string[]));
    });
  });
});

// --- derivation.json ---

interface DeriveEntry {
  purpose: string;
  context: TypedField[];
  counter: number;
  info0: Hex;
  value: string;
  secret?: Hex;
  address?: Hex;
  publicKey?: string[];
  k?: number;
  inviteId?: number;
}

interface DerivationVectors {
  hashToScalar: {
    examples: {
      tag: string;
      fields: TypedField[];
      attempts: { counter: number; u: Hex; accepted: boolean }[];
      counter: number;
      value: string;
    }[];
    rejection: DerivationVectors['hashToScalar']['examples'][number];
  };
  deriveScalar: { rejection: DeriveEntry & { modulus: string; allowZero: boolean } };
  pinnedMnemonic: {
    mnemonic: string;
    seed: Hex;
    prk: Hex;
    chainId: string;
    manager: Hex;
    ceremonyId: Hex;
    accountIndex: number;
    organizerAuth: DeriveEntry;
    auth: DeriveEntry;
    shareEncryption: DeriveEntry;
    inviteCapability: DeriveEntry[];
    dealer: {
      frozen: {
        chainId: string;
        manager: Hex;
        ceremonyId: Hex;
        accountIndex: number;
        rosterHash: Hex;
        dealerIndex: number;
        t: number;
        circuitReleaseId: Hex;
      };
      dealerCoefficient: DeriveEntry[];
      dealerEphemeral: DeriveEntry;
    };
  };
}

const derivation = loadVectors<DerivationVectors>('derivation');

describe.skipIf(!derivation)(derivation ? 'vectors: derivation' : skipMsg('derivation'), () => {
  const v = derivation as DerivationVectors;

  const checkAttempts = (example: DerivationVectors['hashToScalar']['examples'][number]) => {
    const { types, values } = fieldList(example.fields);
    for (const attempt of example.attempts) {
      const u = keccak256(
        abiEncode(`bytes32, ${types}, uint32`, [tagHash(example.tag), ...values, attempt.counter]),
      );
      expect(u).toBe(attempt.u);
      expect(BigInt(u) < LIMIT_R).toBe(attempt.accepted);
    }
    expect(hashToScalar(example.tag, types, values)).toBe(BigInt(example.value));
  };

  it('hashToScalar examples and rejection', () => {
    for (const ex of v.hashToScalar.examples) checkAttempts(ex);
    expect(v.hashToScalar.rejection.counter).toBeGreaterThan(0);
    checkAttempts(v.hashToScalar.rejection);
  });

  const root = () => rootFromMnemonic(v.pinnedMnemonic.mnemonic);

  const checkInfo0 = (entry: DeriveEntry) => {
    const { types, values } = fieldList(entry.context);
    const info0 = abiEncode('bytes32, bytes32, uint32', [
      keccak256(toBytes(entry.purpose)),
      keccak256(abiEncode(types, values)),
      0,
    ]);
    expect(info0).toBe(entry.info0);
  };

  it('deriveScalar rejection example', () => {
    const rej = v.deriveScalar.rejection;
    checkInfo0(rej);
    const { types, values } = fieldList(rej.context);
    expect(rej.counter).toBeGreaterThan(0);
    expect(deriveScalar(root(), BigInt(rej.modulus), rej.purpose, types, values, rej.allowZero)).toBe(
      BigInt(rej.value),
    );
  });

  it('pinned mnemonic root', () => {
    expect(bytesToHex(root().prk)).toBe(v.pinnedMnemonic.prk);
  });

  it('organizer auth key', () => {
    const pm = v.pinnedMnemonic;
    checkInfo0(pm.organizerAuth);
    const key = organizerAuthKey(root(), { chainId: BigInt(pm.chainId), manager: pm.manager });
    expect(toDecimal(key.secret)).toBe(pm.organizerAuth.value);
    expect(bigIntToHex32(key.secret)).toBe(pm.organizerAuth.secret);
    expect(key.address.toLowerCase()).toBe(pm.organizerAuth.address);
  });

  it('participant auth key', () => {
    const pm = v.pinnedMnemonic;
    checkInfo0(pm.auth);
    const ctx = { chainId: BigInt(pm.chainId), manager: pm.manager, ceremonyId: pm.ceremonyId };
    const key = participantAuthKey(root(), ctx);
    expect(bigIntToHex32(key.secret)).toBe(pm.auth.secret);
    expect(key.address.toLowerCase()).toBe(pm.auth.address);
  });

  it('share-encryption key', () => {
    const pm = v.pinnedMnemonic;
    checkInfo0(pm.shareEncryption);
    const ctx = { chainId: BigInt(pm.chainId), manager: pm.manager, ceremonyId: pm.ceremonyId };
    const key = shareEncryptionKey(root(), ctx);
    expect(toDecimal(key.secret)).toBe(pm.shareEncryption.value);
    expect(key.publicKey).toEqual(vp(pm.shareEncryption.publicKey as string[]));
  });

  it('invite capability keys', () => {
    const pm = v.pinnedMnemonic;
    for (const entry of pm.inviteCapability) {
      checkInfo0(entry);
      const key = inviteCapabilityKey(root(), {
        chainId: BigInt(pm.chainId),
        manager: pm.manager,
        ceremonyId: pm.ceremonyId,
        inviteId: entry.inviteId as number,
      });
      expect(toDecimal(key.secret)).toBe(entry.value);
      if (entry.address) expect(key.address.toLowerCase()).toBe(entry.address);
    }
  });

  it('dealer coefficient and ephemeral derivations', () => {
    const d = v.pinnedMnemonic.dealer;
    const ctx: DealerContext = {
      chainId: BigInt(d.frozen.chainId),
      manager: d.frozen.manager,
      ceremonyId: d.frozen.ceremonyId,
      accountIndex: d.frozen.accountIndex,
      rosterHash: d.frozen.rosterHash,
      dealerIndex: d.frozen.dealerIndex,
      t: d.frozen.t,
      circuitReleaseId: d.frozen.circuitReleaseId,
    };
    d.dealerCoefficient.forEach((entry, k) => {
      checkInfo0(entry);
      expect(toDecimal(dealerCoefficient(root(), ctx, entry.k ?? k))).toBe(entry.value);
    });
    checkInfo0(d.dealerEphemeral);
    expect(toDecimal(dealerEphemeral(root(), ctx))).toBe(d.dealerEphemeral.value);
  });
});

// --- identifiers.json ---

interface IdentifierMember {
  index: number;
  inviteId: number;
  mnemonic: string;
  prk: Hex;
  authSecret: Hex;
  authAddress: Hex;
  shareSecret: string;
  X: string[];
  XReducedX: string;
  pop: { k: string; A: string[]; AReducedX: string; c: string; cCounter: number; z: string };
}

interface IdentifiersVectors {
  circuitRelease: { dealVkeySha256: Hex; partialVkeySha256: Hex; circuitReleaseId: Hex };
  ceremonyIdExamples: {
    chainId: string;
    manager: Hex;
    organizer: Hex;
    nonce: string;
    fullHash?: Hex;
    ceremonyId: Hex;
  }[];
  scenarios: {
    name: string;
    chainId: string;
    manager: Hex;
    ceremonyId: Hex;
    t: number;
    n: number;
    organizer: { mnemonic: string; secret: Hex; address: Hex };
    nonce: string;
    invites: { inviteId: number; secret: Hex; address: Hex; linkFragment: string }[];
    members: IdentifierMember[];
    rosterHash: Hex;
    circuitReleaseId: Hex;
    ctx: Hex;
    ctxHi: string;
    ctxLo: string;
    request: { adapter: Hex; creator: Hex; processId: Hex; requestId: Hex };
  }[];
}

const identifiers = loadVectors<IdentifiersVectors>('identifiers');

describe.skipIf(!identifiers)(identifiers ? 'vectors: identifiers' : skipMsg('identifiers'), () => {
  const v = identifiers as IdentifiersVectors;

  it('circuit release id', () => {
    const c = v.circuitRelease;
    expect(circuitReleaseId(c.dealVkeySha256, c.partialVkeySha256)).toBe(c.circuitReleaseId);
  });

  it('ceremony id examples', () => {
    for (const ex of v.ceremonyIdExamples) {
      const full = taggedHash(TAG_CEREMONY, 'uint256, address, address, uint64', [
        BigInt(ex.chainId),
        ex.manager,
        ex.organizer,
        BigInt(ex.nonce),
      ]);
      if (ex.fullHash !== undefined) expect(full).toBe(ex.fullHash);
      expect(ex.ceremonyId).toBe(full.slice(0, 26));
      expect(ceremonyId(BigInt(ex.chainId), ex.manager, ex.organizer, BigInt(ex.nonce))).toBe(ex.ceremonyId);
    }
  });

  for (const sc of identifiers?.scenarios ?? []) {
    describe(`scenario ${sc.name} (t=${sc.t}, n=${sc.n})`, () => {
      const chainId = BigInt(sc.chainId);

      it('organizer and ceremony id', () => {
        const orgRoot = rootFromMnemonic(sc.organizer.mnemonic);
        const key = organizerAuthKey(orgRoot, { chainId, manager: sc.manager });
        expect(bigIntToHex32(key.secret)).toBe(sc.organizer.secret);
        expect(key.address.toLowerCase()).toBe(sc.organizer.address);
        expect(ceremonyId(chainId, sc.manager, key.address, BigInt(sc.nonce))).toBe(sc.ceremonyId);
      });

      it('invite capabilities', () => {
        const orgRoot = rootFromMnemonic(sc.organizer.mnemonic);
        for (const inv of sc.invites) {
          const key = inviteCapabilityKey(orgRoot, {
            chainId,
            manager: sc.manager,
            ceremonyId: sc.ceremonyId,
            inviteId: inv.inviteId,
          });
          expect(bigIntToHex32(key.secret)).toBe(inv.secret);
          expect(key.address.toLowerCase()).toBe(inv.address);
          expect(inv.linkFragment).toBe(`v1.${inv.inviteId}.${inv.secret.slice(2)}`);
        }
      });

      it('member derivations and PoP', () => {
        for (const m of sc.members) {
          const root = rootFromMnemonic(m.mnemonic);
          expect(bytesToHex(root.prk)).toBe(m.prk);
          const ctx = { chainId, manager: sc.manager, ceremonyId: sc.ceremonyId };
          const auth = participantAuthKey(root, ctx);
          expect(bigIntToHex32(auth.secret)).toBe(m.authSecret);
          expect(auth.address.toLowerCase()).toBe(m.authAddress);
          const share = shareEncryptionKey(root, ctx);
          expect(toDecimal(share.secret)).toBe(m.shareSecret);
          expect(share.publicKey).toEqual(vp(m.X));
          expect(toDecimal(teToReduced(share.publicKey).x)).toBe(m.XReducedX);

          const popCtx = { chainId, manager: sc.manager, ceremonyId: sc.ceremonyId, participant: m.authAddress };
          const kBytes = toBytes(bigIntToHex32(BigInt(m.pop.k)));
          const proof = provePossession(popCtx, share.secret, () => kBytes);
          expect(proof.A).toEqual(vp(m.pop.A));
          expect(toDecimal(teToReduced(proof.A).x)).toBe(m.pop.AReducedX);
          expect(toDecimal(popChallenge(popCtx, share.publicKey, proof.A))).toBe(m.pop.c);
          expect(toDecimal(proof.z)).toBe(m.pop.z);
          expect(verifyPossession(popCtx, share.publicKey, proof)).toBe(true);
        }
      });

      it('roster hash, ctx and request id', () => {
        const roster: Roster = {
          t: sc.t,
          n: sc.n,
          authAddresses: sc.members.map((m) => m.authAddress),
          memberKeys: sc.members.map((m) => vp(m.X)),
        };
        expect(rosterHash(chainId, sc.manager, sc.ceremonyId, roster)).toBe(sc.rosterHash);
        const ctx = dealContext(chainId, sc.manager, sc.ceremonyId, sc.rosterHash, sc.circuitReleaseId);
        expect(ctx).toBe(sc.ctx);
        const limbs = bytes32ToLimbs(ctx);
        expect(toDecimal(limbs.hi)).toBe(sc.ctxHi);
        expect(toDecimal(limbs.lo)).toBe(sc.ctxLo);
        expect(requestId(chainId, sc.manager, sc.ceremonyId, sc.request.adapter, sc.request.processId)).toBe(
          sc.request.requestId,
        );
      });
    });
  }
});

// --- eip712.json ---

interface Eip712Vectors {
  domain: { name: string; version: string; chainId: string; verifyingContract: Hex; domainSeparator: Hex };
  actions: {
    struct: ActionStructName;
    encodeType: string;
    typeHash: Hex;
    message: Record<string, unknown>;
    structHash: Hex;
    digest: Hex;
    signer: Hex;
    signature: Hex;
  }[];
}

const eip712 = loadVectors<Eip712Vectors>('eip712');

describe.skipIf(!eip712)(eip712 ? 'vectors: eip712' : skipMsg('eip712'), () => {
  const v = eip712 as Eip712Vectors;
  const chainId = () => BigInt(v.domain.chainId);
  const manager = () => v.domain.verifyingContract;

  it('domain separator', () => {
    expect(v.domain.name).toBe(EIP712_NAME);
    expect(v.domain.version).toBe(EIP712_VERSION);
    const typeHash = keccak256(
      toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    );
    const separator = keccak256(
      abiEncode('bytes32, bytes32, bytes32, uint256, address', [
        typeHash,
        keccak256(toBytes(v.domain.name)),
        keccak256(toBytes(v.domain.version)),
        chainId(),
        manager(),
      ]),
    );
    expect(separator).toBe(v.domain.domainSeparator);
  });

  it('every action struct: encodeType, typeHash, digest, signature', async () => {
    expect(v.actions).toHaveLength(9);
    for (const a of v.actions) {
      expect(encodeTypeOf(a.struct)).toBe(a.encodeType);
      expect(keccak256(toBytes(a.encodeType))).toBe(a.typeHash);
      const message = vectorMessage(a.message) as never;
      expect(actionDigest(chainId(), manager(), a.struct, message)).toBe(a.digest);
      const signer = await recoverActionSigner(chainId(), manager(), a.struct, message, a.signature);
      expect(signer.toLowerCase()).toBe(a.signer.toLowerCase());
    }
  });

  it('struct hashes bind to the digest through the domain separator', () => {
    for (const a of v.actions) {
      const digest = keccak256(`0x1901${v.domain.domainSeparator.slice(2)}${a.structHash.slice(2)}`);
      expect(digest).toBe(a.digest);
    }
  });
});
