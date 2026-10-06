# Deployments

**Not deployed yet.** No `CouncilManager` is live on any public chain. A Sepolia deployment of the
`circuits-v1` release follows; this page will then list its addresses, the deployment block and
the pins it was checked against, and `scripts/sepolia/deployment.json` will hold the
machine-readable record. Until then the committed Sepolia configurations are placeholders:

| File | Placeholder |
|---|---|
| `ui/public/config.sepolia.json` | `manager` is the zero address, `deploymentBlock` is 0, `relayerUrl` and `artifactsBaseUrl` use the reserved `.invalid` TLD |
| `ui/.do/davinci-dkg-council-ui.yaml` | the same values as build-time variables |
| `scripts/sepolia/deployment.json` | absent: `scripts/sepolia/deploy.sh` writes it, `scripts/sepolia/run.sh` refuses to start without it |

## Circuit release

Every deployment is bound to one circuit release (protocol §4.4): the manager's immutable
`circuitReleaseId` and the code of its two verifiers. The current pins, from
`solidity/script/CouncilRelease.sol`:

> **Development setup.** `circuits-v1` is a development phase 2 (one local snarkjs contribution
> plus a beacon, `DEVELOPMENT_SETUP = true`): anyone holding its toxic waste could forge dealings
> and partials. Deploy it for rehearsals only, never for a real election. A production deployment
> needs a multi-party phase 2, which is a new release and a new manager.

| Pin | Value |
|---|---|
| circuit release | `circuits-v1` (development setup) |
| `circuitReleaseId` | `0x071a01deb1e9b5e5e1da302df14be234c5ee5b91603d7f0437852dbf1c665301` |
| sha256(`deal_vkey.json`) | `0x329f3456ac194bf8f7e07974b7f782a8bcc797e2ce37e46dc357dd3dbd442444` |
| sha256(`partial_vkey.json`) | `0xae15a6c0ab9dfe26756aef8af8d7766c8d462bbeefae0847f513a2d317ad1991` |
| DealVerifier EXTCODEHASH | `0x11846f7e14acc5efe8e7c97ebc1af97a6fab6350e631aba333715e7cb0cc9c1f` |
| PartialVerifier EXTCODEHASH | `0x8599caa2240444a17eea76d829f019a7e5844a183f469f05effeea41d867a177` |

The verifier code hashes hold for the committed `solidity/foundry.toml` (solc 0.8.28, via_ir,
`optimizer_runs = 1`, `evm_version = "cancun"`); another compiler setting is another hash, and
the deploy script refuses it. The circuit files themselves (`deal.wasm`, `partial.wasm`, both
`*_final.zkey`, both vkeys) are the `circuits-v1` GitHub release; the SDK pins their sha256 in
`sdk/src/artifacts.ts`.

## Deploying

`scripts/sepolia/deploy.sh` (`make sepolia-deploy`) deploys the two generated verifiers and the
`CouncilManager` through `solidity/script/Deploy.s.sol`, then the e2e test adapter
(`MockCouncilAdapter`, a stand-in for a DAVINCI process registry in rehearsals, whose `registry`
is the deployer), re-checks the deployment from chain state and writes
`scripts/sepolia/deployment.json`. It needs the host Foundry (`~/.foundry/bin`), `jq`, Node 22,
the workspace installed (`make install`) and the release files in
`~/.davinci-dkg-council/artifacts/`.

```bash
COUNCIL_KEY_FILE=path/to/key ETHERSCAN_API_KEY_FILE=path/to/etherscan-key make sepolia-deploy
```

| Variable | Default | Description |
|---|---|---|
| `COUNCIL_KEY_FILE` | required | File holding the funded deployer key; read at runtime, passed to forge through the environment only, never printed |
| `RPC_URL` | `https://ethereum-sepolia-rpc.publicnode.com` | Sending endpoint |
| `EXPECTED_CHAIN_ID` | `11155111` | The script refuses an endpoint serving another chain |
| `COUNCIL_ARTIFACTS_DIR` | `~/.davinci-dkg-council/artifacts` | The released files; their vkeys must equal `circuits/release/` byte for byte |
| `MANAGER` | | Skip the manager and only (re)deploy the test adapter |
| `DEPLOYMENT_OUT` | `scripts/sepolia/deployment.json` | The deployment record |
| `COUNCIL_SEPOLIA_STATE` | `~/.davinci-dkg-council/sepolia` | Local state: forge broadcast copies, relayer state, run records |
| `ETHERSCAN_API_KEY_FILE` | | Verify every contract on Etherscan (failures only warn) |

How each pin is checked:

- `Deploy.s.sol` refuses to broadcast unless both vkey files hash to the `CouncilRelease.sol` pins
  and give the pinned `circuitReleaseId`, and it checks the EXTCODEHASH of both verifiers, freshly
  deployed or reused (`DEAL_VERIFIER`, `PARTIAL_VERIFIER`), against the pins before it deploys the
  manager. Accept-all mock verifiers (`MOCK_VERIFIERS=true`) are refused off chain 31337.
- `deploy.sh` first checks that the vkeys in the artifacts cache, the files the provers use, are
  byte-identical to `circuits/release/`. After the deployment it reads `circuitReleaseId()`,
  `dealVerifier()` and `partialVerifier()` back from the manager and both verifiers' code hashes
  from the chain and compares them with the pins again, and checks that the adapter points at
  the manager.
- Clients re-read `circuitReleaseId()` through the SDK's authenticated reads (two providers, one
  agreed finalized block) before they prove anything.

The deployment costs about 12.1M gas (two verifiers, manager plus views, test adapter): 0.012 ETH
at 1 gwei. Commit the record with the addresses and update this page,
`ui/public/config.sepolia.json` and `ui/.do/davinci-dkg-council-ui.yaml` together.

## Rehearsal ceremony

`scripts/sepolia/run.sh` (`make sepolia-run`) drives one `n = 3, t = 2` ceremony against the
recorded deployment with real proofs: it builds the SDK, the relayer and the contracts, starts a
relayer locally in restricted mode (a fresh API token, a modest daily budget, its combine worker
on), and runs `scripts/sepolia/ceremony.sepolia.ts` through it with authenticated reads from two
providers. Every run writes a JSON record and a Markdown summary to `COUNCIL_SEPOLIA_STATE`. A
run costs about 11M gas (0.012 ETH at 1 gwei) and takes about an hour on Sepolia, almost all of
it finality waits. Every variable is documented at the top of the script.

Both scripts also run against a local Anvil (`EXPECTED_CHAIN_ID=31337`,
`anvil --hardfork osaka --block-time 1 --slots-in-an-epoch 4`, two RPC URLs such as
`http://127.0.0.1:PORT,http://localhost:PORT`), where a whole run takes under a minute.

## App and relayer

The app reads its deployment from `/config.json` (architecture §6). Serve it against the Sepolia
placeholders with `make ui-sepolia RELAYER_URL=https://… [ARTIFACTS_URL=https://…]`, or build an
image for a deployment:

```bash
docker build -f ui/Dockerfile --build-arg UI_CONFIG=ui/public/config.sepolia.json \
  --build-arg MANAGER_ADDRESS=0x… --build-arg DEPLOYMENT_BLOCK=… \
  --build-arg RELAYER_URL=https://… --build-arg ARTIFACTS_BASE_URL=https://… \
  -t davinci-dkg-council-ui .
```

`ARTIFACTS_BASE_URL` should point at a public mirror of the six release files that allows
cross-origin reads; with `null` the SDK fetches the GitHub release itself, which a browser can only
do while the repository is public. The pins stay in the SDK either way. The three
Sepolia `rpcUrls` are independent providers for the authenticated reads; 1rpc.io serves reads but
refuses `eth_sendRawTransaction` on its free plan, which only matters for the relayer.

Running the relayer for a deployment is covered in [relayer.md](relayer.md).
