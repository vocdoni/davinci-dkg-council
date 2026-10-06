# DAVINCI DKG Council

An invite-only threshold key ceremony for [DAVINCI](https://davinci.vote) elections. An organizer
invites up to 16 people; each joins from a plain browser with keys derived from a 12-word recovery
phrase and contributes one proven Feldman dealing. The contract aggregates the contributions into
one ElGamal public key on BabyJubJub. DAVINCI processes bound to the committee encrypt their
tallies under that key, and any `t` of the `n` members can later decrypt the final result, each
with one small proof computed in the browser. Members never see an address, a transaction or a gas
price: every action is an EIP-712 signed message that a relayer forwards.

[![Build and Test](https://github.com/vocdoni/davinci-dkg-council/actions/workflows/main.yml/badge.svg)](https://github.com/vocdoni/davinci-dkg-council/actions/workflows/main.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

## Overview

Council ("the committee" in the app) is the invite-only complement of the permissionless
[DAVINCI DKG](https://github.com/vocdoni/davinci-dkg): a known group instead of lottery-drawn
operators, one key per ceremony instead of pools of 16, circom/snarkjs proofs small enough for a
phone instead of gnark, and no node software at all. Both produce BabyJubJub threshold keys that
DAVINCI's process registry consumes through the same adapter pattern (`KeyMode.COUNCIL = 3`); the
two systems share no state.

Every dealing is proven correct (Groth16) before the contract accepts it, so there is no complaint
round and no finalization proof: any member, including one that never dealt, can recover a valid
share from chain state alone, months later, with its recovery words. Every partial decryption is
proven too, and the contract checks each combined plaintext exactly, field by field.

```
createCeremony ─► n × join ─► closeRegistration ─► n × deal (proof) ─► finalize ─► Live
allowAdapter + authorizeCreator ─► DAVINCI newProcess (bindProcess) ─► votes ─► requestResultsDecryption
  (submitRequest) ─► t × submitPartial (proof) ─► combine ─► finalizeResultsFromDKG
```

| Component | Path | Purpose |
|---|---|---|
| Circuits | `circuits/` | `deal.circom` (87 public inputs) and `partial.circom` (67), circom 2.2.3 + snarkjs Groth16 on BN254 |
| Contracts | `solidity/` | `CouncilManager` (+ `CouncilViews`) and the two generated verifiers |
| TypeScript SDK | `sdk/` | `@vocdoni/davinci-dkg-council-sdk`: keys, recovery kit, invites, dealing, recovery, partials, combine, authenticated reads |
| Relayer | `relayer/` | Sends the signed actions from a funded hot key and runs the public combine step |
| Web app | `ui/` | The organizer and participant app: create, invite, join, contribute, unlock results |
| End-to-end tests | `tests/` | Headless suite on Anvil (Osaka), the DAVINCI round trip, the local dev stack, cross-implementation vectors |
| DAVINCI client | `tools/davinci-test/` | davinci-sdk CLI that creates and settles a Council-keyed process |

The protocol is specified in [docs/protocol.md](docs/protocol.md); it is the source of truth for
every byte on the wire.

## Quick start

Run the whole stack on your machine: Anvil, the real verifiers and manager, the relayer, a DAVINCI
process registry and the app.

```bash
git clone git@github.com:vocdoni/davinci-dkg-council.git
cd davinci-dkg-council
make install
make dev
```

`make dev` (`scripts/dev-stack.sh`) builds what it needs, starts everything and prints the URLs;
Ctrl-C stops all of it.

| Service | Default | What it is |
|---|---|---|
| App | http://127.0.0.1:5175 | the app (vite), configured through `ui/public/config.json` (rewritten at start; with the default ports it equals the committed file) |
| Anvil | http://127.0.0.1:8545 | chain 31337, Osaka (as Sepolia and Gnosis), 17M block gas limit, `finalized` = latest |
| Contracts | | the real `DealVerifier`, `PartialVerifier` and `CouncilManager` bound to the circuit release, held to the pins in `solidity/script/CouncilRelease.sol` |
| Circuit files | http://127.0.0.1:8789 | the six pinned files; the app checks every byte against the SDK's sha256 pins |
| Relayer | http://127.0.0.1:8788 | pays from Anvil account 1, combine worker on, open admission, state in `.dev/relayer` (wiped at start) |
| DAVINCI | | a davinci-contracts `ProcessRegistry` on `MockZiskVerifier` with its `CouncilAdapter` |

Requirements: Node 22, Foundry (the host install in `~/.foundry/bin` or on `PATH`; Docker
otherwise) and the circuit files in `~/.davinci-dkg-council/artifacts/` (`COUNCIL_ARTIFACTS_DIR`;
`make circuits-restore` downloads and verifies them). The DAVINCI part needs the
[davinci-contracts](https://github.com/vocdoni/davinci-contracts) and
[davinci-sdk](https://github.com/vocdoni/davinci-sdk) checkouts on their `council` branch next to
this repository (or `DAVINCI_CONTRACTS_DIR` / `DAVINCI_SDK_DIR`; build the SDK once with
`npx -y yarn@1 install && npx -y yarn@1 build`); `COUNCIL_DEV_DAVINCI=off make dev` runs without
it. Ports: `COUNCIL_DEV_ANVIL_PORT`, `COUNCIL_DEV_RELAYER_PORT`, `COUNCIL_DEV_ARTIFACTS_PORT`,
`COUNCIL_DEV_APP_PORT`. Logs go to `.dev/logs/`.

A full round, by hand:

1. Open the app, start a committee, save and rehearse the recovery kit, create it, and open the
   invite links in other browser profiles (or private windows): each person saves a kit and joins.
2. Lock the member list; each member approves it and adds a contribution (the proof runs in the
   browser); once all are in, press "Finish the key".
3. Under "Connections", approve the voting system connection and the election organizer that
   `make dev` printed (the registry's `CouncilAdapter` and Anvil account 4).
4. With the committee id from the page URL (`/c/0x…`):

   ```bash
   make dev-process CEREMONY=0x…               # a DAVINCI process on the committee key
   make dev-settle PROCESS=0x… TALLY=7,0,3,12   # end it, settle that tally, request the decryption
   ```

   `dev-settle` stands in for the sequencer: it writes the encrypted tally as the process's only
   state leaf, moves the chain past the grace window and calls `requestResultsDecryption`.
5. Enough members press "Check and turn my key"; the relayer combines, every page shows the
   numbers, and `make dev-results PROCESS=0x…` stores them in the registry and prints them.

## Usage

### Running a relayer

The relayer is the only service Council needs. It is stateless toward the chain, holds no user
secrets and can be replaced at any time: every action it relays can be sent directly.

```bash
docker run -d -p 8080:8080 -v council-relayer:/data \
  -e COUNCIL_RPC_URL=https://rpc-a.example,https://rpc-b.example \
  -e COUNCIL_MANAGER_ADDRESS=0x… -e COUNCIL_PRIVATE_KEY=0x… \
  -e COUNCIL_COMBINER_ENABLED=true ghcr.io/vocdoni/davinci-dkg-council-relayer
```

[docs/relayer.md](docs/relayer.md) covers configuration, the spending bounds and how to size the
daily budget.

### Hosting the app

The app is a static bundle with a runtime `/config.json` naming the chain, the manager, two or
more RPC providers, the relayer and a mirror of the circuit files. `ui/Dockerfile` builds it
(`ghcr.io/vocdoni/davinci-dkg-council-ui`, nginx with a single-page-app fallback) and
`ui/.do/davinci-dkg-council-ui.yaml` deploys it to DigitalOcean App Platform; both render the
config from build arguments ([docs/deployments.md](docs/deployments.md#app-and-relayer)).
`scripts/railway-deploy-ui.sh` and `scripts/railway-deploy-relayer.sh` host both on Railway, with
the circuit files served by the app's own origin
([Hosting on Railway](docs/deployments.md#hosting-on-railway)).

### Binding DAVINCI processes

Once a committee is live, its organizer allows the registry's `CouncilAdapter` and authorizes the
process creator (both in the app, under "Connections"). The creator then makes a process on the
committee key with davinci-sdk:

```ts
await sdk.createProcess({
  title: 'Board election',
  census, maxVoters: 500,
  electionPreset: { type: 'rating', maxValue: 1 },
  questions: [{ title: 'Candidates', choices: [{ title: 'A', value: 0 }, { title: 'B', value: 1 }] }],
  timing: { duration: 7 * 24 * 3600 },
  keyMode: 'council',
  ceremonyId: '0x…',          // the committee id, bytes12
});
```

The registry binds the process through the adapter and uses the ceremony key as the process
encryption key. After the vote the sequencer requests the decryption, the members unlock it in the
app, the relayer combines, and anyone calls `finalizeResultsFromDKG`.
[tools/davinci-test](tools/davinci-test/README.md) is a complete client.

### Deployments

| Network | Circuit release | CouncilManager | Status |
|---|---|---|---|
| Sepolia | `circuits-v1` (development setup) | [`0x57ef5e2bc28fa120f1e5cb6dfe1b096ea06c3070`](https://sepolia.etherscan.io/address/0x57ef5e2bc28fa120f1e5cb6dfe1b096ea06c3070) | rehearsals only |

`circuits-v1` is a development phase 2, so it is not for real elections. The Sepolia app runs at
https://council-ui-production.up.railway.app, with a public relayer.
[docs/deployments.md](docs/deployments.md) has every address, the release pins, the first live
ceremony (gas, cost and timings) and how to deploy.

## Documentation

- [docs/protocol.md](docs/protocol.md): the normative protocol: constants, hashes, keys and the
  recovery kit, invitations, EIP-712 actions, the state machine, both circuit statements,
  decryption and the security argument.
- [docs/architecture.md](docs/architecture.md): contract surface, gas, circuits and artifacts,
  the DAVINCI integration, SDK, relayer API, app, testing and build.
- [docs/relayer.md](docs/relayer.md): operating a relayer.
- [docs/deployments.md](docs/deployments.md): release pins, deploying, app configuration.
- [BENCHMARKS.md](BENCHMARKS.md): constraints, proving times, artifact sizes, gas, relayer budget.

## Development

Requires Node 22 with pnpm 10, Foundry, circom 2.2.3 for the circuits, and Docker or a host Foundry
for the end-to-end suites.

```bash
make install            # pnpm workspace
make test               # contracts, SDK, relayer, app
make circuits-restore   # compile + fetch the released keys, then: make circuits-test
make e2e                # headless suite on Anvil, real proofs, the DAVINCI round trip
make help               # everything else
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the full test suites, the circuit release pipeline and
the values that must stay identical across circuits, contracts and SDK.

## License

[GNU Affero General Public License v3.0](LICENSE).
