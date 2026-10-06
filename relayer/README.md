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

Operating it (configuration, budget sizing, quotas, the hot key, state, upgrades):
[docs/relayer.md](../docs/relayer.md). HTTP API and wire format:
[docs/architecture.md](../docs/architecture.md) §5.
