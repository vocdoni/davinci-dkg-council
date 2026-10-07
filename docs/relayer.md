# Running a relayer

The relayer pays for Council. Participants sign every action (EIP-712) in the browser and never
hold funds; the relayer simulates each signed action, sends it from one hot key, sends the due
permissionless phase transitions of the ceremonies it serves (the scheduler), and runs the public
combine step that turns `t` partial decryptions into plaintexts. It is a convenience, not a
trusted party: it can neither forge nor alter a signed submission (signatures, proofs and payload
hashes bind every byte), and every action it sends can be sent directly from any funded account.
An SDK client can switch to another relayer by itself; the app's users cannot (the production app
has one relayer URL in its `config.json`), so replacing a dead relayer means the operator
pointing the app's configuration at a standby one. The HTTP API is in
[architecture.md](architecture.md) §5. This guide describes the relayer for protocol v2
(`protocolVersion() == 2`); a relayer serves one manager.

## Requirements

- 1 core and 512 MB of RAM. The combine worker builds its baby-step/giant-step table (2^20 entries
  by default) in about 3 s and keeps it in memory; a process holding it peaks near 200 MB, and the
  worst-case 40-bit plaintext takes about 3.3 s to find (BENCHMARKS.md).
- A hot key funded with the chain's native currency, used by nothing else. The relayer allocates
  nonces locally; another sender on the same key costs it a resync and a warning each time.
- At least two JSON-RPC endpoints. Reads fall back in order, and a broadcast walks them in order
  until one accepts the transaction.
- A persistent directory for its state file (bounded: usually well under 1 MB, see "State") and
  its partial-data cache (about 40 KB per request it is combining, removed once the request is
  complete).

## Installing

**Docker** (recommended). The image is `ghcr.io/vocdoni/davinci-dkg-council-relayer`; `latest`
follows the newest stable release.

```bash
docker run -d --name council-relayer --restart unless-stopped -p 8080:8080 \
  -v council-relayer:/data \
  -e COUNCIL_RPC_URL=https://rpc-a.example,https://rpc-b.example \
  -e COUNCIL_MANAGER_ADDRESS=0x… \
  -e COUNCIL_PRIVATE_KEY=0x… \
  -e COUNCIL_COMBINER_ENABLED=true \
  -e COUNCIL_SCHEDULER_ENABLED=true \
  -e COUNCIL_START_BLOCK=<deployment block> \
  -e COUNCIL_CORS_ORIGINS=https://council.example \
  ghcr.io/vocdoni/davinci-dkg-council-relayer
```

The image runs as the `node` user, keeps its state on the `/data` volume and listens on 8080.

**From source** (Node 22, pnpm 10):

```bash
make install relayer
COUNCIL_RPC_URL=… COUNCIL_MANAGER_ADDRESS=0x… COUNCIL_PRIVATE_KEY=0x… node relayer/dist/main.js
```

`make relayer-docker` builds the image locally. Put a TLS-terminating proxy in front of either
and list it in `COUNCIL_TRUSTED_PROXIES`.

**Railway.** `scripts/railway-deploy-relayer.sh` builds the image on Railway and sets up the
service, its volume, domain and variables (the combine worker and the scheduler on); the public
Sepolia relayer runs this way ([Hosting on Railway](deployments.md#hosting-on-railway)). No
secret it handles (the workspace token, the hot key, the short-lived project token) is ever a
process argument; `scripts/railway-deploy-relayer.test.sh` checks both against a fake Railway
API.

## What it pays for

Every action is simulated with `eth_call` first; a reverting one is refused with
`SIMULATION_REVERTED` and costs nothing. The points the contract keeps compressed never travel on
the wire: the relayer rebuilds the roster (both closes, deal), `C1` (submitPartial) and `C2`
(combine) from the stored words before simulating, and the contract authenticates every one of
them, so a wrong rebuild can only fail simulation. Each word is decoded strictly (the SDK codec
refuses bit 254, `x ≥ p`, non-residues and an odd parity on a zero root) and must give a
prime-subgroup, non-identity point, as everything the contract stores is; a word that does not
(a corrupted or hostile RPC answer) is refused for that action (`INTERNAL`), never cached, and
never searched by the combine worker, which retries the request after its backoff. Beyond that, spending is bounded on four
levels.

1. **Global budget.** A rolling 24 h wei budget for the hot key (`COUNCIL_DAILY_BUDGET_WEI`).
   Each transaction reserves its worst case (gas limit × max fee) when sent, is charged its
   actual cost when its receipt appears, and keeps the rest of its worst case reserved until its
   block is finalized (a reorg may replay it). When the budget is used up, sponsorship stops with
   `BUDGET_EXHAUSTED` (503) until spend leaves the window. The combine worker and the scheduler
   spend from the same budget. Only verified answers release a reservation: a receipt or
   transaction lookup that fails is "unknown", never "not found", so an RPC outage can delay the
   accounting but never let a mined transaction go uncharged (see "Hot key").
2. **One-shot slots.** Each action names the protocol state it consumes: the ceremony (create),
   an invite id, a participant and a key (join), the phase transition (either close, finalize,
   abort), the opening (openDecryption), a dealer (deal), an adapter or creator (grants),
   `(request, member)` (partial, and separately re-publication), `(request, field)` (combine).
   From acceptance until the transaction settles, an identical submission returns the pending
   transaction hash — a browser's `closeRegistrationScheduled` and the scheduler's share one
   transaction — and a conflicting variant (other expiry, signature, member set, …) is refused
   with `CONFLICT` (409) instead of being paid for as a certain revert.
3. **Per-ceremony quotas**, from the protocol bounds, counting sponsored transactions (charged
   only after a successful simulation, undone if the broadcast fails, persisted):

   | Quota | Limit |
   |---|---|
   | createCeremony, finalize, abort, openDecryption | 1 each per ceremony |
   | close (closeRegistration or closeRegistrationScheduled) | 1 per ceremony, whichever path |
   | invites (createCeremony + addInvites) | 64 per ceremony (`MAX_INVITES`) |
   | join, deal | 16 each per ceremony (`MAX_N`) |
   | allowAdapter + authorizeCreator | `COUNCIL_MAX_GRANTS` per ceremony |
   | submitPartial | n per request |
   | publishPartialData | 2 × n per request, and only when the data is missing (below) |
   | combine | 2 × fieldCount fields per request (each field once, plus one retry) |

   Exceeded: `QUOTA_EXCEEDED` (429). The per-ceremony rate (`COUNCIL_CEREMONY_RATE_LIMIT`) is
   also charged only after a successful simulation, so failing requests cannot exhaust a
   ceremony's budget; they are charged to their source IP instead. The scheduler and the combine
   worker are not rate-limited, but they spend from the same quotas: a transition the scheduler
   paid for is never paid for again, whoever asks.

   **Re-publication** (`publishPartialData`, protocol §10.4) is sponsored only for an incomplete
   request whose member vector the relayer cannot source itself: when it holds an authentic copy
   in its cache, or can still read it from the log at the stored publication block (it then
   caches it), the request is refused with `NOT_SPONSORED` ("nothing to re-publish"), and a
   complete request is refused too. While the relayer's own combine of the request is pending
   (it may complete it) the answer is `CONFLICT`, and when the log read fails in a way that clears
   by itself (rate limit, timeout, a backend behind the head) a retryable `INTERNAL`: only a block
   the provider no longer serves, or a refused method, counts as missing data. A sponsored
   re-publication starts a per-(request, member) backoff that doubles from 10 minutes
   (`RATE_LIMITED` until it passes), so a same-data refresh loop cannot drain the key. Anyone may
   still re-publish directly, at their own cost.
4. **Admission of new ceremonies.** At most `COUNCIL_ORGANIZER_DAILY_CEREMONIES` sponsored
   `createCeremony` per organizer per rolling 24 h. Setting `COUNCIL_ORGANIZER_ALLOWLIST` and/or
   `COUNCIL_API_TOKENS` switches to **restricted mode**: `createCeremony` needs an allow-listed
   organizer or `Authorization: Bearer <token>` (`UNAUTHORIZED`, 401), and every other action
   (the scheduler and the combine worker included; the worker checks before any BSGS work) is
   sponsored only for ceremonies created through this relayer that way or organized by an
   allow-listed address (`NOT_SPONSORED`, 403; an RPC failure while checking is a retryable
   `INTERNAL`). Without either variable the relayer is open, bounded by the quotas and the global
   budget only.

### Sizing the budget

At Osaka gas (the v2 gas snapshots in `solidity/snapshots/`, with every action sent through the
relayer), a 16-member, `t = 16` ceremony with one 16-field decryption costs about **88M gas**
for the whole lifecycle; the relayer pays all of it except the adapter's bind and request (about
6.4M), so about 82M (≈ 0.08 native units at 1 gwei). Under Amsterdam (Glamsterdam, Sepolia since
2026-10-06), whose state gas adds about 97,920 gas per storage slot written from zero, the same
lifecycle costs about **133M** (≈ 123M relayer-paid, ≈ 0.12). The dealings (≈ 25M Osaka, ≈ 55M
Amsterdam), the eight 2-field combines (≈ 34M) and the 16 partials (≈ 15M / 18M) dominate; the
v2 storage diet halved the Amsterdam figure (v1: 231M relayer-paid) and finalize is now 34k.

The largest single reservation is the estimate plus the 20% headroom times maxFeePerGas (2 ×
base fee + tip, capped by `COUNCIL_MAX_FEE_WEI`): a 4-field combine at `t = 16`, 7.45M gas under
Osaka (7.55M under Amsterdam) plus about 260k for its 16 KB of re-supplied D vectors, a 9.3M
limit (≈ 0.019 native units at a 1 gwei base fee). The combine worker itself sends 2-field
chunks at `t = 16` (about 4.3M with the calldata). At 1 gwei the default budget of one native
unit sponsors about twelve 16-member ceremonies a day under Osaka, about eight under Amsterdam.

A gas limit is capped at the lower of the block gas limit and `COUNCIL_MAX_TX_GAS`, by default
16,777,216 (2^24): Osaka (EIP-7825) rejects any transaction above that, whatever the block limit,
so the 20% headroom never pushes a large estimate into an invalid transaction. Every v2 action
stays far below it: the largest is the adapter's 16-field submitRequest (6.21M Osaka, 9.03M
Amsterdam), and the largest the relayer pays is the 4-field combine above. The worker's chunk
size is the protocol guideline `min(4, max(1, ⌊32/t⌋))` fields, so even the full `t = 16` calldata
(16 vectors of 16 points) keeps a chunk under half the cap.

On a chain with Glamsterdam's separate state gas (EIP-8037; Sepolia since 2026-10-06) the 2^24
maximum bounds a transaction's execution gas only: each new storage slot costs about 97,920 gas
of state gas on top, and the gas limit must cover both. Set `COUNCIL_STATE_GAS=true` on such a
chain: the gas limit is then capped by the block gas limit alone (unless `COUNCIL_MAX_TX_GAS` is
set explicitly). Leave it unset on an Osaka chain such as Gnosis, where a limit above 2^24 is
invalid. The flag is explicit rather than probed: no RPC method says whether a chain prices state
gas, and a wrong guess either reverts large actions out of gas or makes them invalid. (Under v2
every action stays under 2^24 even with its state gas, the largest being the adapter's
submitRequest(16) at 9.03M; the flag mattered for the v1 manager's affine finalize, 17.24M.)

The hot key must hold every transaction's worst case (gas limit × max fee) on top of what it
already has in flight, or the node refuses the broadcast. The relayer checks the key's balance
before it signs, and refuses an action it cannot cover with `BUDGET_EXHAUSTED` ("the relayer key
holds … wei, and this action may cost up to … wei; the operator must top it up"), logging
`hot key balance too low: top it up` as an error. A node's own `insufficient funds` refusal says
the same in plain words, as `TX_FAILED`.

## Configuration

Configuration is environment-only.

| Variable | Default | Description |
|---|---|---|
| `COUNCIL_RPC_URL` | required | RPC endpoints, comma-separated: reads fall back in order; broadcasts walk them in order (see "Hot key") |
| `COUNCIL_MANAGER_ADDRESS` | required | The CouncilManager this relayer serves |
| `COUNCIL_PRIVATE_KEY` | required | Hot key paying gas (`RELAYER_PRIVATE_KEY` is an alias) |
| `COUNCIL_PORT` / `COUNCIL_HOST` | `8080` / `0.0.0.0` | Listen address |
| `COUNCIL_DATA_DIR` | `./data` (`/data` in Docker) | State file and partial-data cache directory |
| `COUNCIL_COMBINER_ENABLED` | `false` | Run the combine worker |
| `COUNCIL_SCHEDULER_ENABLED` | `false` | Run the scheduler (time-based close, abort, finalize; see "Scheduler") |
| `COUNCIL_SCHEDULER_POLL_MS` | `15000` | Scheduler pass interval |
| `COUNCIL_MAX_FEE_WEI` | `100000000000` (100 gwei) | Cap on maxFeePerGas, bumps included |
| `COUNCIL_MAX_TX_GAS` | `16777216` (2^24, EIP-7825); none with `COUNCIL_STATE_GAS` | Cap on a transaction's gas limit, below the block gas limit |
| `COUNCIL_STATE_GAS` | `false` | The chain prices state gas separately (EIP-8037, Glamsterdam): cap gas limits at the block gas limit only (see "Sizing the budget") |
| `COUNCIL_DAILY_BUDGET_WEI` | `1000000000000000000` (1 native unit) | Rolling 24 h spend limit; `0` disables |
| `COUNCIL_ORGANIZER_ALLOWLIST` | empty | Organizers whose ceremonies are sponsored (restricted mode) |
| `COUNCIL_API_TOKENS` | empty | Bearer tokens admitting `createCeremony`, at least 16 characters each (restricted mode) |
| `COUNCIL_ORGANIZER_DAILY_CEREMONIES` | `5` | Sponsored ceremonies per organizer per 24 h; `0` = unlimited |
| `COUNCIL_MAX_GRANTS` | `8` | Sponsored allowAdapter + authorizeCreator per ceremony |
| `COUNCIL_CEREMONY_RATE_LIMIT` | `120` | Sponsored actions per ceremony (or request) per minute |
| `COUNCIL_RATE_LIMIT` | `60` | Relay requests per minute per IP and action type |
| `COUNCIL_INGRESS_RATE_LIMIT` | `600` | Requests per minute per IP, all routes |
| `COUNCIL_MAX_CONCURRENT_REQUESTS` | `64` | Requests handled at once |
| `COUNCIL_CORS_ORIGINS` | empty | Allowed browser origins, comma-separated, or `*` |
| `COUNCIL_TRUSTED_PROXIES` | empty | Proxy IPs/CIDRs whose `X-Forwarded-For` is honoured (replaces `COUNCIL_TRUST_PROXY`) |
| `COUNCIL_START_BLOCK` | `0` | First block the combiner's log scan reads (requests are also found from state); set it to the deployment block |
| `COUNCIL_LOG_RANGE` | `5000` | Maximum blocks per `eth_getLogs`; halved automatically when the provider refuses a range |
| `COUNCIL_COMBINER_POLL_MS` | `5000` | Combiner poll interval |
| `COUNCIL_BSGS_BABY_STEPS` | `1048576` | BSGS table size (memory/time trade-off) |
| `COUNCIL_TX_BUMP_AFTER_MS` | `30000` | Fee-bump a transaction pending this long |
| `COUNCIL_TX_POLL_MS` | `3000` | Pending-transaction monitor interval (status latency) |
| `COUNCIL_NONCE_REFRESH_MS` | `15000` | Re-read the key's pending nonce before a send after this long without one |
| `COUNCIL_ALERT_MIN_BALANCE_WEI` | `COUNCIL_DAILY_BUDGET_WEI`, or 10^17 without a budget | `/v1/metrics` alerts below this hot-key balance (see "Monitoring") |
| `COUNCIL_ALERT_BUDGET_PERCENT` | `20` | Alert when less than this percentage of the daily budget is left |
| `COUNCIL_ALERT_PENDING_MS` | `600000` | Alert when a transaction has been unmined for longer |
| `COUNCIL_ALERT_STALE_MS` | `600000` | Alert when the monitor, scheduler or combine worker completed no pass for longer |
| `COUNCIL_ALERT_RPC_LAG_BLOCKS` | `64` | Alert when the endpoints' finalized blocks are further apart |

## Ingress

- Every request is charged to its client IP (`COUNCIL_INGRESS_RATE_LIMIT` per minute, all routes
  including `/v1/health` and `/v1/status`); relay requests additionally per IP and action type
  (`COUNCIL_RATE_LIMIT`), rejected ones included. At most `COUNCIL_MAX_CONCURRENT_REQUESTS` are
  handled at once (`BUSY`, 503); a request holds its slot until its work is done, even if the
  client disconnects.
- The client IP is the socket peer. `X-Forwarded-For` is honoured only when the peer is in
  `COUNCIL_TRUSTED_PROXIES`, and then the right-most hop that is not a trusted proxy is used;
  client-supplied entries further left are ignored.
- A request whose `Origin` is not in `COUNCIL_CORS_ORIGINS` is refused on every route
  (`FORBIDDEN_ORIGIN`, 403). `POST /v1/relay` requires `Content-Type: application/json`
  (`UNSUPPORTED_MEDIA_TYPE`, 415), so a cross-site form or `text/plain` request cannot reach it
  without a CORS preflight.
- `/v1/status/:txHash` answers only for transactions this relayer sent (`NOT_FOUND`, 404,
  otherwise), from memory: the monitor settles them from receipts. `/v1/health` is cached 5 s and
  reports the chain, the manager, the hot key and its balance; `/v1/metrics` (cached 15 s) is
  described under "Monitoring". `POST /v1/track` (with the combine worker) is described under
  "Combine worker".

## Hot key

- **Broadcasting.** A signed transaction goes to the `COUNCIL_RPC_URL` endpoints one at a time. A
  refusal that is not about the transaction (method not allowed, a plan without sends such as
  1rpc.io's free tier, auth, rate limit, transport) moves on to the next endpoint with a warning.
  A refusal about the transaction (nonce, funds, fees, gas) stops there. When all fail, the most
  informative refusal is reported (nonce, then transaction, then unknown, then transient, then
  endpoint), so an endpoint that cannot send never masks another one's `nonce too low`.
- **Nonce.** The relayer allocates nonces locally and expects to own the key. Before a send after
  `COUNCIL_NONCE_REFRESH_MS` without one, and after any failed send, it re-reads the key's
  `pending` nonce (never below a transaction it still tracks). If the chain is past the nonce it
  tried, it retries once with the fresh nonce, whatever the refusal said. Either way it logs
  `hot key used outside the relayer` with the expected and on-chain nonces. A tracked transaction
  whose nonce was consumed by someone else is reported as failed (`replaced or dropped`) with the
  same hint, but only once the nonce is consumed at the **finalized** block and no receipt of
  any of its hashes exists, over three monitor passes; until then its reservation stays.
- **Uncertain broadcasts.** A broadcast that fails is checked with `eth_getTransactionByHash`.
  Only a node that verifiably does not know the transaction frees its journal entry, nonce,
  slots and reservation; when that lookup fails too, the signed transaction stays journaled
  (`broadcast outcome unknown`, a warning), the caller gets its hash, and the monitor
  rebroadcasts it, so an RPC outage can never make the relayer pay twice for one action.
- **Finality and reorgs.** A transaction's first receipt reports it (`/v1/status` says
  `confirmed` or `failed`) and frees its slots, but its signed bytes stay in the state file, and
  the rest of its worst case stays reserved, until its block is finalized (its receipt is
  re-checked every 15 s meanwhile). If a reorg removes it (its receipt verified absent twice), it
  is pending again at its **original nonce**, re-reserved for what a replay of any version signed
  for that nonce (fee bumps included) may cost beyond what it was charged inside the current
  budget window, and rebroadcast at once, so a node that dropped it cannot leave a gap that later
  nonces queue behind. A re-mined transaction is charged only the difference. Nothing is evicted
  before finality: with 512 mined transactions awaiting it (an RPC whose finalized block does
  not advance), new sends are refused with `BUSY` until it does.
- **Monitor.** Every `COUNCIL_TX_POLL_MS` *after the previous pass finished*: passes never queue
  up behind a slow RPC (they would delay every send sharing the key's queue).
- **Funding.** Watch the balance in `/v1/metrics` (it alerts below `COUNCIL_ALERT_MIN_BALANCE_WEI`).
  A relayer that runs dry fails its broadcasts; nothing is lost on chain, and the signed actions
  can be resubmitted later or sent directly.

## Scheduler

With `COUNCIL_SCHEDULER_ENABLED=true` the relayer sends the permissionless phase transitions that
come due in the ceremonies it serves, so a ceremony moves on even when no member's browser is
open (protocol §8.3, §8.4):

- `closeRegistrationScheduled` once a Scheduled registration reaches its deadline, or a Manual
  registration its nonzero expiry, with at least `t` members (the roster is rebuilt from state;
  the dealing deadline is the scheduled one whatever the sending time);
- `abort` once a registration missed `t` at its deadline or nobody closed it within its window,
  and once a dealing passed its deadline with fewer than `t` dealers;
- `finalize` once every member dealt, or the dealing deadline passed with at least `t` dealers.

The ceremonies it serves are those it sponsored an action for (create, join, close, deal,
grants, opening), recorded in the state file; no log is read. Each pass reads `getCeremony` and
`getPolicy` at the latest **finalized** block and evaluates the SDK's schedule predicates.

- **Closes are decided on the head.** The close window (deadline to deadline + dealing duration,
  at least 10 minutes) can be shorter than the chain's finality lag (about 13 minutes on
  Sepolia): a join that reaches `t` shortly before the deadline would reach the finalized block
  only after the window, and the finalized state would then only ever say "abort". So once the
  head is past the deadline the scheduler reads `getCeremony` at the head and sends
  `closeRegistrationScheduled` if it is due there; the sponsor simulates it at the head, so a
  close that would revert costs nothing. A ceremony created after the finalized block is checked
  the same way.
- **Aborts wait for finality.** The abort predicates depend on counts that are final only once
  the finalized block is past the deadline, and are evaluated there; no abort is sent while a
  transition this relayer sent is not final.
- **Finalize** (inputs only grow, no upper bound) is evaluated on the finalized counts at the
  head's timestamp.

A ceremony that cannot change before a date (a Scheduled registration before its deadline, a
Scheduled opening) costs no read until then; a Manual one is polled, since the organizer may
close or open it at any time.

Every transition goes through the same path as a relayed action: admission, the one-shot slot and
quota (one close, finalize and abort per ceremony), simulation at the head and the global budget.
It is sent at most once: a transition that failed on chain is not paid for again (the scheduler
logs `scheduled transition already sponsored once; leaving it to others`), one the head refuses
(someone else got there first) is retried with a backoff, and one already pending for a browser
shares its transaction.

Decryption opening needs no transaction (protocol §8.7): a Scheduled date or a Manual fallback
opens the gate by predicate alone, and only the organizer's signed `openDecryption` writes. The
scheduler watches a Live ceremony until its gate is open, logs `decryption gate open`, hands the
ceremony to the combine worker (which enumerates its requests from state from then on) and stops
watching it. Aborted ceremonies, and ids unknown at the
finalized block for a day (a create that reverted), are dropped.

## Combine worker

With `COUNCIL_COMBINER_ENABLED=true` the worker completes every request that has `t` accepted
partials, in `min(4, max(1, ⌊32/t⌋))`-field chunks (two at `t = 16`), each simulated and paid
like a relayed `combine`. The contract keeps only a hash and a publication block per partial
(protocol §10.2), so each combine re-supplies the members' full padded D vectors and the
request's `C2` points (decompressed from the stored words). The worker sources the vectors in
the protocol §10.4 order, through the SDK:

1. its own cache: every vector the relayer relayed (submitPartial, publishPartialData, combine)
   or read, in `<COUNCIL_DATA_DIR>/<chainId>-<manager>-partials/`, one file per request, removed
   once the request is complete at the finalized block;
2. else **one** `eth_getLogs` for `PartialDataPublished` at the exact block stored for that
   member (`getPartialCommitment`): a single-block read at a recorded block, never a range;
3. else it waits (`combine waiting for partial data re-publication`, at info, then a warning if
   it persists) until members re-publish their deterministic `D = s_i·C1` with
   `publishPartialData` — from the app, directly or through a relayer.

Whatever the transport, a vector is used only if it hashes to the stored commitment. The worker
picks the `t` lowest members whose vectors it can authenticate. It never combines before the
ceremony's decryption gate is open: a request behind a closed gate is parked at the cost of one
view read per pass (partials cannot be accepted before opening, so in practice only a reorg
parks one).

**Finding requests.** No critical path reads event logs (architecture §6.6). The worker finds
requests from contract state for every *tracked* ceremony: it reads `getRequestCount` and the
`getRequestIdsPage` pages past the ids already final (count and pages at one head block; the
ids past the finalized count are read again on every check, so a reorg that replaces a binding
is still seen), for at most 16 ceremonies per pass in rotation, each re-read once a minute (at
once when it is newly tracked or its gate just opened). That works
from any archive-free RPC, however long ago the ceremony ran. A ceremony is tracked once the
relayer sponsored a decryption action for it (`openDecryption`, `submitPartial`,
`publishPartialData` or a relayed `combine`), once the scheduler saw its gate open, once one of
its requests turned up in a log, or when the app or the organizer registered it with
`POST /v1/track` (below). The list lives in the state file (at most 10,000, oldest dropped
first), so a restart finds every request again without a log.

Logs are a convenience on top. Requests are also discovered from `RequestSubmitted` logs in
`COUNCIL_LOG_RANGE` chunks up to the head, rescanning the last 64 blocks on every pass, and the
cursor moves chunk by chunk. A failed scan never holds back the requests already known: it has
its own backoff, and the pass goes on. Public
endpoints are load-balanced: the backend that answers `eth_getLogs` can be a block or two behind
the one that reported the head, and refuses the range (`-32602 block range extends beyond
current head block` on publicnode and Tenderly). The pass then stops where it is and the next
one picks the rest up. A provider that caps `eth_getLogs` below `COUNCIL_LOG_RANGE` (or refuses
an answer as too large) gets the same blocks again in half the range, and the smaller range is
kept; the cursor lives in memory, so a relayer restarted months after `COUNCIL_START_BLOCK`
rescans from there in those ranges (about 130 requests per 650,000 blocks at 5,000). A range the
provider refuses three times in a row for any other reason than load (history it pruned, a
block it cannot serve) is skipped, up to 64 blocks below the head when it is older, with a
warning (`request discovery skips blocks the rpc keeps refusing`); later scans step over it, and
requests there are still found from state for tracked ceremonies. A failed
scan waits twice as long before the next one, up to five minutes. Transient RPC failures (rate
limits, timeouts, 5xx, dropped connections) log at `info` as `request discovery deferred` until
five in a row, then as a `request discovery failed` warning; anything else warns at once.

### Tracking a ceremony (`POST /v1/track`)

With the combine worker enabled, the app or the organizer can make sure a ceremony's decryption
is served whatever the logs do (a provider that pruned the deployment block, a lost state file):

```json
{ "chainId": "11155111", "manager": "0x…", "ceremonyId": "0x<12 bytes>",
  "validUntil": "<unix seconds>", "signature": "0x<65 bytes>" }
```

It is authenticated either by `Authorization: Bearer <token>` (a `COUNCIL_API_TOKENS` entry; then
`validUntil` and `signature` are omitted) or by the ceremony organizer's EIP-712 signature over
`TrackCeremony(bytes12 ceremonyId, uint64 validUntil)` in the relayer's own domain: name
`"DAVINCI DKG Council Relayer"`, version `"1"`, the chain id and the manager as
`verifyingContract` (`relayer/src/track.ts` exports `trackDomain` and `TRACK_TYPES`). It is never
the protocol's domain, so such a signature cannot be replayed as a protocol action. The relayer
then reads the ceremony at the head: it must exist (`NOT_FOUND`), not be aborted
(`INVALID_ACTION`), be organized by the signer (`UNAUTHORIZED`), and in restricted mode be
sponsored by this relayer (`NOT_SPONSORED`). The answer is `{ "ceremonyId": …, "tracked": true }`;
tracking is idempotent and costs reads only, and every combine is still sponsored under the
usual policy. The route shares the per-IP relay limit (`COUNCIL_RATE_LIMIT`).

## State

One JSON file, `<COUNCIL_DATA_DIR>/<chainId>-<manager>-<relayer>.json`, written atomically:
signed pending transactions (journaled before they are broadcast, together with their slots and
budget reservation, and rebroadcast at startup before new submissions are accepted, so a crash or
an eviction never frees their nonce), mined transactions not final yet (replayable after a
reorg), recent outcomes for `/v1/status`, the spend log, the sponsorship counters and
re-publication backoffs, the ceremonies the scheduler watches and those the combine worker
tracks. Losing it loses nothing on chain, but resets the budget window and the quotas, and the
workers forget their ceremonies until an action for them is relayed again or the ceremony is
registered with `POST /v1/track`. A relayer pointed at another manager or key starts a new file.

Its size is bounded. Outcomes are kept for a week, at most 2,000; the spend log covers the budget
window only. Every ten minutes a garbage collection prunes what can no longer matter, judging
ceremonies and requests at the **finalized** block (a failed read prunes nothing): organizer
records older than 24 h, re-publication backoffs older than 30 days, zero counters, every counter
of an aborted ceremony (and its admission and tracking), the phase counters of a Live one
(create, invites, close, join, deal, finalize, abort; openings and grants stay), every counter of
a complete request, and ids unknown at the finalized block for a day (a create that reverted). A
sponsorship rolled back after a failed broadcast leaves no zero entry behind. Transaction
journal writes are synchronous (before every broadcast); other bookkeeping is coalesced into at
most one write per second.

Next to it, `<COUNCIL_DATA_DIR>/<chainId>-<manager>-partials/` caches partial D vectors, one
file per request (at most 1,024 requests; the least recently written goes first). Losing it
costs single-block log reads, or a re-publication when those blocks are gone, never
correctness: every cached vector is checked against the on-chain hash before use.

## Monitoring

`GET /v1/health` is the liveness check (Railway routes to a deployment once it answers): the
chain, the manager, the hot key and its balance. `GET /v1/metrics` is what to alert on: it
answers **200 while no alert fires and 503 otherwise**, with the full body either way, so a plain
HTTP uptime check (every minute or so) is enough to page someone. It is cached 15 s.

| Field | Meaning |
|---|---|
| `ok`, `alerts` | No alert fires; otherwise one plain sentence per alert |
| `balanceWei` | The hot key's balance |
| `budget` | `limitWei`, `windowMs`, `spentWei`, `inFlightWei` (reserved worst cases) and `remainingWei` of the rolling budget |
| `transactions` | `pending` (unmined), `awaitingFinality` (mined, kept replayable), `oldestPendingMs`, `oldestUnfinalMs`, `foreignTransactions` (sent with the key by someone else), and the monitor's last success |
| `scheduler`, `combiner` | `lastSuccessAt` / `lastSuccessAgeMs` of the last completed pass and `consecutiveFailures` (`null` when disabled); the worker's open requests, tracked ceremonies and log discovery state |
| `rpc` | The agreement probe: every configured endpoint's finalized block, their hashes compared at the lowest finalized height (`agree`), and `lagBlocks` between them |
| `stateFileBytes` | Size of the last state file write |

The RPC probe performs the check the app makes before trusting a read (protocol §9.3): a
provider frozen on an old fork (the 1rpc incident on Sepolia), stuck, or failing shows up here
before members see "RPC providers disagree". Configure the same providers as the app.

Alerts and their thresholds:

| Alert | Fires when | Threshold (default) | Action |
|---|---|---|---|
| hot key balance | the balance is below the threshold | `COUNCIL_ALERT_MIN_BALANCE_WEI` (one day of `COUNCIL_DAILY_BUDGET_WEI`; 0.1 native units without a budget) | top the key up |
| daily budget nearly used | less than the threshold's share of the budget is left | `COUNCIL_ALERT_BUDGET_PERCENT` (20) | raise the budget for an opening day, or look for abuse |
| transaction pending | a transaction has been unmined for longer | `COUNCIL_ALERT_PENDING_MS` (600000, 10 min) | check fees (`COUNCIL_MAX_FEE_WEI`), funds and the RPCs |
| no successful pass | the monitor, the scheduler or the combine worker completed no pass for longer | `COUNCIL_ALERT_STALE_MS` (600000) | read the logs; the RPCs are the usual cause |
| finality | a mined transaction has awaited finality for over an hour (sends pause at 512 such transactions) | fixed (1 h) | the RPCs' finalized block is stuck: check or replace them |
| rpc | an endpoint fails, the endpoints disagree on a finalized block, or their finalized heights are further apart than the threshold | `COUNCIL_ALERT_RPC_LAG_BLOCKS` (64) | replace the provider (here and in the app's config) |
| foreign transactions | the key sent transactions this relayer did not | — | give the relayer a key nothing else uses |

Besides the relayer, watch the app origin (HTTP 200, the six circuit files still served and
hashing to their pins) from outside; `scripts/railway-status.sh` prints the alerts of a Railway
deployment.

## Error codes

The architecture §5.1 codes (`INVALID_ACTION`, `BAD_SIGNATURE`, `WRONG_CHAIN`,
`UNSUPPORTED_MANAGER`, `SIMULATION_REVERTED`, `RATE_LIMITED`, `TX_FAILED`, `INTERNAL`) plus
`NOT_FOUND` (404), `UNAUTHORIZED` (401), `NOT_SPONSORED` (403), `FORBIDDEN_ORIGIN` (403),
`CONFLICT` (409), `UNSUPPORTED_MEDIA_TYPE` (415), `QUOTA_EXCEEDED` (429), `BUDGET_EXHAUSTED` (503)
and `BUSY` (503). A client that gets `CONFLICT`, `QUOTA_EXCEEDED`, `NOT_SPONSORED` or
`BUDGET_EXHAUSTED` can always submit the same signed action directly. For `publishPartialData`,
`NOT_SPONSORED` means the relayer already holds the data (or the request is complete),
`CONFLICT` that its own combine of the request is pending, and `RATE_LIMITED` that the member's
re-publication backoff has not passed.

## Upgrades

The relayer is stateless toward the chain: stop it, start the new version with the same data
directory, and it rebroadcasts what it had pending before it accepts new submissions. `latest`
moves on stable releases only (`vX.Y.Z`); pin a version tag to upgrade by hand. A new circuit
release means a new manager deployment, and therefore a new `COUNCIL_MANAGER_ADDRESS`. So does
protocol v2: a v2 relayer speaks only to a v2 manager (EIP-712 domain version "2"), and v1
ceremonies finish on a relayer of the v1 release pointed at the v1 manager; run both side by side
during the transition, each with its own data directory.
