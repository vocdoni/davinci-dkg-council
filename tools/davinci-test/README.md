# davinci-test

A small davinci-sdk client for the DAVINCI side of Council: it creates a DAVINCI process whose
encryption key is a Council ceremony's key (`keyMode: 'council'`, registry `KeyMode.COUNCIL = 3`),
ends it, and reads its results once the committee has decrypted them. The headless e2e suite
(`tests/tests/davinci.test.ts`) drives it; it also documents the integration.

Everything goes through the `DavinciSDK` facade. The app adds two checks of its own: the
registry's `councilAdapter()` points back at the registry and at the expected Council manager,
and the created process carries exactly the ceremony key (`getPublicKey(ceremonyId)`).

## Build

The SDK comes from a local davinci-sdk checkout with the COUNCIL key mode (branch `council`),
consumed from its `dist/`:

```bash
(cd ../davinci-sdk && npx -y yarn@1 install && npx -y yarn@1 build)   # once, and after SDK changes
npx -y pnpm@10 --filter ./tools/davinci-test build                   # from the repository root
```

`build` runs `scripts/link-sdk.mjs`, which links `node_modules/@vocdoni/davinci-sdk` to
`DAVINCI_SDK_DIR` (default: `davinci-sdk` next to this repository's main checkout) and
`node_modules/ethers` to the SDK's own ethers, so the app's wallet is the class the SDK checks.

## Use

```bash
export DAVINCI_RPC_URL=http://127.0.0.1:8545
export DAVINCI_REGISTRY=0x...            # ProcessRegistry built with a Council manager
export COUNCIL_MANAGER=0x...            # checked against the registry's CouncilAdapter
export DAVINCI_ORGANIZER_KEY=0x...       # the process creator
export DAVINCI_VERIFY=off                # a registry on MockZiskVerifier (see below)

node tools/davinci-test/dist/cli.js create --ceremony 0x<bytes12> [--fields 4] [--max-value 1000000] [--max-voters 1000000] [--duration 3600]
node tools/davinci-test/dist/cli.js end --process 0x<bytes31>
node tools/davinci-test/dist/cli.js results --process 0x<bytes31> [--finalize]
```

Every option can also come from a JSON file (`--config file.json` with `rpcUrl`, `registry`,
`manager`, `organizerKey`, `ceremonyId`, `sequencerUrls`, `verify`); flags win over the file, the
file over the environment. `--json` prints one JSON object (bigints as decimal strings); on
failure it carries `error` and, for a contract refusal, `revertName` (e.g. `NotAuthorizedCreator`).

`create` makes a rating process (one question, `--fields` choices up to 16, values up to
`--max-value`; the registry caps `maxValue * maxVoters` at 1e12) over a one-member census, and
prints the process id, the ceremony, the Council request id it is bound under, the key and the
adapter. The ceremony must be Live, its organizer must have allowed the registry's
`councilAdapter()` and authorized the creating account; otherwise the creation fails at
simulation with the manager's error and nothing is sent.

`results` prints the SDK's results state (`voting`, `grace`, `awaiting-request`, `decrypting`,
`finalizable`, `results`) and, once stored, one total per ballot field (fields the registry
skipped as never written read 0). `--finalize` sends the permissionless `finalizeResultsFromDKG`
when the plaintexts are ready.

### Local chains

Without `--sequencer` / `DAVINCI_SEQUENCER_URLS` the app starts a local stand-in for a node: it
answers `/info` with the registry's pins as an observer (a COUNCIL process needs no key from a
node) and hosts the census file and metadata document the SDK uploads, for as long as the command
runs. Later reads report the metadata as unreachable and number the fields instead of naming them.

`verify` checks the deployment at init: `release` (default, the davinci-sdk release pins), a JSON
file of explicit pins, or `off`. A registry deployed on `MockZiskVerifier` has no verifier code
or vadcop root to pin, so local mock deployments use `off`.

## What it does not do

The results request is not part of the app: after the end and the grace window, the sequencer (or
anyone holding the final accumulator and its SMT proof) calls `requestResultsDecryption`, the
ceremony members post partial decryptions through the Council app or relayer, and the relayer's
combine worker completes the request. The e2e suite plays that part with a single-leaf state root.
