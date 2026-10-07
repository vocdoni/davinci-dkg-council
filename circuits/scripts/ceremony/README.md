# Phase-2 ceremony (coordinator runbook)

The committed `circuits-v1` release is a DEVELOPMENT setup: one person ran phase 2 and could forge
every deal and partial proof (audit H-01). A production release replaces it with a multi-party
Groth16 phase 2, sound as long as one contributor destroyed their randomness:

- **Phase 1:** the Hermez/PPoT `powersOfTau28_hez_final_18.ptau`, blake2b-pinned (the same file and
  digest as `circuits/build.sh` and `scripts/ci-fetch-ptau.sh`).
- **Phase 2:** `snarkjs zkey new`, then sequential `zkey contribute` by independent contributors.
  The coordinator runs `zkey verify` against the r1cs and the ptau after every one, before passing
  the result on.
- **Beacon:** a final `zkey beacon` (2^10 iterations) from a value announced before it exists:
  either a drand quicknet round (its BLS signature is checked against the pinned League of Entropy
  key) or a finalized block hash that several RPCs agree on.

Contributors follow [CONTRIBUTOR.md](CONTRIBUTOR.md). Everything below runs from the repository
root as `make ceremony ARGS="…"` (= `circuits/node_modules/.bin/tsx circuits/scripts/ceremony/ceremony.ts …`).
Each step updates `<dir>/ceremony.json` (the state the next step checks) and appends to
`<dir>/transcript.log`. Every snarkjs verification log is kept under `<dir>/verify/` and every
attestation under `<dir>/attestations/`.

Rehearse first: `make ceremony-dry-run` runs the whole flow with three simulated contributors in a
temporary directory (see `dry-run.sh`), re-pins a scratch copy of the checkout and runs the forge
suite there. It never touches this checkout.

## Before

- Pick the tag (`circuits-v2`) and N ≥ 3 contributors who do not trust each other (different
  organizations, ideally different OSs and snarkjs builds). Publish the list, the order and the
  schedule.
- Freeze the circuits: `init` compiles them with circom 2.2.3 exactly as `build.sh` does and
  reports whether the r1cs/wasm are byte-identical to the committed release's.
- Get the ptau: `bash scripts/ci-fetch-ptau.sh ~/.davinci-dkg-council/ptau/powersOfTau28_hez_final_18.ptau`
  (or set `COUNCIL_PTAU`).

## Steps

1. **Start.** `make ceremony ARGS="init --dir $PWD/ceremony-v2 --tag circuits-v2"`. This compiles
   both circuits into `<dir>/build`, then runs `zkey new` for both (`zkeys/{deal,partial}_0000.zkey`)
   and verifies the result. Publish `ceremony.json`.
2. **For each contributor k = 1…N, in order:**
   1. Send `zkeys/deal_{k-1}.zkey`, `zkeys/partial_{k-1}.zkey` and `ceremony.json`.
   2. They return `deal_k.zkey`, `partial_k.zkey`, `attestation_k.json` and a signature of the
      attestation. They also publish their two contribution hashes themselves.
   3. Run `make ceremony ARGS="accept --dir <dir> --from <their files>"`. `accept` refuses the files
      unless the attestation is #k of this tag, the inputs are the current head, the zkeys are the
      attested bytes, and `zkey verify` from the r1cs and the ptau passes. The verified chain must
      also extend the recorded one unchanged and end with exactly the attested contribution hash
      and name.
   4. Check the hashes they published against `ceremony.json`. A contributor who drops out is
      skipped: the next one starts from the current head.
3. **Announce the beacon** when contributions close, before its value exists. Publish the
   announcement (commit `ceremony.json`, post it) with enough lead time for people to see it:

   ```bash
   make ceremony ARGS="announce-beacon --dir <dir> --drand-in 86400"   # a quicknet round ~24 h ahead
   make ceremony ARGS="announce-beacon --dir <dir> --block 41000000 --chain-id 100 --rpc https://rpc.gnosischain.com,https://gnosis-rpc.publicnode.com"
   ```

   A beacon can be announced only once; changing it means a new ceremony.
4. **Apply it.** `make ceremony ARGS="beacon --dir <dir> --wait"`. This fetches the value: the drand
   signature is verified, and a block must be finalized with every RPC agreeing. It refuses a value
   timestamped before the last accepted contribution or before the announcement. It then applies
   `zkey beacon` and verifies both final zkeys from scratch.
5. **Export.** `make ceremony ARGS="export --dir <dir>"` writes `<dir>/release/`: the six release
   files (`deal.wasm`, `partial.wasm`, `*_final.zkey`, `*_vkey.json`), both generated verifiers and
   `release.json`. The release file has `developmentSetup: false` and a `ceremony` block with the
   contributors, their hashes and the beacon evidence.
6. **Install and re-pin.** `make ceremony ARGS="install --dir <dir>"` copies the release into
   `circuits/release`, `solidity/src/verifiers` and `circuits/build`. It then runs `forge build` and
   `circuits/scripts/pin.ts`, which writes `CouncilRelease.sol` (`DEVELOPMENT_SETUP = false`, the
   vkey/release/verifier pins) and `sdk/src/artifacts.ts`. Then:
   - `make fixtures`, `make circuits-test`, `make test`, `make e2e`
   - commit everything from this one ceremony together (the pins, verifiers, vkeys and fixtures
     form one unit; see the release-pinning note in CONTRIBUTING.md), then publish the release
     files under the tag (`trigger-upload-circuits`).
7. **Publish the transcript.** That is the whole `<dir>`: `ceremony.json`, `transcript.log`,
   `attestations/`, `verify/`, the intermediate zkeys and `release/`. Anyone can then re-check it
   from scratch with
   `make ceremony ARGS="verify --dir <dir> [--repo .]"`. That command re-verifies the final zkeys
   against the r1cs and the Hermez ptau and matches each contribution against its attestation. It
   also refetches and re-verifies the beacon, re-exports the vkeys and compares them with the
   release (and with the checkout's `circuits/release`).
8. **Deploy** with `scripts/gnosis/deploy.sh`. `Deploy.s.sol` refuses a DEVELOPMENT_SETUP release
   on any chain but 31337, Sepolia and Chiado unless you pass `ALLOW_DEV_SETUP=true`, so a ceremony
   release is the only one that deploys to Gnosis without that override.

## What the tool checks, and what it cannot

It checks:
- the phase-1 file
- that every zkey descends from the r1cs and the ptau
- that the chain is unbroken and append-only
- that each contribution is the attested one
- that the beacon was fixed in advance and authentic

It cannot check that a contributor destroyed their randomness. That is why you need several
independent contributors who each publish their own hashes and signed attestation.
