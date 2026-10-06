# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an issue first so the
design can be agreed before the work starts. Protocol changes usually touch the circuits, the
contracts and the SDK at once; read [docs/protocol.md](docs/protocol.md) and
[docs/architecture.md](docs/architecture.md) before changing an encoding or a check.

## Prerequisites

- Node.js 22 and pnpm 10 (`npx -y pnpm@10` works without a global install)
- [Foundry](https://getfoundry.sh) v1.8.3 (solc 0.8.28 is fetched by `forge`), or Docker, which the
  Makefile and the e2e suite fall back to
- circom 2.2.3 at `~/.local/bin/circom` (or `CIRCOM`) for the circuits
- Chromium for Playwright (`npx -y pnpm@10 --filter ./ui exec playwright install chromium`) for
  the browser journeys

## Repository layout

| Path | Contents |
|---|---|
| `circuits/` | `deal.circom`, `partial.circom`, `lib/gadgets.circom`; `build.sh` (new DEV setup), `scripts/` (restore, pin, fixtures, vectors, bench), `test/`, `release/` (vkeys + manifest), `fixtures/` (canned proofs) |
| `solidity/` | `CouncilManager`, `CouncilViews`, storage/types, `libraries/` (`CouncilCurve`, `CouncilEIP712`, the vendored `BabyJubJub`), generated `verifiers/`, tests, `script/` (deploy + release pins) |
| `sdk/` | `@vocdoni/davinci-dkg-council-sdk` |
| `relayer/` | the relayer service and its Docker image |
| `ui/` | the web app, its unit tests and the Playwright journeys (`ui/e2e/`) |
| `tests/` | the headless end-to-end suite, the DAVINCI round trip, the local dev stack (`src/dev.ts`) and `vectors/` |
| `tools/davinci-test/` | davinci-sdk CLI for Council-keyed DAVINCI processes |
| `scripts/` | dev stack, Sepolia deploy and rehearsal, CI helpers, the app config renderer |

## Building and testing

```bash
make install                 # the pnpm workspace, frozen lockfile
make test                    # forge test, SDK, relayer, app: what most changes need
make solidity-build          # forge build --sizes (EIP-170 margins)
make vectors-check           # regenerate tests/vectors and fail on any difference
```

Circuit tests need `circuits/build/`. `make circuits-restore` compiles both circuits (compilation
is deterministic; the r1cs and wasm bytes are checked against `circuits/release/release.json`) and
fetches the released proving keys into `~/.davinci-dkg-council/artifacts/` without running a
setup, so the restored build matches the committed verifiers, pins and fixtures. Then:

```bash
make circuits-test           # witness, mutation, adversarial, gadget and release suites (~2 min)
```

The end-to-end suites use the same artifacts cache:

```bash
make e2e                     # headless: Anvil (Osaka), real proofs, the relayer, DAVINCI round trip
make e2e-browser             # Playwright journeys against `make dev`, desktop and phone viewports
```

The DAVINCI round trip (`tests/tests/davinci.test.ts`) builds the
[davinci-contracts](https://github.com/vocdoni/davinci-contracts) and
[davinci-sdk](https://github.com/vocdoni/davinci-sdk) checkouts next to this repository (or
`DAVINCI_CONTRACTS_DIR` / `DAVINCI_SDK_DIR`), on their `council` branches; build davinci-sdk once
with `npx -y yarn@1 install && npx -y yarn@1 build`. With a host Foundry the Makefile sets
`E2E_FOUNDRY=host`; otherwise the suite runs Anvil and forge from `ghcr.io/foundry-rs/foundry`.

### What CI checks

- `forge build --sizes` and `forge test`.
- The SDK (`check`, `build`, `test`), the relayer (`check`, `build`, `test`) and the app
  (`scripts/render-ui-config.test.sh`, `lint`, `test`, `build`).
- `vectors-check`.
- When `circuits/` or the vectors change, and nightly: a throwaway DEV phase-2 against the Hermez
  powers of tau, fresh fixtures, and the circuit suites.
- On demand (workflow dispatch with `e2e`): the headless suite against the published release.
- The relayer and app images build on every run and are pushed on branch pushes.

## Keeping implementations in sync

The protocol is implemented in circom, Solidity and TypeScript (the SDK, plus the standalone
reference code in `circuits/src/protocol.ts` that generates the vectors). A change to any of the
following must land in every place listed, in one pull request:

| What | Where |
|---|---|
| Domain tags and their keccaks, `MASK_CONST` | `circuits/src/protocol.ts`, `circuits/deal.circom` (`MASK_CONST`), `solidity/src/CouncilManager.sol` (`TAG_*`), `sdk/src/constants.ts`, `docs/protocol.md` §2.4; then `make vectors` |
| EIP-712 domain and `encodeType` strings | `solidity/src/libraries/CouncilEIP712.sol`, `sdk/src/eip712.ts`, `circuits/src/protocol.ts`, `docs/protocol.md` §7 |
| Sizes and bounds (`MAX_N`, `MAX_T`, `MAX_FIELDS`, `RESULT_BOUND`, …) | the circuits (`N`, `T` vars), `solidity/src/CouncilTypes.sol`, `sdk/src/constants.ts`, `circuits/src/protocol.ts`; a circuit change is a new release |
| Public-input order | `deal.circom` / `partial.circom` main components, `CouncilManager` input builders, the SDK witness builders, protocol §8.5 / §10.1 |
| Manager ABI | `solidity/src/interfaces/ICouncil.sol` and `sdk/src/abi.ts` (hand-written; `sdk/tests/unit-io.test.ts` and `tests/tests/abi.test.ts` compare them with the compiled ABI) |
| Adapter-facing interface | `solidity/src/interfaces/ICouncilManager.sol`, vendored verbatim by davinci-contracts |

`tests/vectors/*.json` are the contract between the implementations: the SDK, Foundry and circuit
tests all assert them, and the generator must never import the SDK. A one-bit divergence in a tag,
a payload hash or a public-input slot makes every proof or signature fail on chain.

## Changing the circuits

```bash
make circuits   # COUNCIL_PTAU=/path/to/2^18.ptau overrides the default phase-1 file
```

runs `circuits/build.sh` (compile, a new **DEV** phase 2 with one local contribution and a
beacon, the generated verifiers in `solidity/src/verifiers/`, the vkeys and `release.json` in
`circuits/release/`, the vectors), `forge build`, `circuits/scripts/pin.ts` (the sha256 pins in
`sdk/src/artifacts.ts` and every value in `solidity/script/CouncilRelease.sol`) and the proof
fixtures. On first use `build.sh` downloads the Hermez `powersOfTau28_hez_final_18.ptau` to
`~/.davinci-dkg-council/ptau/` and verifies its blake2b before touching it. Note that the pinned
`circuits-v1` DEV release predates that default: its phase 1 came from a locally generated ptau
(`toolchain.ptauSha256` in `circuits/release/release.json`), and its phase 2 is the single local
contribution + beacon above — a production release must start from the Hermez/PPoT ptau and run
a multi-party phase 2 (docs/architecture.md §2). Commit all of it together or none of it: the
release id, the verifiers, the pins and the fixtures come from one setup, and
`circuits/test/release.test.ts` and `solidity/test/CouncilDeploy.t.sol` fail on a mix.

A circuit release is published through the `Publish Circuits` workflow: bump the tag in
`circuits/scripts/release.ts` (`circuits-vN`), label the pull request `trigger-upload-circuits`,
and the workflow runs the pipeline above on a GitHub runner, stages a draft release with the six
files and uploads the re-pinned tree as an artifact; commit that run's files and publish the draft
when the pull request merges. Every new setup is a new `circuitReleaseId` and therefore a new
manager deployment.

Gadget rules (protocol §8.5): never use `EscalarMulFix(251, Base8)` directly (it is incomplete for
three canonical scalars); every fixed-base product is the split `EscalarMulFix(246, G)` +
`EscalarMulFix(5, [2^246]·G)` + `BabyAdd` over the bits that also feed the `< r` check. circomlib
(2.0.5) and snarkjs (0.7.6) are pinned with the release; bumping either is a new release.

## Generated files

Regenerate these instead of editing them:

- `solidity/src/verifiers/*.sol`, `circuits/release/*`: `make circuits`
- `circuits/fixtures/*.json`: `make fixtures`
- `tests/vectors/*.json`: `make vectors`
- `tests/GAS.md`: a full `make e2e` run
- `solidity/.gas-snapshot`, `solidity/snapshots/council.json`: `make solidity-gas`

`solidity/src/libraries/BabyJubJub.sol` is vendored from davinci-dkg; take upstream fixes by
replacing the whole file below its header.

## Commits and releases

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org):
`type(scope): summary`, lowercase, for example `fix(relayer): resync the nonce after a refusal`.
Pushing a `vX.Y.Z` tag publishes the relayer and app images and creates the GitHub release;
`latest` moves on stable tags only, and release candidates (`vX.Y.Z-rc1`) publish their own tag.
Circuit artifacts are released separately as `circuits-vN`.
