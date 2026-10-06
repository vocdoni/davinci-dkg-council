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
    expect(cfg.relayerUrl).toBe('https://relayer.example/sepolia');
    expect(cfg.artifactsBaseUrl).toBe('https://artifacts.example/circuits');
  });

  it('reads /config.json untouched without the env', async () => {
    const fetchFn = fetchReturning({ ...base });
    const cfg = await loadConfig(fetchFn);
    expect(fetchFn).toHaveBeenCalledWith('/config.json', { cache: 'no-cache' });
    expect(cfg.relayerUrl).toBe('https://relay.example');
    expect(cfg.artifactsBaseUrl).toBeNull();
  });
});
