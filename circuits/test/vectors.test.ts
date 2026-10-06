// Independent re-checks of the committed vectors with primitives other than the generator's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mnemonicToAccount, privateKeyToAddress } from "viem/accounts";
import { encodeAbiParameters, keccak256, toBytes, toHex, type Hex } from "viem";
import { mulPointEscalar, addPoint, inCurve } from "@zk-kit/baby-jubjub";
import * as P from "../src/protocol.ts";

const V = (name: string) => JSON.parse(readFileSync(new URL(`../../tests/vectors/${name}`, import.meta.url), "utf8"));
const big = (s: string) => BigInt(s);
const pt = (a: string[]): [bigint, bigint] => [big(a[0]), big(a[1])];

test("pinned test mnemonic is the well-known anvil mnemonic", () => {
  const d = V("derivation.json");
  assert.equal(mnemonicToAccount(d.pinnedMnemonic.mnemonic).address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
});

test("HKDF-Expand via node:crypto matches every DeriveScalar vector", () => {
  const d = V("derivation.json");
  const pm = d.pinnedMnemonic;
  // node's hkdfSync does extract+expand; check the PRK-based expand by re-running extract via the seed
  for (const key of [pm.organizerAuth, pm.auth, pm.shareEncryption, ...pm.inviteCapability]) {
    const okm = Buffer.from(hkdfSync("sha256", Buffer.from(pm.seed.slice(2), "hex"), Buffer.from("davinci-dkg-council/seed/v1"), Buffer.from(key.info0.slice(2), "hex"), 32));
    assert.equal(toHex(okm), key.attempts[0].u);
  }
});

test("constants: tag hashes, mask constant, limits", () => {
  const c = V("constants.json");
  for (const t of c.tags) assert.equal(keccak256(toBytes(t.tag)), t.keccak256);
  assert.equal(BigInt(keccak256(toBytes("davinci-dkg-council/v1/share-mask-poseidon"))) % P.P, big(c.MASK_CONST));
  assert.equal(((1n << 256n) / P.R) * P.R, big(c.LIMIT_R));
  assert.ok(inCurve(pt(c.curve.G)));
  const g246 = mulPointEscalar(pt(c.curve.G), 1n << 246n);
  assert.deepEqual(g246, pt(c.curve.G246));
});

test("dealing vectors: C, E, Feldman and public inputs are consistent (zk-kit arithmetic)", () => {
  const d = V("dealing.json");
  for (const sc of d.scenarios) {
    for (const dl of sc.dealings) {
      const G = pt(V("constants.json").curve.G);
      dl.a.forEach((a: string, k: number) => assert.deepEqual(mulPointEscalar(G, big(a)), pt(dl.C[k])));
      assert.deepEqual(mulPointEscalar(G, big(dl.e)), pt(dl.E));
      for (let i = 0; i < sc.n; i++) {
        // Horner over the commitments with zk-kit
        let acc = pt(dl.C[15]);
        for (let k = 14; k >= 0; k--) acc = addPoint(mulPointEscalar(acc, BigInt(i + 1)), pt(dl.C[k]));
        assert.deepEqual(mulPointEscalar(G, big(dl.shares[i])), acc);
        assert.equal(big(dl.masked[i]), (big(dl.shares[i]) + big(dl.masks[i])) % P.P);
      }
      for (let i = sc.n; i < 16; i++) assert.equal(dl.masked[i], "0");
      assert.equal(dl.publicInputs.length, 87);
      assert.equal(dl.publicInputs[2], String(dl.dealerIndex));
    }
  }
});

test("identifiers: ceremony id is the top 12 bytes of the tagged hash", () => {
  const ids = V("identifiers.json");
  for (const ex of ids.ceremonyIdExamples.slice(0, 2)) assert.equal(ex.ceremonyId, ex.fullHash.slice(0, 26));
  for (const sc of ids.scenarios) {
    for (const inv of sc.invites) assert.equal(privateKeyToAddress(inv.secret as Hex).toLowerCase(), inv.address);
    const enc = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes12" }, { type: "bytes32" }, { type: "bytes32" }],
      [keccak256(toBytes("davinci-dkg-council/v1/deal-context")), BigInt(sc.chainId), sc.manager, sc.ceremonyId, sc.rosterHash, sc.circuitReleaseId],
    );
    assert.equal(keccak256(enc), sc.ctx);
  }
});

test("combine vectors satisfy m·G + Σ λ_i·D_i == C2", () => {
  const c = V("combine.json");
  const G = pt(V("constants.json").curve.G);
  for (const sc of c.scenarios) {
    for (const cb of sc.combines) {
      for (const f of cb.fields) {
        let acc = mulPointEscalar(G, big(f.plaintext));
        cb.memberSet.forEach((i: number, idx: number) => {
          acc = addPoint(acc, mulPointEscalar(pt(sc.partials[i - 1].D[f.field]), big(cb.lambdas[idx])));
        });
        const ct = sc.request.cts[f.field];
        assert.deepEqual(acc, [big(ct[2]), big(ct[3])]);
      }
    }
  }
});
