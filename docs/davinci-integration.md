# Building on DAVINCI with a Council key

A builder's guide: how a product runs a DAVINCI election whose results only a Council committee
can decrypt, with `@vocdoni/davinci-sdk` and `keyMode: 'council'`. It covers what the product
needs, the Gnosis deployment this was proven on, what voters and organizers see on the way to
the results, a minimal end-to-end example taken from a working run, and how the DAVINCI
Elections pairing connects a committee to an Elections organization.

> **Production beta, development trusted setup.** The Council manager on Gnosis is the production
> beta (hosted app https://council-gnosis-ui-production.up.railway.app, relayer
> https://council-gnosis-relayer-production.up.railway.app). It runs on `circuits-v1`, a
> **development** trusted setup (one-party phase 2: whoever holds its toxic waste can forge
> dealings and partial decryptions), which the owner accepted for the beta; the app says so on
> every page. The runs below used a test DAVINCI registry and the then unreleased `council`
> branches of davinci-contracts, davinci-sdk and davinci-sequencer. [Known limits](#known-limits)
> lists what the beta still lacks.

## How it fits together

A Council ceremony produces one BabyJubJub ElGamal key held by `n` invited members, any `t` of
whom can decrypt. A DAVINCI process created with `keyMode: 'council'` and that ceremony's id
uses the ceremony key as its encryption key: ballots are encrypted under it, the sequencers
aggregate them homomorphically and prove every state transition, and at the end the committee
decrypts only the final tally, never a ballot.

```
Council organizer:  create ceremony ─► members join ─► close ─► members deal ─► Live
                    ─► allowAdapter(registry.councilAdapter()) ─► authorizeCreator(product's address)
Product (davinci-sdk): createProcess({ keyMode: 'council', ceremonyId }) ─► voters submitVote
                    ─► end ─► grace window
Sequencer:          requestResultsDecryption (the ceremony's gate may still be closed: 'awaiting-opening')
Council:            opening (organizer, or a date) ─► t members post partials ─► relayer combines
Sequencer:          finalizeResultsFromDKG ─► the tally is on chain ─► waitForResults returns it
```

The registry talks to the Council manager through its `CouncilAdapter` (created by the
registry's constructor, `registry.councilAdapter()`); the adapter binds each process to the
ceremony (`bindProcess`, which checks the ceremony allows the adapter and the creator) and later
submits the encrypted tally as a Council decryption request (`submitRequest`). Nothing else in
DAVINCI changes: census, ballots, sequencers, the grace window and the result layout are those
of any process. The Council side is documented in [protocol.md](protocol.md) §8.7 and §9 and
[architecture.md](architecture.md) §3.

## What a product needs

| Piece | What | Who runs it |
|---|---|---|
| A Live Council ceremony | the key; its decryption opening policy is fixed at creation | the committee's organizer, with the Council app or `@vocdoni/davinci-dkg-council-sdk` |
| Two grants on that ceremony | `allowAdapter(registry.councilAdapter())` and `authorizeCreator(<the address that calls createProcess>)`, both irreversible for the ceremony | the organizer (app "Authorize" screen, or a signed action) |
| A DAVINCI registry with Council support | davinci-contracts `ProcessRegistry` deployed with a Council manager | Vocdoni (the [test registry](#the-test-deployment-on-gnosis) for now) |
| Sequencer nodes for that registry | davinci-sequencer with `KeyMode::Council` | Vocdoni or the product |
| `@vocdoni/davinci-sdk` with `keyMode: 'council'` | process creation, votes, results | the product |
| Census and metadata hosting | an `Uploader` that serves the files over public `https` | the product |
| A Council relayer | forwards members' signed actions and runs the combine step | the committee (any relayer works; anyone may also send directly) |
| `t` members on opening day | each unlocks the results with one browser proof | the committee |

Two rules bind the order of operations:

- The ceremony must be **Live and grant the adapter and the creator before `createProcess`**,
  or the creation fails at simulation with the manager's `NotAllowedAdapter` /
  `NotAuthorizedCreator` and nothing is sent.
- **One ceremony is one privacy domain and one opening.** Every process bound to a ceremony
  shares its key, its `t`-collusion boundary and its single, ceremony-wide opening
  ([organizer-guide.md](organizer-guide.md#one-committee-per-privacy-domain)). Processes that
  must open independently need separate ceremonies.

## Scheduled vs manual opening

The ceremony's decryption policy ([protocol.md](protocol.md) §8.7) decides when the committee
may decrypt, for every process bound to it. It is set once, at ceremony creation:

- **Scheduled** (`decryptionMode = Scheduled`, `decryptionOpenAt`): the gate opens by itself at
  that date; no transaction, nobody's presence. It cannot be moved or accelerated. Pick a date
  after the vote's end plus the grace window, with margin for finality.
- **Manual with a fallback** (`decryptionMode = Manual`, `manualDecryptionFallbackAt`): the
  organizer opens it with one signed `openDecryption` whenever the election is over; if the
  organizer cannot, the fallback date opens it anyway. This is the recommended default.

Either way the gate is **policy, not a time lock**: any `t` colluding members can decrypt off
chain earlier. Before the gate opens, the sequencer still requests the decryption as soon as the
grace window closes (the request is admitted while closed), the contract refuses partials and
combines (`DecryptionNotOpen`), and the registry refuses to publish even an all-zero tally.
Opening is ceremony-wide and irreversible: one `openDecryption` unlocks every pending and future
request of the ceremony.

## What voters and organizers see

`sdk.getResultsStatus(processId)` (and `waitForResults`' `onStatus`) reports, for a council
process:

| State | Meaning | Who acts |
|---|---|---|
| `voting` | the process takes votes | voters |
| `grace` | ended; late batches may still land; results unlock when the window closes (`graceEnd`) | sequencers settle |
| `awaiting-opening` | the ceremony's gate is closed; `decryptionOpening` says how it opens: `{ mode: 'scheduled', opensAt }`, or `{ mode: 'manual', opensAt: <fallback date or null> }` | the organizer (manual) or the clock (scheduled); the sequencer has usually already requested the decryption |
| `decrypting` | the gate is open at the chain head; members post partial decryptions once a finalized block shows it open (3–4 min later on Gnosis) | `t` members (the Council app's "Unlock requests", or the SDK) |
| `finalizable` | the committee's plaintexts are complete; the first `finalizeResultsFromDKG` stores them | a sequencer, within seconds (or anyone: `finalizeResults`) |
| `results` | the tally is on chain; `results` carries it decoded per question | everyone |

Voters see nothing Council-specific until the end: they vote with `submitVote` exactly as on
any process. After the end, a product should show the opening date (`decryptionOpening.opensAt`)
rather than a countdown; dates take effect at an included, then finalized, block, so plan for
minutes of lag, not seconds. A tally of zeros (no votes) also waits for the opening.

Members see every process bound to the ceremony in the Council app's "Unlock requests" from its
creation (read from chain state, its binding authenticated), marked as waiting until the
sequencer submits the tally. The app refuses to compute a partial until a finalized snapshot
shows the gate open; in live mode it then unlocks by itself.

## The test deployment on Gnosis

Chain id 100. Council v2, `circuits-v1` DEVELOPMENT setup (the manager is now the production
beta, [deployments.md](deployments.md#gnosis-chain-production-beta)); a test DAVINCI registry
from davinci-contracts `council` at `f4abc5d` (record: [`scripts/davinci-gnosis/deployment.json`](../scripts/davinci-gnosis/deployment.json)).
The production DAVINCI registry that binds this manager replaces the test registry for the beta;
its addresses belong in davinci-contracts' deployment records.

| | Address | Since block |
|---|---|---|
| CouncilManager | `0x2f5b110864cbad4017fe8ac59111812278f5f71f` (views `0xb6011a651bb8495a837dd9723e6e1f8fea797fcc`, ops `0x0d5bab4c31bf49da98a386588085e354bd644b47`) | 48,627,018 |
| ProcessRegistry | `0x847a16CC56E0Ef57FEc28735105941a0299cDC62` | 48,627,101 |
| its CouncilAdapter | `0x4817493b792db101dcc75306754242ceFd928E40` | (created by the registry) |
| its DavinciDKGAdapter | `0x9d356d42eC5a04ABeaDA1AE31D83Eb431f120958` (davinci-dkg `0x9999F38F…c01B`) | |
| ZiskVerifier | `0x150547716bD6f15D872508b66b2ae7ce17677C9C` (the production one, reused) | |

The registry carries the production pins (batch and results program vks, `rootCVadcopFinal`,
`ballotVKHash`, the verifier's code hash) and grace settings (default 180 s, floor 150 s, ceiling
600 s, max total 1800 s, notice 60 s), so released provers and the davinci-sdk release checks
accept it (`verifyDeployment` passes). The registry and both adapters are source-verified on
Gnosisscan and Blockscout.

- RPCs: `https://gnosis-rpc.publicnode.com`, `https://rpc.gnosischain.com`,
  `https://gnosis.drpc.org`; beacon API (blobs) `https://rpc-gbc.gnosischain.com`. The Council
  SDK's authenticated reads need at least two independent providers that agree on the finalized
  block.
- Sequencer: a test node, `davinci-sequencer-council-test`, runs on Vocdoni's prover host
  (`127.0.0.1:9095` there); it is **not publicly reachable**. Run your own against the registry
  ([below](#running-a-sequencer-for-the-test-registry)).
- Council app and relayer: https://council-gnosis-ui-production.up.railway.app and
  https://council-gnosis-relayer-production.up.railway.app (open admission, combine worker on;
  [deployments.md](deployments.md#gnosis-production-beta-2026-10-07)). The runs below used their
  own local relayer (`scripts/davinci-gnosis/relayer.sh`); any relayer for the manager works.

The SDK network config:

```ts
const network = {
  name: 'gnosis (Council test registry)',
  chainId: 100,
  processRegistry: '0x847a16CC56E0Ef57FEc28735105941a0299cDC62',
  startBlock: 48_627_101,
  rpcUrls: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com', 'https://gnosis.drpc.org'],
};
```

## Minimal end-to-end example

Condensed from [`scripts/davinci-gnosis/roundtrip.gnosis.ts`](../scripts/davinci-gnosis/roundtrip.gnosis.ts),
which ran it on the test deployment ([measured run](#measured-run-2026-10-07)). The ceremony
steps use the Council SDK the way the app does; in a product the organizer and the members do
them in the Council app instead.

**1. The ceremony grants the registry's adapter and the product's creator address.** Signed by
the organizer's derived key and sent through a relayer (the app's "Authorize" screen does the
same):

```ts
import { DavinciSDK, FailoverRpcProvider, OffchainCensus, type Uploader } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';
import { accountFromSecret, RelayerClient, signAction, type Hex } from '@vocdoni/davinci-dkg-council-sdk';

// Census files and metadata documents, served unchanged over public https (your storage).
const uploader: Uploader = { upload: ({ data, sha256 }) => publishFile(`${sha256.slice(2)}.json`, data) };

const organizer = new Wallet(PRODUCT_KEY, new FailoverRpcProvider(network.rpcUrls, network.chainId));
const sdk = new DavinciSDK({ signer: organizer, network, sequencerUrls: [SEQUENCER_URL], uploader });
await sdk.init(); // checks the registry pins and the nodes' /info

const adapter = (await sdk.registry.getCouncilAdapter()) as Hex; // 0x4817…8E40 on the test registry
const relayer = new RelayerClient(RELAYER_URL);
const grant = async (type: 'AllowAdapter' | 'AuthorizeCreator', message: Record<string, unknown>) => {
  const kind = type === 'AllowAdapter' ? 'allowAdapter' : 'authorizeCreator';
  const signature = await signAction(accountFromSecret(orgKey.secret), 100n, MANAGER, type, message as never);
  return relayer.relay(100n, MANAGER, { kind, message, signature } as never);
};
const validUntil = BigInt(Math.floor(Date.now() / 1000) + 3600);
await grant('AllowAdapter', { ceremonyId, adapter, validUntil });
await grant('AuthorizeCreator', { ceremonyId, creator: organizer.address as Hex, validUntil });
```

(`orgKey` is the organizer's derived signing key, `organizerAuthKey(rootFromMnemonic(words),
{ chainId, manager })`.)

**2. The product creates the process.** Only `keyMode` and `ceremonyId` are Council-specific:

```ts
const census = new OffchainCensus();
census.add(voterAddresses);
const { processId } = await sdk.createProcess({
  title: 'Rate the proposals',
  census,
  electionPreset: { type: 'rating', maxValue: 5 },
  questions: [{ title: 'Rate each proposal (0 to 5)', choices: [
    { title: 'Bike lanes', value: 0 }, { title: 'Library hours', value: 1 }, { title: 'Tree planting', value: 2 },
  ] }],
  timing: { duration: 3 * 3600 },
  keyMode: 'council',
  ceremonyId, // bytes12 hex
});
const p = await sdk.registry.getProcess(processId);
// p.encryptionKey is the ceremony key; p.dkg.epochId is the ceremony, p.dkg.aid the Council request id.
```

**3. Voters vote**, each with their own SDK instance (a bare wallet is enough):

```ts
const voter = new DavinciSDK({ signer: voterWallet, network, sequencerUrls: [SEQUENCER_URL] });
await voter.init();
const { voteId } = await voter.submitVote({ processId, choices: [1, 2, 3] });
await voter.waitForVoteStatus(processId, voteId); // pending > aggregated > processed > settled
```

**4. The process ends and the results arrive** once the committee has decrypted:

```ts
await sdk.endProcess(processId); // or let `timing` run out
const results = await sdk.waitForResults(processId, {
  timeoutMs: 24 * 3600_000, // a council opening can be much later than the grace end
  onStatus: (s) => {
    if (s.state === 'awaiting-opening') showOpening(s.decryptionOpening); // { mode, opensAt }
  },
});
console.log(results.values); // one total per field, e.g. [8n, 4n, 6n]
```

**5. Meanwhile, on the Council side**: for a manual ceremony the organizer opens decryption
(`openDecryption`, one signed action, the app's "Decryption" screen), or a scheduled ceremony
opens by date; then `t` members unlock the request from the app's "Unlock requests" (or, with the
SDK, recover their share and build a proven partial against an authenticated snapshot, as
`Member.partial` in `tests/src/actors.ts` does) and the relayer's combine worker completes it.
The sequencer then stores the tally (`finalizeResultsFromDKG`); `waitForResults` resolves.

Census files and metadata documents go through the `uploader` the product passes to the SDK; it
must return a public `https` URL that serves the bytes unchanged, with no redirect, because
sequencer nodes download the census at process creation and refuse private hosts.

## Measured run (2026-10-07)

`scripts/davinci-gnosis/run.sh`, run 2026-10-07 03:10–04:02 UTC: all checks passed. Two n = 3,
t = 2 ceremonies on the test manager, three processes on the test registry through the test
sequencer, real proofs everywhere (Council dealings and partials, DAVINCI ballots, zkVM state
transitions on the shared GPU prover). Every tally was read back through `waitForResults` and
checked against the ballots, and through the Council SDK's authenticated `getPlaintexts`.

| | Ceremony A (manual opening) | Ceremony B (scheduled opening) |
|---|---|---|
| id | `0xf25b9d9fc77e500bc9a76859` | `0x7f7d84cb078ef80b507fc10c` |
| policy | Manual, fallback 2026-11-06 03:10 UTC | Scheduled, 2026-10-07 03:55:05 UTC |
| create → Live and granted | 14.2 min (both in parallel; two finality waits of 3–4 min, the dealings' fee bumps) | 14.9 min |
| opening | `openDecryption` `0x98f6073c…4adefc` (block 48,628,549) | by date, no transaction |

| Variant | Process | Votes | Path to the results | Tally (expected and stored) |
|---|---|---|---|---|
| (a) manual opening | `0x654b…0715356300000000000003` on A, rating 0–5 × 3 | 3, each settled 140 s after the cast (one 3-vote transition `0xb3dc8445…09ec69`) | ended `0xe6f188ff…ea805b`; request while closed `0x4d2c4b4c…bc9343`, 3.4 min after the end (grace + confirmations); organizer opened 9 s later; gate open in a finalized snapshot after 3.8 min; partials of members 1 and 3 `0x71765a66…a0ad93`, `0x1cae62fb…e49318`; combine `0xcfc525f6…0bdc84`; results `0x60f78142…386c08`, **4.8 min after the opening** | `[8, 4, 6]` |
| (c) zero votes | `0x654b…0715356300000000000004` on A | 0 | ended at once `0xb2289de6…f5c27d`; request `0x7a2b5f35…1998b2` carried no ciphertext (no Council request, `fieldCount` 0) and left the process ENDED; the sequencer published the zeros `0x97d57869…9bb96a` **1.3 min after A opened** | `[0, 0, 0]` |
| (b) scheduled opening | `0x654b…0715356300000000000005` on B, single choice × 3 | 3, settled after 155 s (`0xcb9bce20…1e4d57`) | ended by its date, 7 min before the opening; request while closed `0xfe6fb267…a33289`, 3.7 min before the opening; gate open in a finalized snapshot 3.4 min after the date; partials of members 2 and 3 `0x633e43d4…b9f783`, `0xa4aa8f30…8dee7f`; combine `0x1822671b…4588ed`; results `0xde5dafa9…3f2fd5`, **4.4 min after the opening** | `[1, 0, 2]` |

`waitForResults` reported `voting > grace > awaiting-opening > decrypting > finalizable > results`
for (a) and (b), and `voting > grace > awaiting-opening > finalizable > results` for (c); a
sampler confirmed that each request landed while the state was `awaiting-opening`. Ballots were
proven in 2–3.5 s each in Node, dealings and partials in 2–5 s; a 3-vote zkVM transition took
about 32 s on the prover. Full process ids, request ids, every transaction with its gas, the
sampled states and the timings are in the run record,
[`scripts/davinci-gnosis/run-2026-10-07.json`](../scripts/davinci-gnosis/run-2026-10-07.json).

Gas at Gnosis' 11–14 wei base fee is negligible: the relayer paid 29 transactions (15.5M gas,
including two combines of 1.26M and 0.78M) for 4.6e-6 xDAI after its fee bumps; the process
creator 5 (2.7M gas: creations 0.84–0.88M, ends 41k); the sequencer 8 (4.0M gas: settlements
445k, requests 1.28M with ciphertexts and 111k without, finalizations 93–176k). The only real
cost is blob gas: each settlement carries one blob at Gnosis' 1 gwei blob fee floor, 1.3e-4 xDAI,
so the sequencer spent 2.6e-4 xDAI for the run.

## Running a sequencer for the test registry

The node must be a davinci-sequencer build of the `council` branch (released images do not know
key mode 3 and ignore such processes). Built from the directory holding `davinci-sequencer/` and
`davinci-zkvm/` (`davinci-sequencer/Dockerfile`), the test node runs as:

```bash
docker run -d --name davinci-sequencer-council-test --restart unless-stopped \
  --user "$(id -u):$(id -g)" -p 127.0.0.1:9095:9090 \
  -v ~/.davinci-gnosis/sequencer-council-test/data:/data \
  -v ~/.davinci-gnosis/keys/seq-council-test.key:/run/secrets/sequencer_key:ro \
  -e DAVINCI_NETWORK=custom \
  -e DAVINCI_REGISTRY=0x847a16cc56e0ef57fec28735105941a0299cdc62 \
  -e DAVINCI_START_BLOCK=48627101 \
  -e DAVINCI_RPC_URL=https://gnosis-rpc.publicnode.com,https://rpc.gnosischain.com,https://gnosis.drpc.org \
  -e DAVINCI_BLOB_SOURCE=beacon:https://rpc-gbc.gnosischain.com \
  -e DAVINCI_CONFIRMATIONS=3 \
  -e DAVINCI_PROVER_URL=http://<davinci-zkvm prover>:8080 \
  -e DAVINCI_PRIVKEY_FILE=/run/secrets/sequencer_key \
  -e DAVINCI_CENSUS_ALLOW_PRIVATE=true \
  -e DAVINCI_BATCH_TIME=2m \
  davinci-sequencer:council-test
```

Its key pays settlements, decryption requests and finalizations (a few transactions per process
at Gnosis' fee level; fund it with a fraction of an xDAI). At boot it checks the registry's pins
against the davinci-zkvm release it was built with and stops on any difference, so the prover
must run the same release. `DAVINCI_BATCH_TIME=2m` only shortens batching for tests (default
15 min).

`DAVINCI_CENSUS_ALLOW_PRIVATE=true` is there because the run served its census and metadata from
a plain HTTP server on the Docker bridge (`http://172.17.0.1:8099`, with
`documents: { allowPrivateHosts: true }` in the SDK): there was no public host to commit them to.
A product does not do this; it gives the SDK an `uploader` backed by public `https` storage and
the nodes keep refusing private hosts.

## Reproducing the run

`scripts/davinci-gnosis/` holds the run: `relayer.sh start` starts a restricted-mode Council
relayer (its own hot key, combine worker on), and `run.sh` runs `roundtrip.gnosis.ts` through the
e2e package's vitest, reusing the e2e actors (`tests/src/actors.ts`) for the organizer and the
members. It needs the sequencer above, a file server for `DAVINCI_FILES_DIR`, a built davinci-sdk
`council` checkout (`DAVINCI_SDK_DIR`), the pinned Council circuit files
(`COUNCIL_ARTIFACTS_DIR`) and a funded process-creator key (`DAVINCI_ORGANIZER_KEY_FILE`). Each run
writes a record (`run-*.json`, addresses, hashes, states, timings) and a 0600 secrets file with
the recovery phrases and voter keys to `COUNCIL_RUN_DIR`; `COUNCIL_RESUME=<secrets file>` reruns
the DAVINCI part on Live ceremonies of an earlier run.

## DAVINCI Elections pairing

DAVINCI Elections offers a Council committee as one way to hold an election's key. The Council
app implements its side of the pairing (the Elections pairing API, version 1); the security rule
throughout is that **nothing in a link or an API response ever picks the origin, the registry or
the adapter** — those come from the app's pinned configuration and from chain.

- **Configuration.** `config.json`'s optional `davinci` object pins the connection:
  `{ "registry": "0x…", "electionsOrigins": ["https://elections.davinci.vote"] }` — the DAVINCI
  ProcessRegistry and the allowlisted Elections servers (bare `https` origins only; `http` only
  in dev mode). `DAVINCI_REGISTRY` and `ELECTIONS_ORIGINS` in `scripts/render-ui-config.sh` set
  them; a zero registry validates and leaves the whole connection off (for deployments without
  an Elections server — the committed Gnosis config pins the production registry). The adapter is **always** read on
  chain as the pinned registry's `councilAdapter()`, cross-checked against `adapter.manager()`.
- **The deep link is cosmetic.** `/new?davinci=v1&label=…` opens the create form with `label` as
  the local display name (collapsed, trimmed, 80 chars) and marks the draft as started for
  Elections, so the dashboard later points at the pairing step. Every other parameter is
  ignored — never an address, never a return URL, never a code.
- **Pairing by one-use code.** Once the committee is Live, the organizer dashboard's "Connect to
  DAVINCI Elections" card takes a pairing code (Crockford base32, `XXXX-XXXX-XXXX`, typed by
  hand — never read from a URL, never logged). The app resolves it only at a pinned origin
  (`GET /api/public/council-pairing/{code}`, `credentials: 'omit'`, `redirect: 'error'` — a
  redirect could let another server answer for the pinned origin), then fails closed before
  any grant: protocol version, `chainId`, `manager`, `registry` against the pinned config, the
  response's `adapter` against the on-chain read, a non-zero `creator`. Any mismatch shows one
  plain "different voting network" error and nothing is sent.
- **Confirmation and grants.** The organizer confirms the organization by name, the committee
  fingerprint and the creator address (an irreversible act, as on the generic Connections card,
  which stays unchanged for manual grants). The app then signs `allowAdapter(<on-chain adapter>)`
  and `authorizeCreator(<resolved creator>)`, skipping any grant already on chain or already in
  flight (so a retry with a fresh code is idempotent — a sent-but-unconfirmed grant counts as
  waiting, never as done), waits until the finalized state it reads at shows **both** grants,
  and only then reports the ceremony id back (`POST …/{code}/complete`, `redirect: 'error'`,
  which consumes the one-use code). A grant the relayer rejects is retryable without re-sending
  the one that landed; a completion whose response was lost is simply retried, since the grants
  are already on chain. The success screen links back to Elections only through the pinned
  origin and an allowlisted `returnPath` shape.
- **Elections trusts nothing it is sent**: it verifies a committee on chain (phase,
  `isAdapterAllowed`, `isCreatorAuthorized` for its own creator address, policy) before using it.
  It needs no relayer access and no CORS entry: the app already registers every committee it
  creates with its relayers (`POST /v1/track`, signed by the organizer), so the combine worker
  serves its requests.

## Known limits

- **Development trusted setup.** The test manager pins `circuits-v1`, a one-party phase 2: its
  operator can forge any dealing or partial, so the test deployment protects nothing. Production
  needs the multi-party phase-2 release (`circuits/scripts/ceremony/`), a new CouncilManager
  pinned to it, and a DAVINCI registry deployed against that manager.
- **Unreleased code on every side.** davinci-contracts, davinci-sdk and davinci-sequencer carry
  the Council mode on local `council` branches; the Council repository and its circuit release
  are private and unpublished (the app needs a public mirror of the circuit files). Production is
  a coordinated release: the registry redeploy, a davinci-sequencer release, and a **davinci-sdk
  major release published before the first mode-3 process exists on any chain its users index**
  (older SDKs throw `unknown key mode 3` on such a process).
- **The test sequencer is private** and serves this run only; the census of the test processes
  was hosted on a private address (see above). The hosted Council app and relayer are one
  Railway project with no standby yet ([hosting.md](hosting.md)).
- **Relayer sends on Gnosis.** In one rehearsal the Council relayer's dealing transactions
  (≈1.2M gas) waited one to three minutes and up to five automatic fee bumps for inclusion; in
  the final run none needed a bump. publicnode refused most of the relayer's
  `eth_sendRawTransaction` calls ("Request exceeds defined limit") and the relayer fell back to
  the next RPC each time. Neither failed a run; both can slow a ceremony.
- **Finality is part of every Council step**: authenticated reads pin the finalized block, about
  three to four minutes behind the head on Gnosis, so closing, dealing, and each partial after an
  opening wait for it.
- The opening is policy, not a time lock, and one ceremony is one opening and one privacy domain
  (above).
