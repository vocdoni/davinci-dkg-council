# Deployments

| Network | Circuit release | CouncilManager | Deployment block | Status |
|---|---|---|---:|---|
| Sepolia (11155111) | `circuits-v1` (development setup) | [`0x57ef5e2bc28fa120f1e5cb6dfe1b096ea06c3070`](https://sepolia.etherscan.io/address/0x57ef5e2bc28fa120f1e5cb6dfe1b096ea06c3070) | 11,856,029 | rehearsals only; one live `n = 3, t = 2` ceremony completed on 2026-10-06 |

There is no production deployment: `circuits-v1` is a development phase 2 (see
[Circuit release](#circuit-release)). `scripts/sepolia/deployment.json` is the machine-readable
record of the Sepolia deployment, which `scripts/sepolia/run.sh` reads.

The Sepolia deployment has a public app and relayer on Railway
([Hosting on Railway](#hosting-on-railway)):

| Service | URL |
|---|---|
| App | https://council-ui-production.up.railway.app |
| Relayer | https://council-relayer-production.up.railway.app (`/v1/health`) |

## Sepolia

Deployed on 2026-10-06 from `0x951163cefc22ce67f6d8b95b00a0074c4656df42` with
`scripts/sepolia/deploy.sh`, in blocks 11,856,027 to 11,856,030 (Osaka).

| Contract | Address | EXTCODEHASH | Creation tx | Gas |
|---|---|---|---|---:|
| DealVerifier | [`0x79577ec86de4ee262867ca3297a0a7c0b58792c8`](https://sepolia.etherscan.io/address/0x79577ec86de4ee262867ca3297a0a7c0b58792c8) | `0x11846f7e14acc5efe8e7c97ebc1af97a6fab6350e631aba333715e7cb0cc9c1f` | `0x5f8ecad2d1d43f945f5a88962c2ad7e40702bab0c0fe858065abc5ce50c52fe3` | 3,384,996 |
| PartialVerifier | [`0x50501fc7275742f3a52d84adcf8d0097ef0a4b40`](https://sepolia.etherscan.io/address/0x50501fc7275742f3a52d84adcf8d0097ef0a4b40) | `0x8599caa2240444a17eea76d829f019a7e5844a183f469f05effeea41d867a177` | `0x08bb6f3456ae710582a29a0edabedcb58fdd628bb16b714575be1f255bf2b576` | 2,667,240 |
| CouncilManager | [`0x57ef5e2bc28fa120f1e5cb6dfe1b096ea06c3070`](https://sepolia.etherscan.io/address/0x57ef5e2bc28fa120f1e5cb6dfe1b096ea06c3070) | `0x4da37b74b2b734457cd9f44138e8bff3f0f5d5df85179acebee5c6c94b81e63e` | `0x07f6c19143910276dd7f7f976ecd056f1b27ea10a205cd08183c32d010cb6675` | 5,572,333 |
| CouncilViews | [`0x83e192139d96c2dbf9fd4c174088aab26c6a2497`](https://sepolia.etherscan.io/address/0x83e192139d96c2dbf9fd4c174088aab26c6a2497) | `0xd34e405b901a9d02e66da91a5485ef0fd47f6f5c336a24225e68f645bd6d55e5` | created by the manager's constructor (same tx) | – |
| MockCouncilAdapter | [`0x7d439940a257fe415e4e488b49428c2e457fe34f`](https://sepolia.etherscan.io/address/0x7d439940a257fe415e4e488b49428c2e457fe34f) | `0xd862822c66c29d5d9babde9d61899f4bf6619426d34490386092e29dc4083fce` | `0x6846723894023ac306ba58b64a1e4cc2b198412608754818e93300d3fe659b9d` | 491,503 |

- **Release pins.** The manager's `circuitReleaseId()` is
  `0x071a01deb1e9b5e5e1da302df14be234c5ee5b91603d7f0437852dbf1c665301`, and both verifier code
  hashes equal the `CouncilRelease.sol` pins: `Deploy.s.sol` checked them before it deployed the
  manager, `deploy.sh` re-read them from publicnode after the deployment, and a second read from
  Tenderly agreed.
- **Source verification.** All five contracts are verified on Etherscan and on Sourcify (exact
  match, creation and runtime code); `forge verify-contract` submits to both.
- **Cost.** 12,116,072 gas, 0.012715 ETH at 0.96 to 1.10 gwei. The script took 2.1 min,
  verifications included.
- **Test adapter.** `MockCouncilAdapter` is the e2e stand-in for DAVINCI's `CouncilAdapter`. Its
  `registry` is the deployer, the only account that can bind processes and submit decryption
  requests through it. It is a rehearsal requester, not a DAVINCI integration.

### Rehearsal ceremony (2026-10-06)

The first `scripts/sepolia/run.sh` run passed all 12 checks. It used `n = 3, t = 2` and real
proofs (snarkjs in Node). The relayer ran locally in restricted mode, with a fresh API token
admitting `createCeremony`, a 0.03 ETH daily budget and its combine worker on. Authenticated reads
went to publicnode and Tenderly, pinned to the finalized block both agreed on.

| | |
|---|---|
| Ceremony | `0xe153bd9c9ac5ce6c95002a5f` |
| Process (test adapter) | `0xaaad7d84a8c0dbe73b13957d3d462374e85e2189f2957d9edf89290841b13f` |
| Request | `0xde4fd2f19f515650b18f7af0533a6d9a4c480b244168803c67409c7b46f9320a` |
| Ceremony key | `(6568588267388220366580367503688589822999969568404003529377959184714020094361, 4425131503111865310986011517196740002656603924599369180808332437202263545280)` |
| Plaintexts | `[0, 1, 123456789, 1099511627773]` (the last one is 2^40 − 3): the encrypted values, read from finalized state through both the manager and the adapter |
| Member set | `[1, 3]`. Member 1 sent its partial directly from a funded throwaway key, member 3 through the relayer, and the relayer's worker combined all four fields in one transaction |

| Step | Action | Sent via | Gas used | Gas price (gwei) | Tx |
|---|---|---|---:|---:|---|
| create | createCeremony (invites=3) | relayer | 153,444 | 1.017 | `0x8d825d49e9ed25dd66ee51c05d64bc7c7e138d4061f3d39cd90e4a3c43fdce88` |
| join | join (member 1) | relayer | 542,705 | 1.107 | `0x7a3034a1995562996aad4928ce77832ea58743dc4a4290c7813b5b6b308529e6` |
| join | join (member 2) | relayer | 541,958 | 1.045 | `0xa5fc8dba6a9229ad875c8fb23fba24297843c7f3c60f8a993601c6f8a38bbcd0` |
| join | join (member 3) | relayer | 542,665 | 1.005 | `0xbe0ca0fcbc45ab6fc3139e3e893cd6de25acd9b61751965988013735b8f5ca98` |
| close | closeRegistration (n=3) | relayer | 110,747 | 1.080 | `0x9cdfbb500bf55e7a81d54fb46d1c44041e954ea0588fa3051cdfe2a6e9eecb77` |
| deal | deal (n=3, t=2) | relayer | 1,080,566 | 1.124 | `0x8fba4d6d55119c66983cdc6be87face3511a0a2e19c2c91f35a82898b5ef3aa7` |
| deal | deal (n=3, t=2) | relayer | 1,080,606 | 1.105 | `0xe38fac50aa9ee8a7e814127960d2404a17e38c2e89f3bb36123a809c99489218` |
| deal | deal (n=3, t=2) | relayer | 1,080,570 | 1.007 | `0x9c7bdccedc05be095278fe8f18d1454f4c4582693e99f27fba6858425c94b0a1` |
| finalize | finalize (\|QUAL\|=3) | relayer | 395,138 | 1.052 | `0xd216e745d8693f4567d0671152eacab1b2e268edbc6731c4d3e54e477ab0eca7` |
| authorize | allowAdapter | relayer | 55,986 | 1.009 | `0x5c6b5d158d4c9b620d7835612b13356e1a7d932ab09f8a5783f7484f37bfa87c` |
| authorize | authorizeCreator | relayer | 56,220 | 1.069 | `0xb925252ad3b9a20ab5c4c94e4e362ef9473f4c251be3e6b82309d94eca5a8e75` |
| bind | bindProcess | adapter | 195,984 | 1.019 | `0xdf8e1b7bc2f8a9780debbec7996558e70b8138ebe76f58f8934e0e01e310a712` |
| request | submitRequest (fields=4) | adapter | 1,762,077 | 1.057 | `0x8dc66e541f8d7584d93019a6e1976be2b7b1a08dd05b0472b17ec8674f2e4189` |
| partials | fund the throwaway key (0.003 ETH) | transfer | 21,000 | 0.942 | `0xc97fd704f56d31bff0c492b1707e19bef93b6a5132b6f1cb30a9dcaaec3cb002` |
| partials | submitPartial (member 1, fields=4) | direct | 923,483 | 1.060 | `0x6169d67c82c38ca86f74e928640e699ac1e8b9039303500ee5d8dc24a9e5737e` |
| partials | submitPartial (member 3, fields=4) | relayer | 923,419 | 1.113 | `0x8da77964e1637aa96e4412ca4e9dfdc706d3596c88900cecc73589261b18a4b0` |
| combine | combine (t=2, fields=4) | relayer (worker) | 1,656,305 | 1.087 | `0xcdf21ddad5dd3bd8b592977555af017a1fef2bd9dd339bfc58d08d7dcc86c8bc` |
| cleanup | sweep the throwaway key back | transfer | 21,000 | 1.113 | `0x1bf7007741597fc89bcaa325fc771bbf101141526d8cbd608547abacf2d7cf16` |
| **total** | | | **11,143,873** | | |

Gas is within 1% of the Anvil measurements in `tests/GAS.md`. Without the adapter's two calls
and the two transfers, the ceremony and its decryption took 9.14M gas, the figure
[relayer.md](relayer.md#sizing-the-budget) budgets for. The key spent 0.011934 ETH. That figure
includes the throwaway's funding net of its sweep; 0.0000043 ETH of dust stayed on the throwaway
key.

| Step | Duration | Of which finality wait |
|---|---:|---:|
| preflight (deployment block finalized, release pin, relayer health) | 14.6 min | 14.6 min |
| create | 12.6 s | |
| join (3 members) | 49.7 s | |
| close | 18.5 s | |
| roster approval | 17.6 min | 17.6 min |
| deal (3 proofs, 1.8 to 2.8 s each) | 38.0 s | |
| finalize | 24.7 s | |
| authorize (adapter + creator) | 37.0 s | |
| bind + request | 37.4 s | |
| partials (2 proofs, 2.2 to 2.5 s each) | 18.0 min | 17.1 min |
| combine (relayer worker) | 36.5 s | |
| result | 17.6 min | 17.6 min |
| **total** | **72.4 min** | **66.9 min** |

A relayed action took 6.5 to 24.8 s from request to receipt (one or two slots). Every
authenticated read waits for the last write to be finalized, which took 14.6 to 17.6 min each
time. Sepolia finalizes in 32-slot steps about two epochs behind the head. The relayer logged two
warnings, both harmless:

- `hot key used outside the relayer`. The run's key is also the adapter's registry and the
  throwaway's funder, so the bind, request and funding moved its nonce three times. The relayer
  resynced and sent the next action on the first attempt.
- One `combiner tick failed` (`Invalid parameters`), a transient `eth_getLogs` refusal 37 s after
  the request landed. The scan cursor only advances after a complete pass, so the next tick found
  the request.

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
| `ETHERSCAN_API_KEY_FILE` | | Verify every contract on Etherscan and Sourcify (failures only warn) |

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
run costs about 11.1M gas (0.012 ETH at 1 gwei) and takes about 72 min on Sepolia, of which about
67 min are four finality waits ([the 2026-10-06 run](#rehearsal-ceremony-2026-10-06)). Every
variable is documented at the top of the script.

Both scripts also run against a local Anvil (`EXPECTED_CHAIN_ID=31337`,
`anvil --hardfork osaka --block-time 1 --slots-in-an-epoch 4`, two RPC URLs such as
`http://127.0.0.1:PORT,http://localhost:PORT`), where a whole run takes under a minute.

## App and relayer

The app reads its deployment from `/config.json` (architecture §6). The committed Sepolia
configurations point at the deployment above, but two URLs are still placeholders (the Railway
app below renders its own):

| File | Deployment | Placeholders |
|---|---|---|
| `ui/public/config.sepolia.json` | `manager` and `deploymentBlock` of the Sepolia deployment, three `rpcUrls` | `relayerUrl` and `artifactsBaseUrl`, on the reserved `.invalid` TLD |
| `ui/.do/davinci-dkg-council-ui.yaml` | the same values as build-time variables | `RELAYER_URL`, `ARTIFACTS_BASE_URL` |

A hosted app needs a public relayer and a public mirror of the circuit files. While this
repository is private, browsers cannot fetch the `circuits-v1` release assets: a mirror is
required, not optional. Serve the app against the Sepolia deployment with
`make ui-sepolia RELAYER_URL=https://… [ARTIFACTS_URL=https://…]`, or build an image for it:

```bash
docker build -f ui/Dockerfile --build-arg UI_CONFIG=ui/public/config.sepolia.json \
  --build-arg MANAGER_ADDRESS=0x57ef5e2bc28fa120f1e5cb6dfe1b096ea06c3070 --build-arg DEPLOYMENT_BLOCK=11856029 \
  --build-arg RELAYER_URL=https://… --build-arg ARTIFACTS_BASE_URL=https://… \
  -t davinci-dkg-council-ui .
```

`ARTIFACTS_BASE_URL` should point at a public mirror of the six release files that allows
cross-origin reads; with `null` the SDK fetches the GitHub release itself, which a browser can only
do while the repository is public. The pins stay in the SDK either way. The three
Sepolia `rpcUrls` are independent providers for the authenticated reads; 1rpc.io serves reads but
refuses `eth_sendRawTransaction` on its free plan, which only matters for the relayer. It also
timed out from the deployment host on 2026-10-06, so the rehearsal read through publicnode and
Tenderly only.

Running the relayer for a deployment is covered in [relayer.md](relayer.md).

## Hosting on Railway

The Sepolia app and a public relayer run on [Railway](https://railway.com), in the project
`davinci-dkg-council-sepolia` (one `production` environment), since 2026-10-06:

| Service | URL | Configuration |
|---|---|---|
| `council-ui` | https://council-ui-production.up.railway.app | `config.sepolia.json` with the relayer below; publicnode, Tenderly and 1rpc.io for the authenticated reads; the six `circuits-v1` files served by the same origin under `/circuits-v1/` |
| `council-relayer` | https://council-relayer-production.up.railway.app | open admission, combine worker from block 11,856,029, a 0.02 ETH rolling 24 h budget, CORS for the app's origin only, state on a volume at `/data` |

The relayer's hot key is
[`0x998bCda6fbb3dd0C0764F9030F7a66FA77C2d13c`](https://sepolia.etherscan.io/address/0x998bCda6fbb3dd0C0764F9030F7a66FA77C2d13c),
funded with 0.03 ETH from the deployer and used by nothing else. Sends go to publicnode, then
Tenderly; 1rpc.io only serves reads. In open mode anyone's ceremony is sponsored within the quotas
and the budget. At 1 gwei the budget covers about two `n = 3, t = 2` ceremonies with one 4-field
decryption a day (9.1M gas each, [Sizing the budget](relayer.md#sizing-the-budget)); a 16-member
ceremony does not fit, and the relayer answers `BUDGET_EXHAUSTED` once the window is spent. Watch
`balanceWei` in `/v1/health` and top the key up before it runs dry.

### Deploying

`scripts/railway-deploy-relayer.sh` and `scripts/railway-deploy-ui.sh` create or update one
service each through Railway's GraphQL API, then build its image on Railway from the committed
tree with `railway up`. Nothing is pulled from a registry, so the private repository and its
private GHCR images need no credentials on Railway. `scripts/railway-status.sh` shows each
service's latest deployment, its log tail and the relayer's health. The scripts need `curl`,
`python3`, `git` and Node 22 (`npx` fetches the Railway CLI).

1. Create a Railway token and store it in a file outside the repository (`/railway-api-key` is
   git-ignored). A workspace token works; the scripts never print it.
2. Create a project in the dashboard, or with the `projectCreate` mutation, and note its id and
   the id of its `production` environment.
3. Generate a hot key for the relayer, store it as `0x` plus 64 hex digits in a file with mode
   `0600`, and fund it.
4. Deploy the relayer, then the app:

```bash
export RAILWAY_TOKEN_FILE=railway-api-key
export RAILWAY_PROJECT_ID=<project id> RAILWAY_ENVIRONMENT_ID=<environment id>
COUNCIL_KEY_FILE=~/.davinci-dkg-council/sepolia-relayer.key scripts/railway-deploy-relayer.sh
scripts/railway-deploy-ui.sh
scripts/railway-status.sh
```

The first relayer run also creates the app's service and domain, so that `COUNCIL_CORS_ORIGINS`
can name it; the app's build reads the relayer's domain into `relayerUrl`. Both scripts take the
manager and the deployment block from `scripts/sepolia/deployment.json`. Running either again
deploys the current `HEAD` (`GIT_REF` picks another commit; uncommitted changes are not deployed)
with the variables it sets. Each script documents its overrides at the top: `RPC_URLS`,
`DAILY_BUDGET_WEI`, `CORS_ORIGINS` and `EXTRA_VARS` (any other `COUNCIL_*` setting) for the
relayer; `UI_CONFIG`, `RPC_URLS`, `RELAYER_URL` and `COUNCIL_ARTIFACTS_DIR` for the app. The key
reaches Railway only inside a request body, as the `COUNCIL_PRIVATE_KEY` service variable; `railway
up` runs with a project token created for the upload and deleted afterwards.

### What the scripts adapt

- **Build context.** Each upload is a `git archive` of the packages its image needs, with the
  Dockerfile at its root. Railway refuses the `VOLUME` instruction and cache mounts outside its own
  id scheme, so the relayer's `VOLUME /data` and the app's pnpm cache mount are dropped from those
  copies; the relayer gets a Railway volume at `/data` instead.
- **Port and health check.** Railway's edge and health check connect to `$PORT`: 8080 for the
  relayer, whose health check is `/v1/health` (it reads the chain, so a deployment whose RPCs do
  not answer never takes traffic), and 80 for nginx.
- **Volume ownership.** Railway mounts volumes as root, so the relayer runs with
  `RAILWAY_RUN_UID=0`.
- **One replica.** The relayer allocates its key's nonces locally; never scale it out.
- **Client addresses.** Railway's edge drops any `X-Forwarded-For` a client sends and forwards
  `<client>, <edge>` from `100.64.0.0/10`. `COUNCIL_TRUSTED_PROXIES=0.0.0.0/0,::/0` makes the
  relayer charge the left-most hop, the real client; with `100.64.0.0/10` alone it would charge
  every client to the edge's address and share one rate limit among them.
- **Circuit files.** `railway-deploy-ui.sh` copies the six files from `COUNCIL_ARTIFACTS_DIR`
  into the image after checking each against its pin in `sdk/src/artifacts.ts`, and sets
  `artifactsBaseUrl` to `/circuits-v1`. The browser downloads them from the app's own origin, so
  the CSP needs no new origin and no CORS mirror is involved; the SDK still checks every byte
  against the same pins. `ui/nginx.conf` answers a missing circuit file with 404 instead of the
  app's index page.

### Cost

On 2026-10-06 the relayer used about 160 MB of memory and 0.003 vCPU at rest, the app about 40 MB
and no measurable CPU. At Railway's usage prices that is about $2 a month for both, within the
Hobby plan's included usage, plus egress: a new browser downloads about 78 MB of circuit files
once (then they come from its cache), about $0.004 per participant. The relayer's state file is a
few hundred KB on its volume.
