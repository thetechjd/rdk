import { saveConfig, type RDKConfig } from '../../src/config.js';

/**
 * Write a `~/.rdk/config.json` as `rdk init` would leave it.
 *
 * `RDK_HOME` is redirected to a temp dir in `test/setup.ts` — which runs before
 * any module is imported, because `config.ts` captures the directory in a
 * module-level const. Without that, these writes would land in the developer's
 * real config and clobber their live tokens.
 */
export function seedCliConfig(apiUrl: string, overrides: Partial<RDKConfig> = {}): void {
  saveConfig({
    nodeId: 'node-test',
    apiKey: 'test-api-key',
    centralApiUrl: 'http://127.0.0.1:1',
    plan: 'free',
    vaultAdapter: 'filesystem',
    vaultPath: '/tmp/vault',
    domain: 'test',
    walletChain: 'base',
    mcpPort: 7777,
    createdAt: new Date(0).toISOString(),
    retrodeckApiUrl: apiUrl,
    retrodeckAccessToken: 'access-1',
    retrodeckRefreshToken: 'refresh-1',
    ...overrides,
  });
}

/** A `sleep` that resolves immediately, so poll loops don't wait in real time. */
export const noSleep = async (): Promise<void> => {};
