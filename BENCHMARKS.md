# Benchmarks

Measured with the `circuits-v1` artifacts (development setup — phase 1 from a locally generated
ptau and phase 2 a single local contribution + beacon, see `circuits/release/release.json`;
circom 2.2.3 `--O2`, circomlib 2.0.5, snarkjs 0.7.6, Groth16 on BN254) and the contracts
compiled with solc 0.8.28 via IR,
`optimizer_runs = 1`. Gas is quoted under **Osaka**, the EVM Sepolia and Gnosis run: Anvil
`--hardfork osaka` for the end-to-end figures, the Foundry `gas` profile for the isolated ones.
Machine: AMD Ryzen 9 9950X3D, 32 threads, 64 GB.

Reproduce: constraint counts and file sizes are in `circuits/release/release.json`; Node proving
with `pnpm --filter ./circuits run bench [--single-thread] 3`; in-browser proving from the
Playwright journey (`make e2e-browser`, which prints it and writes `timings.json` next to the
screenshots); gas from the headless suite (`make e2e`, which rewrites `tests/GAS.md`) and from
`make solidity-gas` (`solidity/snapshots/council.json`); the BSGS figures with
`pnpm --filter ./sdk run bench:bsgs`.

## Circuits

| Circuit | Constraints | Public inputs | Wires | Proving key | wasm |
|---|---:|---:|---:|---:|---:|
| `deal.circom` (n, t ≤ 16) | 83,395 | 87 | 83,244 | 53.8 MB | 2.98 MB |
| `partial.circom` (≤ 16 fields) | 37,712 | 67 | 37,700 | 21.0 MB | 0.23 MB |

The circuit size is fixed by the capacities (`MAX_N = MAX_T = MAX_FIELDS = 16`); the live `(t, n)`
and field count change only the calldata. Where the constraints go: a dealing is 33 fixed-base
products (16 commitments, the ephemeral, 16 Feldman checks), 16 variable-base ECDH products, 16
Horner evaluations of the commitment polynomial, 16 Poseidon7 masks and the range plumbing; a
partial is one fixed-base and 16 variable-base products. Both carry one dedicated `x·x` row per
public input (87 + 67), redundant with the rows snarkjs adds itself and kept on purpose (protocol
§8.5 item 5). The whole release (both proving keys, wasm files and verification keys) is 78.0 MB;
a member downloads the deal files once to contribute and the partial files once to decrypt, and
the app keeps them in the browser's Cache API.

| Proving (witness + Groth16) | deal | partial |
|---|---:|---:|
| Node, snarkjs, 32 threads (median of 3) | 1.46 s | 0.55 s |
| Node, snarkjs, single thread (median of 3) | 6.94 s | 3.75 s |
| Chromium (headless, app Web Worker, same machine) | 1.3 s | 0.8 s |

The browser figure is the app's own prover worker in the Playwright journey; the phone project
there only emulates the viewport, so it runs on the same CPU. A phone or a low-end laptop lands
between the multi-threaded and single-threaded Node figures. Verification on chain is a constant
of the public-input count (below).

## Contracts

| Contract | Runtime size | EIP-170 margin |
|---|---:|---:|
| `CouncilManager` | 20,774 B | 3,802 B |
| `CouncilViews` (delegatecalled for every view) | 4,579 B | 19,997 B |
| `DealVerifier` (87 public inputs) | 15,407 B | 9,169 B |
| `PartialVerifier` (67 public inputs) | 12,088 B | 12,488 B |

`make solidity-build` prints the full table (`forge build --sizes`).

## Gas

Transaction receipts from the headless suite (`tests/GAS.md`): real verifiers and proofs,
`gasUsed` including the 21,000 intrinsic gas and calldata. Worst case `n = t = 16` unless noted.

| Action | Gas | Dominated by |
|---|---:|---|
| `createCeremony` (16 invites) | 480,903 | invite SSTOREs; 129,721 with 2 invites |
| `join` | 542,512 | prime-subgroup check, Schnorr PoP, storage |
| `closeRegistration` | 202,440 | roster hash and `ctx`; 110,787 at `n = 3` |
| `deal` | 2,064,183 | verifier (87 public inputs), 50-word dealing storage, payload hash; 1,080,558 at `n = 3, t = 2` |
| `finalize` | 11,604,123 | 240 Horner small-scalar products and the aggregation (≈ 720 modexp inversions), 34 cold SSTOREs; 395,150 at `n = 3, t = 2`, 820,790 at `n = 5, t = 3` |
| `allowAdapter` / `authorizeCreator` | 55,968 / 56,244 | one SSTORE and a signature |
| `bindProcess` (through the test adapter) | 189,168 | binding record |
| `submitRequest` (16 fields) | 6,921,258 | 32 prime-subgroup checks, 64-word storage; 902,438 for 2 fields |
| `submitPartial` (16 fields) | 1,519,358 | verifier (67 public inputs), `D` storage; 824,141 for 2 fields |
| `combine` (`t = 16`, 2 fields) | 3,802,937 | `t + 1` scalar products per field; 865,213 at `t = 2` |
| `abort` | 31,344 | |

Isolated calls from `make solidity-gas` add `combine` at `t = 16`: 2.02M for one field, 3.78M for
two, 7.36M for four.

Osaka caps a transaction at 2^24 = 16,777,216 gas (EIP-7825), below Gnosis' 17M block limit, so
that cap is the binding limit for one action. The worst case, `finalize` at 11.60M, is 69% of it;
with the relayer's 20% headroom it is sent with a 13.92M gas limit. Only `finalize`, a 4-field
`combine` at `t = 16` (7.36M) and a 16-field `submitRequest` (6.92M) come anywhere near the cap;
the combiner sends `min(4, max(1, ⌊32 / t⌋))` fields per transaction, 2 at `t = 16`.

Osaka costs more than Cancun on the curve-heavy calls because EIP-7883 reprices modexp (≈ 1.35k
to ≈ 4.05k gas per inversion) and the vendored `BabyJubJub.sol` returns every affine point
through one: `finalize` at `n = t = 16` was 9.66M under Cancun, `combine` 7–8% less. The verifier
calls, the subgroup checks (extended coordinates) and storage are unchanged.

A 16-member ceremony with one 16-field decryption costs about 116M gas in total (16 deals 33M,
16 partials 24M, eight 2-field combines 30M, finalize 11.6M, 16 joins 8.7M, the request 6.9M);
the relayer pays all of it except the DAVINCI side's bind and request, about 109M. A 3-member,
`t = 2` ceremony with one 4-field decryption costs about 9.1M.

The DAVINCI side, on a davinci-contracts `ProcessRegistry` (`tests/davinci.test.ts`):
`newProcess` 886,426 with 4 fields (binding through the real `CouncilAdapter`),
`requestResultsDecryption` 1,396,836 for 4 fields with 3 active (its `submitRequest` included),
`finalizeResultsFromDKG` 150,488.

## Relayer

| Figure | Value |
|---|---:|
| Combine worker: BSGS table build (2^20 baby steps) | 3.1 s |
| Combine worker: worst-case 40-bit plaintext (`2^40 − 1`) | 3.3 s |
| Process peak with the table resident | ≈ 200 MB |
| Largest single reservation (`finalize`, `n = t = 16`, 13.92M gas at 2 × 1 gwei) | ≈ 0.028 native units |
| 16-member ceremony + one 16-field decryption, relayer share, at 1 gwei | ≈ 0.11 native units |
| 3-member ceremony + one 4-field decryption, at 1 gwei | ≈ 0.009 native units |

At 1 gwei the default daily budget (`COUNCIL_DAILY_BUDGET_WEI`, one native unit) sponsors about
nine 16-member ceremonies with a decryption each. [docs/relayer.md](docs/relayer.md) has the
quotas that bound spending per ceremony.
