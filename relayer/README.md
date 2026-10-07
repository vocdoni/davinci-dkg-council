# Council relayer

`@vocdoni/davinci-dkg-council-relayer` relays the signed Council actions (and the permissionless
`closeRegistrationScheduled`, `finalize`, `abort`, `publishPartialData` and `combine`) from one hot
key, sends the due permissionless phase transitions of the ceremonies it serves (the scheduler),
and runs the public combine step. It speaks protocol v2 (one v2 CouncilManager per relayer). It
can neither forge nor alter a signed submission, and every action it sends can be sent directly
from any funded account.

```bash
make relayer                        # builds the SDK, then dist/
make relayer-test                   # type-check + unit tests against an in-memory chain
COUNCIL_RPC_URL=… COUNCIL_MANAGER_ADDRESS=0x… COUNCIL_PRIVATE_KEY=0x… node relayer/dist/main.js
make relayer-docker                 # ghcr.io/vocdoni/davinci-dkg-council-relayer:dev
```

Both workers are opt-in: `COUNCIL_COMBINER_ENABLED=true` runs the combine worker (it re-supplies
the members' partial D vectors from its cache in the data directory, else from one `eth_getLogs`
at each stored publication block, and waits for re-publication when neither has them), and
`COUNCIL_SCHEDULER_ENABLED=true` the scheduler (time-based close, abort and finalize, each sent
once; aborts from views read at the finalized block, a due close from the head). The combine
worker finds requests from contract state (`getRequestCount` / `getRequestIdsPage`) for the
ceremonies it tracks, logs being a convenience; the app or the organizer can register a ceremony
with `POST /v1/track`. The roster, `C1` and `C2` never travel on the wire: the relayer rebuilds
them from the stored compressed words. `GET /v1/metrics` reports the hot key's balance, the
budget, pending transactions, the workers' last successful pass and an RPC agreement probe, and
answers 503 while an alert fires.

On a chain with Glamsterdam's separate state gas (EIP-8037, Sepolia since 2026-10-06) set
`COUNCIL_STATE_GAS=true`: the EIP-7825 2^24 cap then bounds execution gas only, so gas limits are
capped by the block gas limit alone. Leave it unset on Osaka chains such as Gnosis. A 16-member
ceremony with one 16-field decryption costs the relayer about 82M gas under Osaka and 123M under
Amsterdam (88M / 133M including the adapter's bind and request). An action the hot key cannot
cover is refused with `BUDGET_EXHAUSTED` ("… the operator must top it up") before anything is
signed.

Operating it (configuration, budget sizing, quotas, the hot key, the scheduler, the combine
worker, state, monitoring, upgrades): [docs/relayer.md](../docs/relayer.md). HTTP API and wire format:
[docs/architecture.md](../docs/architecture.md) §5.
