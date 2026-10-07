import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = {
  COUNCIL_RPC_URL: 'http://127.0.0.1:8545',
  COUNCIL_MANAGER_ADDRESS: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  COUNCIL_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
};

describe('config', () => {
  it('defaults: open admission, 1-unit daily budget, persistence under ./data', () => {
    const c = loadConfig(BASE);
    expect(c.manager).toBe('0x5fbdb2315678afecb367f032d93f642f64180aa3');
    expect(c.dailyBudgetWei).toBe(10n ** 18n);
    expect(c.dataDir).toBe('./data');
    expect(c.organizerAllowlist).toEqual([]);
    expect(c.apiTokens).toEqual([]);
    expect(c.organizerDailyCeremonies).toBe(5);
    expect(c.maxGrantsPerCeremony).toBe(8);
    expect(c.ingressRatePerIp).toBe(600);
    expect(c.trustedProxies).toEqual([]);
    expect(c.nonceRefreshMs).toBe(15_000);
    expect(c.maxTxGas).toBe(16_777_216n);
    expect(c.stateGas).toBe(false);
    expect(loadConfig({ ...BASE, COUNCIL_MAX_TX_GAS: '30000000' }).maxTxGas).toBe(30_000_000n);
    // EIP-8037 chains: the 2^24 cap bounds execution gas only, so no default per-transaction cap.
    const glamsterdam = loadConfig({ ...BASE, COUNCIL_STATE_GAS: 'true' });
    expect(glamsterdam.stateGas).toBe(true);
    expect(glamsterdam.maxTxGas).toBeUndefined();
    expect(loadConfig({ ...BASE, COUNCIL_STATE_GAS: 'true', COUNCIL_MAX_TX_GAS: '40000000' }).maxTxGas).toBe(40_000_000n);
    expect(loadConfig({ ...BASE, COUNCIL_NONCE_REFRESH_MS: '0' }).nonceRefreshMs).toBe(0);
  });

  it('the scheduler and the combine worker are opt-in', () => {
    const c = loadConfig(BASE);
    expect(c.schedulerEnabled).toBe(false);
    expect(c.combinerEnabled).toBe(false);
    expect(c.schedulerPollMs).toBe(15_000);
    const on = loadConfig({ ...BASE, COUNCIL_SCHEDULER_ENABLED: 'true', COUNCIL_SCHEDULER_POLL_MS: '2000' });
    expect(on.schedulerEnabled).toBe(true);
    expect(on.schedulerPollMs).toBe(2000);
  });

  it('monitoring thresholds: defaults tied to the budget, overridable', () => {
    const c = loadConfig(BASE);
    expect(c.alertMinBalanceWei).toBe(10n ** 18n); // one more day of the budget
    expect(c.alertBudgetPercent).toBe(20);
    expect(c.alertPendingMs).toBe(600_000);
    expect(c.alertStaleMs).toBe(600_000);
    expect(c.alertRpcLagBlocks).toBe(64n);
    expect(loadConfig({ ...BASE, COUNCIL_DAILY_BUDGET_WEI: '0' }).alertMinBalanceWei).toBe(10n ** 17n);
    const set = loadConfig({
      ...BASE,
      COUNCIL_ALERT_MIN_BALANCE_WEI: '5',
      COUNCIL_ALERT_BUDGET_PERCENT: '50',
      COUNCIL_ALERT_PENDING_MS: '60000',
      COUNCIL_ALERT_STALE_MS: '120000',
      COUNCIL_ALERT_RPC_LAG_BLOCKS: '8',
    });
    expect([set.alertMinBalanceWei, set.alertBudgetPercent, set.alertPendingMs, set.alertStaleMs, set.alertRpcLagBlocks]).toEqual([
      5n,
      50,
      60_000,
      120_000,
      8n,
    ]);
    expect(() => loadConfig({ ...BASE, COUNCIL_ALERT_BUDGET_PERCENT: '101' })).toThrow(/at most 100/);
  });

  it('parses admission, proxies and limits', () => {
    const c = loadConfig({
      ...BASE,
      COUNCIL_ORGANIZER_ALLOWLIST: '0x00000000000000000000000000000000000000A1, 0x00000000000000000000000000000000000000b2',
      COUNCIL_API_TOKENS: 'a-long-enough-token-1,a-long-enough-token-2',
      COUNCIL_TRUSTED_PROXIES: '10.0.0.0/8, 127.0.0.1, fd00::/8',
      COUNCIL_DAILY_BUDGET_WEI: '0',
    });
    expect(c.organizerAllowlist).toEqual(['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000b2']);
    expect(c.apiTokens).toHaveLength(2);
    expect(c.trustedProxies).toEqual(['10.0.0.0/8', '127.0.0.1', 'fd00::/8']);
    expect(c.dailyBudgetWei).toBe(0n);
  });

  it.each([
    ['the removed COUNCIL_TRUST_PROXY', { COUNCIL_TRUST_PROXY: 'true' }, /COUNCIL_TRUSTED_PROXIES/],
    ['a proxy that is not an IP', { COUNCIL_TRUSTED_PROXIES: 'proxy.example' }, /TRUSTED_PROXIES/],
    ['a short API token', { COUNCIL_API_TOKENS: 'short' }, /at least 16/],
    ['an allow-list entry that is not an address', { COUNCIL_ORGANIZER_ALLOWLIST: '0x1234' }, /ALLOWLIST/],
    ['a missing manager', { COUNCIL_MANAGER_ADDRESS: '' }, /required/],
    ['a per-transaction gas cap below 21000', { COUNCIL_MAX_TX_GAS: '20999' }, /MAX_TX_GAS/],
    ['a state-gas flag that is not a boolean', { COUNCIL_STATE_GAS: 'maybe' }, /STATE_GAS/],
    ['a scheduler flag that is not a boolean', { COUNCIL_SCHEDULER_ENABLED: 'on' }, /SCHEDULER_ENABLED/],
    ['a scheduler poll below 100 ms', { COUNCIL_SCHEDULER_POLL_MS: '10' }, /SCHEDULER_POLL_MS/],
  ])('refuses %s', (_name, env, message) => {
    expect(() => loadConfig({ ...BASE, ...env })).toThrow(message);
  });
});
