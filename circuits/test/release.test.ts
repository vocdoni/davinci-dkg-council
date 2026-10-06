// Committed release artifacts: vkeys, circuitReleaseId, generated verifiers and Foundry fixtures
// must all come from the same setup. Uses only committed files (no build/ needed).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recoverTypedDataAddress, type Hex } from "viem";
import * as snarkjs from "snarkjs";
import * as P from "../src/protocol.ts";
import { ROOT, shutdown } from "../src/harness.ts";

after(shutdown);
const read = (p: string) => readFileSync(`${ROOT}/${p}`);
const json = (p: string) => JSON.parse(read(p).toString("utf8"));
const release = json("release/release.json");

test("circuitReleaseId is K(circuit-release, sha256(deal vkey bytes), sha256(partial vkey bytes))", () => {
  const dealSha = P.sha256Hex(read("release/deal_vkey.json"));
  const partialSha = P.sha256Hex(read("release/partial_vkey.json"));
  assert.equal(dealSha, release.deal.vkey.sha256);
  assert.equal(partialSha, release.partial.vkey.sha256);
  assert.equal(P.circuitReleaseIdOf(dealSha, partialSha), release.circuitReleaseId);
});

test("generated verifiers embed exactly the released vkeys, 87 and 67 public signals in order", () => {
  for (const [c, name, n] of [
    ["deal", "DealVerifier", 87],
    ["partial", "PartialVerifier", 67],
  ] as const) {
    const vk = json(`release/${c}_vkey.json`);
    const sol = read(`../solidity/src/verifiers/${name}.sol`).toString("utf8");
    assert.match(sol, new RegExp(`contract ${name} \\{`));
    assert.match(sol, new RegExp(`uint\\[${n}\\] calldata _pubSignals`));
    assert.equal(vk.nPublic, n);
    assert.equal(vk.IC.length, n + 1);
    const constant = (k: string) => BigInt(new RegExp(`uint256 constant ${k}\\s*=\\s*(\\d+);`).exec(sol)![1]);
    vk.IC.forEach((pt: string[], i: number) => {
      assert.equal(constant(`IC${i}x`), BigInt(pt[0]), `${name} IC${i}x`);
      assert.equal(constant(`IC${i}y`), BigInt(pt[1]), `${name} IC${i}y`);
    });
    assert.ok(!new RegExp(`IC${n + 1}x`).test(sol));
    assert.equal(constant("deltax1"), BigInt(vk.vk_delta_2[0][1]));
    assert.equal(constant("deltax2"), BigInt(vk.vk_delta_2[0][0]));
  }
});

test("fixtures verify against the released vkeys, payload hashes and signatures recompute", async () => {
  const domainOf = (fx: { chainId: string; manager: Hex }) => P.domainOf(BigInt(fx.chainId), fx.manager);
  for (const s of ["A", "B"]) {
    const df = json(`fixtures/deal_${s}.json`);
    const dvk = json("release/deal_vkey.json");
    assert.equal(df.vkeySha256, release.deal.vkey.sha256);
    for (const d of df.dealings) {
      const proof = {
        pi_a: [d.proof.pA[0], d.proof.pA[1], "1"],
        pi_b: [
          [d.proof.pB[0][1], d.proof.pB[0][0]],
          [d.proof.pB[1][1], d.proof.pB[1][0]],
          ["1", "0"],
        ],
        pi_c: [d.proof.pC[0], d.proof.pC[1], "1"],
        protocol: "groth16",
        curve: "bn128",
      };
      assert.ok(await snarkjs.groth16.verify(dvk, d.pubSignals, proof), `deal ${s}/${d.dealerIndex}`);
      const words = P.proofWords(proof);
      const pt = (a: string[]) => [BigInt(a[0]), BigInt(a[1])] as P.Point;
      const hash = P.dealPayloadHash(df.ctx, d.C.map(pt), pt(d.E), d.masked.map(BigInt), words);
      assert.equal(hash, d.payloadHash);
      const msg = { ...d.deal.message, validUntil: BigInt(d.deal.message.validUntil) };
      const signer = await recoverTypedDataAddress({
        domain: domainOf(df),
        types: { Deal: P.EIP712_TYPES.Deal },
        primaryType: "Deal",
        message: msg,
        signature: d.deal.signature,
      });
      assert.equal(signer.toLowerCase(), d.authAddress);
    }
    const pf = json(`fixtures/partial_${s}.json`);
    const pvk = json("release/partial_vkey.json");
    for (const p of pf.partials) {
      const proof = {
        pi_a: [p.proof.pA[0], p.proof.pA[1], "1"],
        pi_b: [
          [p.proof.pB[0][1], p.proof.pB[0][0]],
          [p.proof.pB[1][1], p.proof.pB[1][0]],
          ["1", "0"],
        ],
        pi_c: [p.proof.pC[0], p.proof.pC[1], "1"],
        protocol: "groth16",
        curve: "bn128",
      };
      assert.ok(await snarkjs.groth16.verify(pvk, p.pubSignals, proof), `partial ${s}/${p.participantIndex}`);
      const D = p.D.map((d: string[]) => [BigInt(d[0]), BigInt(d[1])] as P.Point);
      assert.equal(P.partialPayloadHash(pf.request.requestId, D, P.proofWords(proof)), p.payloadHash);
    }
  }
});
