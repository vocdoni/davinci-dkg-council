# Running a relayer

The relayer pays for Council. Participants sign every action (EIP-712) in the browser and never
hold funds; the relayer simulates each signed action, sends it from one hot key, and runs the
public combine step that turns `t` partial decryptions into plaintexts. It is a convenience, not
a trusted party: it can neither forge nor alter a signed submission (signatures, proofs and
payload hashes bind every byte), every action it sends can be sent directly from any funded
account, and the app's users can switch to another relayer. The HTTP API is in
[architecture.md](architecture.md) §5.

## Requirements

- 1 core and 512 MB of RAM. The combine worker builds its baby-step/giant-step table (2^20 entries
  by default) in about 3 s and keeps it in memory; a process holding it peaks near 200 MB, and the
  worst-case 40-bit plaintext takes about 3.3 s to find (BENCHMARKS.md).
- A hot key funded with the chain's native currency, used by nothing else. The relayer allocates
  nonces locally; another sender on the same key costs it a resync and a warning each time.
- At least two JSON-RPC endpoints. Reads fall back in order, and a broadcast walks them in order
  until one accepts the transaction.
- A persistent directory for its state file (a few hundred KB).

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
service, its volume, domain and variables; the public Sepolia relayer runs this way
([Hosting on Railway](deployments.md#hosting-on-railway)).

## What it pays for

Every action is simulated with `eth_call` first; a reverting one is refused with
`SIMULATION_REVERTED` and costs nothing. Beyond that, spending is bounded on four levels.

1. **Global budget.** A rolling 24 h wei budget for the hot key (`COUNCIL_DAILY_BUDGET_WEI`).
   Each transaction reserves its worst case (gas limit × max fee) when sent and is charged its
   actual cost when mined. When the budget is used up, sponsorship stops with `BUDGET_EXHAUSTED`
   (503) until spend leaves the window. The combine worker spends from the same budget.
2. **One-shot slots.** Each action names the protocol state it consumes: the ceremony (create),
   an invite id, a participant and a key (join), the phase transition (close, finalize, abort), a
   dealer (deal), an adapter or creator (grants), `(request, member)` (partial),
   `(request, field)` (combine). From acceptance until the transaction settles, an identical
   submission returns the pending transaction hash, and a conflicting variant (other expiry,
   signature, member set, …) is refused with `CONFLICT` (409) instead of being paid for as a
   certain revert.
3. **Per-ceremony quotas**, from the protocol bounds, counting sponsored transactions (charged
   only after a successful simulation, undone if the broadcast fails, persisted):

   | Quota | Limit |
   |---|---|
   | createCeremony, closeRegistration, finalize, abort | 1 each per ceremony |
   | invites (createCeremony + addInvites) | 64 per ceremony (`MAX_INVITES`) |
   | join, deal | 16 each per ceremony (`MAX_N`) |
   | allowAdapter + authorizeCreator | `COUNCIL_MAX_GRANTS` per ceremony |
   | submitPartial | n per request |
   | combine | 2 × fieldCount fields per request (each field once, plus one retry) |

   Exceeded: `QUOTA_EXCEEDED` (429). The per-ceremony rate (`COUNCIL_CEREMONY_RATE_LIMIT`) is
   also charged only after a successful simulation, so failing requests cannot exhaust a
   ceremony's budget; they are charged to their source IP instead.
4. **Admission of new ceremonies.** At most `COUNCIL_ORGANIZER_DAILY_CEREMONIES` sponsored
   `createCeremony` per organizer per rolling 24 h. Setting `COUNCIL_ORGANIZER_ALLOWLIST` and/or
   `COUNCIL_API_TOKENS` switches to **restricted mode**: `createCeremony` needs an allow-listed
   organizer or `Authorization: Bearer <token>` (`UNAUTHORIZED`, 401), and every other action
   (the combine worker included, which checks before any BSGS work) is sponsored only for
   ceremonies created through this relayer that way or organized by an allow-listed address
   (`NOT_SPONSORED`, 403; an RPC failure while checking is a retryable `INTERNAL`). Without either
   variable the relayer is open, bounded by the quotas and the global budget only.

### Sizing the budget

At Osaka gas ([BENCHMARKS.md](../BENCHMARKS.md#gas), with every action sent through the
relayer): a 3-member, `t = 2` ceremony with one 4-field decryption costs about 9.0M gas (≈ 0.009
native units at 1 gwei), a 16-member one with one 16-field decryption about 101M (≈ 0.10). Under
Amsterdam (Glamsterdam, Sepolia since 2026-10-06), whose state gas adds about 97,920 gas per
storage slot written from zero, the 16-member ceremony with its decryption costs about 231M
(≈ 0.23). The largest single reservation is the estimate plus the 20% headroom times
maxFeePerGas (2 × base fee + tip, capped by `COUNCIL_MAX_FEE_WEI`): under Osaka a 4-field combine
at `t = 16` (7.37M gas, an 8.85M limit, ≈ 0.018 native units at a 1 gwei base fee), under
Amsterdam finalize at `n = t = 16` (9.05M gas, a 10.86M limit, ≈ 0.022). At 1 gwei the default
budget of one native unit sponsors about ten 16-member ceremonies a day under Osaka, about four
under Amsterdam.

A gas limit is capped at the lower of the block gas limit and `COUNCIL_MAX_TX_GAS`, by default
16,777,216 (2^24): Osaka (EIP-7825) rejects any transaction above that, whatever the block limit,
so the 20% headroom never pushes a large estimate into an invalid transaction.

On a chain with Glamsterdam's separate state gas (EIP-8037; Sepolia since 2026-10-06) the 2^24
maximum bounds a transaction's execution gas only: each new storage slot costs about 97,920 gas
of state gas on top, and the gas limit must cover both. A 16-member finalize there needs 9.05M
gas (≈ 2.78M execution + 6.27M state), and every action of the current manager fits under 2^24 in
total, the largest being the adapter's 16-field submitRequest (12.54M). The affine finalize of
the previous Sepolia manager (`0x57ef…3070`) needed 17.24M (10.97M execution + 6.27M state),
which a 2^24 clamp sent out of gas. Set `COUNCIL_STATE_GAS=true` on such a chain: the gas limit is
then capped by the block gas limit alone (unless `COUNCIL_MAX_TX_GAS` is set explicitly). Leave
it unset on an Osaka chain such as Gnosis, where a limit above 2^24 is invalid. The flag is
explicit rather than probed: no RPC method says whether a chain prices state gas, and a wrong
guess either reverts large actions out of gas or makes them invalid.

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
| `COUNCIL_DATA_DIR` | `./data` (`/data` in Docker) | State file directory |
| `COUNCIL_COMBINER_ENABLED` | `false` | Run the combine worker |
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
| `COUNCIL_START_BLOCK` | `0` | First block the combiner scans; set it to the deployment block |
| `COUNCIL_LOG_RANGE` | `5000` | Maximum blocks per `eth_getLogs` |
| `COUNCIL_COMBINER_POLL_MS` | `5000` | Combiner poll interval |
| `COUNCIL_BSGS_BABY_STEPS` | `1048576` | BSGS table size (memory/time trade-off) |
| `COUNCIL_TX_BUMP_AFTER_MS` | `30000` | Fee-bump a transaction pending this long |
| `COUNCIL_TX_POLL_MS` | `3000` | Pending-transaction monitor interval (status latency) |
| `COUNCIL_NONCE_REFRESH_MS` | `15000` | Re-read the key's pending nonce before a send after this long without one |

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
  reports the chain, the manager, the hot key and its balance.

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
  same hint.
- **Funding.** Watch the balance in `/v1/health`. A relayer that runs dry fails its broadcasts;
  nothing is lost on chain, and the signed actions can be resubmitted later or sent directly.

## Combine worker

The worker scans `RequestSubmitted` logs in `COUNCIL_LOG_RANGE` chunks up to the head, rescanning
the last 64 blocks on every pass, and moves its cursor chunk by chunk. Public endpoints are
load-balanced: the backend that answers `eth_getLogs` can be a block or two behind the one that
reported the head, and refuses the range (`-32602 block range extends beyond current head
block` on publicnode and Tenderly). The pass then stops where it is and the next one picks the
rest up. A failed pass waits twice as long before the next one, up to a minute. Transient RPC
failures (that one, rate limits, timeouts, 5xx, dropped connections) log at `info` as `combiner
pass deferred` until five in a row, then as a `combiner tick failed` warning; anything else
warns at once.

## State

One JSON file, `<COUNCIL_DATA_DIR>/<chainId>-<manager>-<relayer>.json`, written atomically:
signed pending transactions (journaled before they are broadcast, together with their slots and
budget reservation, and rebroadcast at startup before new submissions are accepted, so a crash or
an eviction never frees their nonce), recent outcomes for `/v1/status`, the spend log and the
sponsorship counters. Losing it loses nothing on chain, but resets the budget window and the
quotas. A relayer pointed at another manager or key starts a new file.

## Error codes

The architecture §5.1 codes (`INVALID_ACTION`, `BAD_SIGNATURE`, `WRONG_CHAIN`,
`UNSUPPORTED_MANAGER`, `SIMULATION_REVERTED`, `RATE_LIMITED`, `TX_FAILED`, `INTERNAL`) plus
`NOT_FOUND` (404), `UNAUTHORIZED` (401), `NOT_SPONSORED` (403), `FORBIDDEN_ORIGIN` (403),
`CONFLICT` (409), `UNSUPPORTED_MEDIA_TYPE` (415), `QUOTA_EXCEEDED` (429), `BUDGET_EXHAUSTED` (503)
and `BUSY` (503). A client that gets `CONFLICT`, `QUOTA_EXCEEDED`, `NOT_SPONSORED` or
`BUDGET_EXHAUSTED` can always submit the same signed action directly.

## Upgrades

The relayer is stateless toward the chain: stop it, start the new version with the same data
directory, and it rebroadcasts what it had pending before it accepts new submissions. `latest`
moves on stable releases only (`vX.Y.Z`); pin a version tag to upgrade by hand. A new circuit
release means a new manager deployment, and therefore a new `COUNCIL_MANAGER_ADDRESS`.
