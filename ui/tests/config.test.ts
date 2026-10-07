import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, validateConfig } from '../src/config';

const base = {
  chainId: 100,
  manager: '0x00000000000000000000000000000000000000aa',
  rpcUrls: ['https://a.example/rpc', 'https://b.example/rpc'],
  relayerUrl: 'https://relay.example',
  artifactsBaseUrl: null,
  deploymentBlock: 1,
  devMode: false,
};

describe('config validation', () => {
  it('accepts a production config with two providers', () => {
    expect(validateConfig(base).chainId).toBe(100);
  });

  it('rejects a single RPC without devMode', () => {
    expect(() => validateConfig({ ...base, rpcUrls: ['https://a.example/rpc'] })).toThrow(/at least two/);
  });

  it('allows a single RPC only on a local dev chain', () => {
    expect(() =>
      validateConfig({ ...base, chainId: 31337, devMode: true, rpcUrls: ['http://127.0.0.1:8545'] }),
    ).not.toThrow();
    expect(() => validateConfig({ ...base, devMode: true })).toThrow(/local development chain/);
  });

  it('rejects duplicate RPC endpoints, even disguised', () => {
    expect(() =>
      validateConfig({ ...base, rpcUrls: ['https://a.example/rpc', 'HTTPS://A.EXAMPLE/rpc/'] }),
    ).toThrow(/same endpoint twice/);
  });

  it('accepts several relayers and artifact mirrors, singular key first, in order', () => {
    const cfg = validateConfig({
      ...base,
      relayerUrl: 'https://relay.example',
      relayerUrls: ['https://relay2.example'],
      artifactsBaseUrl: undefined,
      artifactsBaseUrls: ['https://m1.example/{release}', 'https://m2.example/circuits-v1'],
    });
    expect(cfg.relayerUrls).toEqual(['https://relay.example', 'https://relay2.example']);
    expect(cfg.artifactsBaseUrls).toEqual(['https://m1.example/{release}', 'https://m2.example/circuits-v1']);
    expect(validateConfig({ ...base, relayerUrl: null }).relayerUrls).toEqual([]);
  });

  it('rejects a repeated or non-http relayer or mirror', () => {
    expect(() => validateConfig({ ...base, relayerUrls: ['https://relay.example/'] })).toThrow(/same URL twice/);
    expect(() => validateConfig({ ...base, artifactsBaseUrls: ['ftp://m.example'] })).toThrow(/http\(s\)/);
    expect(() => validateConfig({ ...base, relayerUrls: 'https://x.example' })).toThrow(/array/);
  });

  it('lists legacy deployments on the same chain with their own relayers', () => {
    const legacy = '0x00000000000000000000000000000000000000BB';
    const cfg = validateConfig({
      ...base,
      legacyDeployments: [{ manager: legacy, deploymentBlock: 7, relayerUrls: ['https://old-relay.example'], label: '2026 rehearsal' }],
    });
    expect(cfg.legacyDeployments).toEqual([
      { manager: legacy.toLowerCase(), deploymentBlock: 7, relayerUrls: ['https://old-relay.example'], label: '2026 rehearsal' },
    ]);
    expect(validateConfig(base).legacyDeployments).toEqual([]);
    expect(() => validateConfig({ ...base, legacyDeployments: [{ manager: base.manager }] })).toThrow(/listed twice/);
    expect(() => validateConfig({ ...base, legacyDeployments: [{ manager: legacy, chainId: 1 }] })).toThrow(/app's chain/);
    expect(() => validateConfig({ ...base, legacyDeployments: [{ manager: 'nope' }] })).toThrow(/0x address/);
  });

  it('takes an optional DAVINCI registry address (reserved for the Elections connection)', () => {
    expect(validateConfig(base).davinciRegistry).toBeUndefined();
    expect(validateConfig({ ...base, davinciRegistry: null }).davinciRegistry).toBeUndefined();
    const registry = '0x00000000000000000000000000000000000000CC';
    expect(validateConfig({ ...base, davinciRegistry: registry }).davinciRegistry).toBe(registry.toLowerCase());
    expect(() => validateConfig({ ...base, davinciRegistry: '0x1234' })).toThrow(/davinciRegistry/);
  });

  it('rejects a devPrivateKey outside devMode', () => {
    expect(() => validateConfig({ ...base, devPrivateKey: `0x${'11'.repeat(32)}` })).toThrow(/devMode/);
  });
});

describe('config overrides (make ui-sepolia)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const fetchReturning = (body: unknown) =>
    vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

  it('loads the env-selected file and fills the placeholder URLs', async () => {
    vi.stubEnv('VITE_CONFIG', '/config.sepolia.json');
    vi.stubEnv('VITE_RELAYER_URL', 'https://relayer.example/sepolia');
    vi.stubEnv('VITE_ARTIFACTS_URL', 'https://artifacts.example/circuits');
    const fetchFn = fetchReturning({ ...base });
    const cfg = await loadConfig(fetchFn);
    expect(fetchFn).toHaveBeenCalledWith('/config.sepolia.json', { cache: 'no-cache' });
    expect(cfg.relayerUrls).toEqual(['https://relayer.example/sepolia']);
    expect(cfg.artifactsBaseUrls).toEqual(['https://artifacts.example/circuits']);
  });

  it('takes comma-separated lists from the env, in order', async () => {
    vi.stubEnv('VITE_RELAYER_URL', 'https://r1.example, https://r2.example');
    vi.stubEnv('VITE_ARTIFACTS_URL', 'https://m1.example/{release},https://m2.example/x');
    const cfg = await loadConfig(fetchReturning({ ...base }));
    expect(cfg.relayerUrls).toEqual(['https://r1.example', 'https://r2.example']);
    expect(cfg.artifactsBaseUrls).toEqual(['https://m1.example/{release}', 'https://m2.example/x']);
  });

  it('reads /config.json untouched without the env', async () => {
    const fetchFn = fetchReturning({ ...base });
    const cfg = await loadConfig(fetchFn);
    expect(fetchFn).toHaveBeenCalledWith('/config.json', { cache: 'no-cache' });
    expect(cfg.relayerUrls).toEqual(['https://relay.example']);
    expect(cfg.artifactsBaseUrls).toEqual([]);
  });
});
