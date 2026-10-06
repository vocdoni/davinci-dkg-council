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
  ])('refuses %s', (_name, env, message) => {
    expect(() => loadConfig({ ...BASE, ...env })).toThrow(message);
  });
});
