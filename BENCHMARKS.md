# Benchmarks

Everything in this file is **measured on protocol v2** (the slots-only storage diet and the
phase scheduling, implemented 2026-10-06) — gas from the v2 contracts, sizes from the compiled
v2 code. v2 changes neither circuit, so the circuit numbers carry over from v1 unchanged.
`docs/architecture.md` §1.8 keeps the v1 gas baseline next to the v2 table.

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
| `CouncilManager` | 21,777 B | 2,799 B |
| `CouncilViews` (delegatecalled for every view) | 6,521 B | 18,055 B |
| `CouncilOps` (delegatecalled for the eight rarely-used transitions) | 6,345 B | 18,231 B |
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
| `createCeremony` (16 invites) | 487,780 | 2,066,044 | invite SSTOREs; 143,225 with 2 invites (Osaka) |
| `join` | 520,618 | 882,796 | prime-subgroup check, Schnorr PoP, compressed-key storage |
| `closeRegistration` | 199,904 | 384,518 | roster re-supply + authentication, roster hash and `ctx`; 112,561 at `n = 3` (Osaka) |
| `closeRegistrationScheduled` | 192,523 | 377,163 | the permissionless time-based close; 98,460 at `n = 2` (Osaka receipt) |
| `deal` (first dealer) | 2,043,767 | 6,355,111 | verifier (87 public inputs), aggregation copy, 49 new slots |
| `deal` (later dealer) | 1,539,299 | 3,267,683 | folds into warm aggregate slots; 17 new slots; 1,000,638 / 1,383,034 at `n = 3, t = 2` |
| `finalize` | 33,923 | 35,123 | `A_0` identity check + phase flip, **zero** new slots — flat at every size (36,243 when `\|QUAL\| < n`) |
| `openDecryption` | 56,075 | 140,635 | writes `manualOpenedAt`; 41,127 when a fallback date already occupies the slot (Osaka) |
| `allowAdapter` / `authorizeCreator` | 58,642 / 58,799 | 141,063 / 141,006 | one SSTORE and a signature |
| `bindProcess` (through the test adapter) | 191,354 | 692,100 | binding record |
| `submitRequest` (16 fields) | 6,217,750 | 9,027,775 | 32 prime-subgroup checks, 32 compressed words; 814,502 for 2 fields (Osaka) |
| `submitPartial` (16 fields) | 977,910 | 1,142,173 | verifier (67 public inputs), hash commitment — no `D` storage; 807,978 for 2 fields (Osaka) |
| `publishPartialData` | 63,240–73,683 | 84,888 | hash check + event + packed block update |
| `combine` (`t = 16`, 2 fields) | 4,015,155 | 4,006,586 | `t + 1` scalar products per field + the re-supplied `D` vectors (≈ 260k of calldata); 620,792 at `t = 2` (Osaka) |
| `abort` | 34,061–34,122 | 35,661–35,722 | |

Isolated calls from `make solidity-gas` add `combine` at `t = 16`: 2.30M / 2.39M for one field,
4.00M / 4.01M for two, 7.45M / 7.55M for four (Osaka / Amsterdam).

`finalize` is flat because v2 aggregates incrementally at deal time (extended coordinates, one
batch inversion per deal) and computes member keys on demand in a view; finalize itself only
checks `A_0` and flips the phase. The v1 finalize, which aggregated everything on chain, measured
3,415,439 under Osaka and 9,049,931 under Amsterdam at `n = t = 16`; the affine version before
it, 11,604,123 and 17,238,603.

**Amsterdam.** EIP-8037 prices state growth separately, at 1,530 gas per byte: 97,920 for each
storage slot written from zero, 183,600 for a new account, 1,530 per byte of deployed code. No
opcode or precompile was repriced, so each action grows with the new slots it writes — the
quantity the v2 slots-only diet minimizes: a first dealing 49, a later one 17, `finalize` 0,
`submitRequest` 2 per field (compressed words), `submitPartial` 1–2 (hash + packed block).
`combine` writes almost nothing new and barely moves.

**The per-transaction limit.** Osaka caps a transaction at 2^24 = 16,777,216 gas (EIP-7825),
below Gnosis' 17M block limit, so that cap is the binding limit for one action. Under Osaka the
largest actions are a 4-field `combine` at `t = 16` (7.45M) and a 16-field `submitRequest`
(6.22M); `finalize` is 34k. Under Amsterdam the cap bounds execution gas only and state gas
comes on top; every action fits under 2^24 in total with room to spare, the largest being
`submitRequest` (9.03M) and the 4-field `combine` (7.55M). The combiner sends
`min(4, max(1, ⌊32 / t⌋))` fields per transaction, 2 at `t = 16`.

Osaka costs more than Cancun on the curve-heavy calls because EIP-7883 reprices modexp (≈ 1.35k
to ≈ 4.05k gas per inversion) and the vendored `BabyJubJub.sol` returns every affine point
through one: `combine` costs 7–8% more than under Cancun. Each `deal` inverts once in total (the
batch inversion of the aggregation fold), `finalize` not at all, and the verifier calls, the
subgroup checks (extended coordinates) and storage are unchanged.

A 16-member ceremony with one 16-field decryption costs about 88M gas in total under Osaka (16
deals 25M, eight 2-field combines 32M, 16 partials 15.6M, 16 joins 8.3M, the request 6.2M,
finalize 34k); the relayer pays all of it except the DAVINCI side's bind and request, about 82M.
Under Amsterdam the same lifecycle is about 133M, 123M of it paid by the relayer: the dealings
(55M) and combines (32M) dominate. (The v1 contracts measured 108M and 244M — Amsterdam roughly
halves under the diet.) A 3-member, `t = 2` ceremony with one 3-field decryption measures about
8.9M under Osaka; the 4-field v1 rehearsal on the current Sepolia manager measured 15.9M under
Amsterdam
([docs/deployments.md](docs/deployments.md#rehearsal-ceremony-on-the-current-manager-2026-10-06)).

The DAVINCI side, on a davinci-contracts `ProcessRegistry` (`tests/davinci.test.ts`, Osaka):
`newProcess` 886,459–920,659 for 2–8 fields (binding through the real `CouncilAdapter`),
`requestResultsDecryption` 877,091 for 2 fields with 2 active up to 2,426,992 for 8 fields with
6 active (its `submitRequest` included), `finalizeResultsFromDKG` 115,183–231,721.

## Relayer

| Figure | Value |
|---|---:|
| Combine worker: BSGS table build (2^20 baby steps) | 3.1 s |
| Combine worker: worst-case 40-bit plaintext (`2^40 − 1`) | 3.3 s |
| Process peak with the table resident | ≈ 200 MB |
| Largest single reservation, Osaka (4-field `combine` at `t = 16`, 8.94M gas limit at 2 × 1 gwei) | ≈ 0.018 native units |
| Largest single reservation, Amsterdam (4-field `combine` at `t = 16`, 9.06M gas limit at 2 × 1 gwei) | ≈ 0.018 native units |
| 16-member ceremony + one 16-field decryption, relayer share, at 1 gwei | ≈ 0.08 (Osaka) / ≈ 0.12 (Amsterdam) native units |
| 3-member ceremony + one 3-field decryption, at 1 gwei | ≈ 0.009 (Osaka) native units |

At 1 gwei the default daily budget (`COUNCIL_DAILY_BUDGET_WEI`, one native unit) sponsors about
twelve 16-member ceremonies with a decryption each under Osaka, about eight under Amsterdam.
[docs/relayer.md](docs/relayer.md) has the quotas that bound spending per ceremony.
