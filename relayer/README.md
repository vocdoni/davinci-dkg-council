# Council relayer

`@vocdoni/davinci-dkg-council-relayer` relays the signed Council actions (and the permissionless
`finalize`, `abort` and `combine`) from one hot key, and runs the public combine step. It can
neither forge nor alter a signed submission, and every action it sends can be sent directly from
any funded account.

```bash
make relayer                        # builds the SDK, then dist/
make relayer-test                   # type-check + unit tests against an in-memory chain
COUNCIL_RPC_URL=… COUNCIL_MANAGER_ADDRESS=0x… COUNCIL_PRIVATE_KEY=0x… node relayer/dist/main.js
make relayer-docker                 # ghcr.io/vocdoni/davinci-dkg-council-relayer:dev
```

On a chain with Glamsterdam's separate state gas (EIP-8037, Sepolia since 2026-10-06) set
`COUNCIL_STATE_GAS=true`: the EIP-7825 2^24 cap then bounds execution gas only, so gas limits are
capped by the block gas limit alone (a 16-member finalize needs 17.24M). Leave it unset on Osaka
chains such as Gnosis. An action the hot key cannot cover is refused with `BUDGET_EXHAUSTED`
("… the operator must top it up") before anything is signed.

Operating it (configuration, budget sizing, quotas, the hot key, the combine worker, state,
upgrades): [docs/relayer.md](../docs/relayer.md). HTTP API and wire format:
[docs/architecture.md](../docs/architecture.md) §5.
