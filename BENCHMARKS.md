# Benchmarks

Measured with the `circuits-v1` artifacts (development setup — phase 1 from a locally generated
ptau and phase 2 a single local contribution + beacon, see `circuits/release/release.json`;
circom 2.2.3 `--O2`, circomlib 2.0.5, snarkjs 0.7.6, Groth16 on BN254) and the contracts
compiled with solc 0.8.28 via IR,
`optimizer_runs = 1`. Gas is quoted under **Osaka**, the EVM Gnosis runs (Anvil `--hardfork
osaka` for the end-to-end figures, the Foundry `gas` profile for the isolated ones), and under
**Amsterdam**, the execution layer of Glamsterdam, which Sepolia runs since 2026-10-06 (`forge
--evm-version amsterdam`, isolated calls). Machine: AMD Ryzen 9 9950X3D, 32 threads, 64 GB.

Reproduce: constraint counts and file sizes are in `circuits/release/release.json`; Node proving
with `pnpm --filter ./circuits run bench [--single-thread] 3`; in-browser proving from the
Playwright journey (`make e2e-browser`, which prints it and writes `timings.json` next to the
screenshots); gas from the headless suite (`make e2e`, which rewrites `tests/GAS.md`) and from
`make solidity-gas` (`solidity/snapshots/council.json` under Osaka,
`solidity/snapshots/council-amsterdam.json` under Amsterdam); the BSGS figures with
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
| `CouncilManager` | 21,745 B | 2,831 B |
| `CouncilViews` (delegatecalled for every view) | 4,579 B | 19,997 B |
| `DealVerifier` (87 public inputs) | 15,407 B | 9,169 B |
| `PartialVerifier` (67 public inputs) | 12,088 B | 12,488 B |

`make solidity-build` prints the full table (`forge build --sizes`).

## Gas

The Osaka column is transaction receipts from the headless suite (`tests/GAS.md`): real verifiers
and proofs, `gasUsed` including the 21,000 intrinsic gas and calldata. Anvil does not price
Amsterdam's state gas yet, so the Amsterdam column is the isolated calls of `make solidity-gas`
under `forge --evm-version amsterdam` (`snapshots/council-amsterdam.json`; real verifiers for
`deal` and `submitPartial`), which reproduces Sepolia's receipts exactly. Worst case `n = t = 16`
unless noted.

| Action | Osaka | Amsterdam | Dominated by |
|---|---:|---:|---|
| `createCeremony` (16 invites) | 480,919 | 2,059,155 | invite SSTOREs; 129,693 with 2 invites (Osaka) |
| `join` | 542,357 | 992,955 | prime-subgroup check, Schnorr PoP, storage |
| `closeRegistration` | 202,456 | 386,656 | roster hash and `ctx`; 110,787 at `n = 3` (Osaka) |
| `deal` | 2,064,160 | 6,466,738 | verifier (87 public inputs), 50-word dealing storage, payload hash; 1,080,535 / 1,874,334 at `n = 3, t = 2` |
| `finalize` | 3,415,439 | 9,049,931 | 64 new storage slots, the aggregation and 240 Horner small-scalar steps in extended coordinates, one inversion; 302,969 at `n = 3, t = 2`, 501,071 / 1,910,591 at `n = 5, t = 3` |
| `allowAdapter` / `authorizeCreator` | 55,972 / 56,227 | 137,978 / 138,032 | one SSTORE and a signature |
| `bindProcess` (through the test adapter) | 189,166 | 692,089 | binding record |
| `submitRequest` (16 fields) | 6,922,234 | 12,542,617 | 32 prime-subgroup checks, 64-word storage; 902,554 for 2 fields (Osaka) |
| `submitPartial` (16 fields) | 1,519,334 | 4,337,535 | verifier (67 public inputs), `D` storage; 824,159 for 2 fields (Osaka) |
| `combine` (`t = 16`, 2 fields) | 3,806,751 | 3,795,906 | `t + 1` scalar products per field; 865,793 at `t = 2` (Osaka) |
| `abort` | 31,344 | | |

Isolated calls from `make solidity-gas` add `combine` at `t = 16`: 2.03M / 2.11M for one field,
3.79M / 3.80M for two, 7.37M / 7.47M for four (Osaka / Amsterdam).

`finalize` computes the aggregates `A_k` and the member keys `PK_m` in extended coordinates and
converts all `t + n` points to affine with one batch inversion. The affine version it replaced,
which went through one modexp inversion per curve operation (≈ 720 at `n = t = 16`), measured
11,604,123 under Osaka and 17,238,603 under Amsterdam; at `n = 5, t = 3`, 820,790 and 2,230,310.

**Amsterdam.** EIP-8037 prices state growth separately, at 1,530 gas per byte: 97,920 for each
storage slot written from zero, 183,600 for a new account, 1,530 per byte of deployed code. No
opcode or precompile was repriced, so each action grows with the new slots it writes: a dealing
50, `finalize` 2t + 2n = 64 (6.27M of its 9.05M), `submitRequest` 4 per field, `submitPartial` 2
per field. `combine` writes almost nothing new and barely moves.

**The per-transaction limit.** Osaka caps a transaction at 2^24 = 16,777,216 gas (EIP-7825),
below Gnosis' 17M block limit, so that cap is the binding limit for one action. Under Osaka the
largest actions are a 4-field `combine` at `t = 16` (7.37M) and a 16-field `submitRequest`
(6.92M); `finalize` is 3.42M. Under Amsterdam the cap bounds execution gas only and state gas
comes on top; even so, every action fits under 2^24 in total, the largest being `submitRequest`
(12.54M) and `finalize` (9.05M). The combiner sends `min(4, max(1, ⌊32 / t⌋))` fields per
transaction, 2 at `t = 16`.

Osaka costs more than Cancun on the curve-heavy calls because EIP-7883 reprices modexp (≈ 1.35k
to ≈ 4.05k gas per inversion) and the vendored `BabyJubJub.sol` returns every affine point
through one: `combine` costs 7–8% more than under Cancun. `finalize` inverts once in total, and
the verifier calls, the subgroup checks (extended coordinates) and storage are unchanged.

A 16-member ceremony with one 16-field decryption costs about 108M gas in total under Osaka (16
deals 33M, eight 2-field combines 30M, 16 partials 24M, 16 joins 8.7M, the request 6.9M,
finalize 3.4M); the relayer pays all of it except the DAVINCI side's bind and request, about
101M. Under Amsterdam the same lifecycle is about 244M, 231M of it paid by the relayer: the
dealings (103M) and partials (69M) write most of the new slots. A 3-member, `t = 2` ceremony with
one 4-field decryption costs about 9.0M under Osaka and 15.9M on Sepolia under Amsterdam
([docs/deployments.md](docs/deployments.md#rehearsal-ceremony-on-the-current-manager-2026-10-06)).

The DAVINCI side, on a davinci-contracts `ProcessRegistry` (`tests/davinci.test.ts`, Osaka):
`newProcess` 886,426 with 4 fields (binding through the real `CouncilAdapter`),
`requestResultsDecryption` 1,397,010 for 4 fields with 3 active (its `submitRequest` included),
`finalizeResultsFromDKG` 150,488.

## Relayer

| Figure | Value |
|---|---:|
| Combine worker: BSGS table build (2^20 baby steps) | 3.1 s |
| Combine worker: worst-case 40-bit plaintext (`2^40 − 1`) | 3.3 s |
| Process peak with the table resident | ≈ 200 MB |
| Largest single reservation, Osaka (4-field `combine` at `t = 16`, 8.85M gas limit at 2 × 1 gwei) | ≈ 0.018 native units |
| Largest single reservation, Amsterdam (`finalize` at `n = t = 16`, 10.86M gas limit at 2 × 1 gwei) | ≈ 0.022 native units |
| 16-member ceremony + one 16-field decryption, relayer share, at 1 gwei | ≈ 0.10 (Osaka) / ≈ 0.23 (Amsterdam) native units |
| 3-member ceremony + one 4-field decryption, at 1 gwei | ≈ 0.009 (Osaka) / ≈ 0.016 (Amsterdam, measured on Sepolia) native units |

At 1 gwei the default daily budget (`COUNCIL_DAILY_BUDGET_WEI`, one native unit) sponsors about
ten 16-member ceremonies with a decryption each under Osaka, about four under Amsterdam.
[docs/relayer.md](docs/relayer.md) has the quotas that bound spending per ceremony.
