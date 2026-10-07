# Hard forks

What a chain hard fork does to a Council deployment, and the operator checklist for riding one
out — especially with ceremonies in flight. Written from experience: Sepolia forked to
Glamsterdam (EIP-8037 state gas) on 2026-10-06, **between the two Sepolia deployments**. It
roughly tripled action costs (a plain transfer to a new account went from 21,000 to 204,600
gas), froze one public RPC provider at the pre-fork block, and pushed the v1 contracts' 17.24M
finalize past usability under the EIP-7825 per-transaction cap — which forced the v2 storage
diet and a redeploy ([deployments.md](deployments.md#hosting-on-railway),
[BENCHMARKS.md](../BENCHMARKS.md)).

## What a fork does and does not touch

**Nothing on chain changes for Council.** Contract state — ceremonies, keys, shares, aggregates,
ciphertexts, policy dates — survives any fork untouched; timestamps are absolute, so deadlines
and opening dates mean exactly what they meant. What changes is **cost** (gas repricing) and
**infrastructure behavior** (providers, estimators, caps). An in-flight ceremony therefore never
needs protocol action because of a fork; it needs its operators to keep the services correct and
funded through it.

- A ceremony in Registration or Dealing whose deadlines slip during fork-day chaos can always be
  aborted and restarted at no cryptographic cost: dealing rederivation is deterministic.
- A Live ceremony just continues; only the price of partials and combines moves.

## Checklist: a fork is announced for the deployment chain

### Before the fork

- [ ] **Providers**: confirm every configured RPC provider (app `rpcUrls` *and* the relayer's
  `COUNCIL_RPC_URL` list) announces support for the fork. The app's reads are N-of-N: one
  provider frozen at the pre-fork block stops the app entirely with "RPC providers disagree on
  the finalized block" (the 1rpc precedent — its Sepolia endpoint stopped one block before the
  fork). Replace doubtful providers *before* fork day ([hosting.md](hosting.md)).
- [ ] **Dates**: check whether any committee's opening date, fallback date or dealing deadline
  lands near the fork block; warn its organizer that fork-day instability may delay transactions
  by hours.
- [ ] **Read the fork's EIP list** for the three things that matter here: state-gas pricing,
  per-transaction gas caps, and precompile repricing (modexp and the pairing precompiles).

### At the fork — if it prices state gas (EIP-8037, "Glamsterdam")

- [ ] Flip **`COUNCIL_STATE_GAS=true`** on the relayer. There is no RPC method that says whether
  a chain prices state gas, so this is an explicit operator flag; with it the relayer caps gas
  limits at the block gas limit instead of 2^24. A missed flip is benign for *validity* under
  the v2 contracts (every action's execution gas stays well under the cap), but the cost math is
  wrong until it is set.
- [ ] **Budgets × ~1.5**: the measured full lifecycle (16-member ceremony plus one 16-field
  decryption) goes from about 88M gas to about 133M when state gas lands. Raise
  `COUNCIL_DAILY_BUDGET_WEI`, the per-ceremony quotas and the hot-key balance accordingly —
  quotas sized pre-fork can exhaust **mid-election**.

### At the fork — per-transaction caps and repricing

- [ ] **Per-tx cap (EIP-7825, 2^24 = 16,777,216 gas)**: every v2 action fits with room — the
  largest are a 16-field `submitRequest` (9.03M under Amsterdam) and a 4-field `combine` at
  `t = 16` (7.55M); `finalize` is 34k. A future fork that reprices further can be absorbed on
  the combine side by chunking down: the combiner already sends `min(4, max(1, ⌊32/t⌋))` fields
  per transaction and degrades gracefully to one field (≈ 2.4M).
- [ ] **Verifier gas is the one shape with no chunking escape**: a fork that reprices the
  pairing precompiles raises `deal` and `submitPartial` with no workaround. If a repricing ever
  pushes a required action past the per-tx cap, that is an incident, not an ops task — go to
  [incident-response.md](incident-response.md) (liveness class).

### After the fork — re-measure

- [ ] Re-run the gas measurements under the new EVM version (`make solidity-gas` with the new
  `--evm-version`, and the headless suite when Anvil supports the fork) and compare against
  real receipts on the forked chain; update `BENCHMARKS.md` and the relayer budget guidance.
- [ ] Watch the first live actions: receipts vs. estimates (the relayer adds 20% headroom to
  `eth_estimateGas` — confirm estimators on the forked chain are sane), provider agreement, and
  the relayer's spend rate against the new budget.
- [ ] Confirm the app still loads and reads: both providers serving the finalized block past the
  fork, no agreement refusals in normal operation.
