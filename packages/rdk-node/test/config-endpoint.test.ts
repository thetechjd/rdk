import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CENTRAL_API_URL,
  loadConfig,
  saveConfig,
  type RDKConfig,
} from '../src/config.js';

const config = (centralApiUrl: string): RDKConfig => ({
  nodeId: 'node-test',
  apiKey: 'api-key',
  centralApiUrl,
  plan: 'free',
  vaultAdapter: 'filesystem',
  vaultPath: '/tmp/vault',
  domain: 'test',
  walletChain: 'base',
  mcpPort: 4242,
  createdAt: new Date(0).toISOString(),
});

describe('Central production endpoint migration', () => {
  it('uses the hostname actually routed by production', () => {
    expect(DEFAULT_CENTRAL_API_URL).toBe('https://rdk.retrodeck.ai');
  });

  it('repairs configs created with the dead api.rdk.network hostname', () => {
    saveConfig(config('https://api.rdk.network'));
    expect(loadConfig().centralApiUrl).toBe(DEFAULT_CENTRAL_API_URL);
  });

  it('preserves explicit custom and development endpoints', () => {
    saveConfig(config('http://127.0.0.1:3000'));
    expect(loadConfig().centralApiUrl).toBe('http://127.0.0.1:3000');
  });
});
