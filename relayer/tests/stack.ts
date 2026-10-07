/** A relayer stack (sender, policy, sponsor) over a MockChain, with a controllable clock. */

import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';
import type { PartialVectorStore } from '../src/partials.js';
import { Sponsor, SponsorPolicy, type PolicyConfig } from '../src/policy.js';
import { TxSender } from '../src/sender.js';
import { StateStore } from '../src/state.js';
import { MANAGER, MockChain, RELAYER_KEY } from './mockchain.js';

export const OPEN_POLICY: PolicyConfig = {
  organizerAllowlist: [],
  apiTokens: [],
  organizerDailyCeremonies: 0,
  maxGrantsPerCeremony: 8,
  ceremonyRatePerMinute: 1000,
};

export interface StackOptions {
  chain?: MockChain;
  automine?: boolean;
  policy?: Partial<PolicyConfig>;
  budgetWei?: bigint;
  maxFeeWei?: bigint;
  store?: StateStore;
  clock?: { t: number };
  /** The D-vector cache (default: in memory). */
  partials?: (chainId: bigint, manager: Hex) => PartialVectorStore;
}

export function stack(opts: StackOptions = {}) {
  const chain = opts.chain ?? new MockChain({ automine: opts.automine ?? true });
  const clock = opts.clock ?? { t: 1_000_000 };
  const now = () => clock.t;
  const store = opts.store ?? new StateStore();
  const sender = new TxSender({
    client: chain.client,
    account: privateKeyToAccount(RELAYER_KEY),
    chainId: chain.chainId,
    maxFeeWei: opts.maxFeeWei ?? 100_000_000_000n,
    bumpAfterMs: 10_000,
    budgetWei: opts.budgetWei ?? 0n,
    store,
    now,
  });
  const policy = new SponsorPolicy({
    client: chain.client,
    chainId: chain.chainId,
    manager: MANAGER,
    store,
    config: { ...OPEN_POLICY, ...opts.policy },
    partials: opts.partials?.(chain.chainId, MANAGER),
    now,
  });
  const sponsor = new Sponsor(policy, sender, MANAGER);
  return { chain, sender, policy, sponsor, store, clock, advance: (ms: number) => (clock.t += ms) };
}
