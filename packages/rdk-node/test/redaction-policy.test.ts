import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveRedactionPolicy, redactionIsActive, setActiveRedactionPolicy } from '@rdk/core';
import { rdkDir, saveConfig, type RDKConfig } from '../src/config.js';
import {
  installCachedRedactionPolicy,
  nodeTokenSalt,
  readCachedPolicy,
  redactionStatus,
  refreshRedactionPolicy,
} from '../src/redaction-policy.js';

/**
 * The node half of the org redaction policy.
 *
 * Everything here is about ONE property: an employee must not be able to switch
 * enforcement off. On their own machine the levers available to them are the
 * config file and the network, so the tests are mostly about what happens when
 * those are taken away - and the answer has to be "the cached policy keeps
 * being enforced", not "content flows to the model in the clear".
 */

const SSN_RULE = { ruleType: 'builtin' as const, builtinKey: 'ssn', tokenPrefix: 'SSN' };

function writeConfig(overrides: Partial<RDKConfig> = {}): void {
  saveConfig({
    nodeId: 'node-1',
    apiKey: 'api-key',
    centralApiUrl: 'https://rdk.retrodeck.ai',
    retrodeckApiUrl: 'https://api.retrodeck.test',
    retrodeckAccessToken: 'access-token',
    retrodeckRefreshToken: 'refresh-token',
    plan: 'free',
    vaultAdapter: 'filesystem',
    vaultPath: '/tmp/vault',
    domain: 'test',
    walletChain: 'base',
    mcpPort: 4242,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  });
}

function cachePolicy(body: { enabled: boolean; version: string; rules: unknown[]; orgs?: unknown[] }): void {
  fs.writeFileSync(
    path.join(rdkDir(), 'redaction-policy.json'),
    JSON.stringify({ ...body, fetchedAt: new Date(0).toISOString() }),
  );
}

function clearCache(): void {
  fs.rmSync(path.join(rdkDir(), 'redaction-policy.json'), { force: true });
}

/** Stub the policy endpoint. */
function respondWith(status: number, body?: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    body === undefined ? '' : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  )));
}

beforeEach(() => {
  clearCache();
  setActiveRedactionPolicy(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('installing the cached policy', () => {
  it('enforces nothing when no policy has ever been fetched', () => {
    const policy = installCachedRedactionPolicy();
    expect(policy.enabled).toBe(false);
    expect(redactionIsActive()).toBe(false);
  });

  it('installs the cached policy synchronously, before any query can run', () => {
    cachePolicy({ enabled: true, version: 'v1', rules: [SSN_RULE] });
    installCachedRedactionPolicy();
    expect(redactionIsActive()).toBe(true);
    expect(getActiveRedactionPolicy().version).toBe('v1');
  });

  it('attaches this node\'s salt so tokens are non-invertible and stable', () => {
    cachePolicy({ enabled: true, version: 'v1', rules: [SSN_RULE] });
    installCachedRedactionPolicy();
    const salt = getActiveRedactionPolicy().tokenSalt;
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    // Same salt on the next start, or tokens would not survive a restart.
    expect(nodeTokenSalt()).toBe(salt);
  });

  it('ignores a corrupt cache rather than crashing the node', () => {
    fs.writeFileSync(path.join(rdkDir(), 'redaction-policy.json'), 'not json');
    expect(readCachedPolicy()).toBeNull();
    expect(installCachedRedactionPolicy().enabled).toBe(false);
  });
});

describe('refreshing', () => {
  it('installs and caches what the API returns', async () => {
    writeConfig();
    respondWith(200, {
      enabled: true,
      version: 'v2',
      rules: [SSN_RULE],
      orgs: [{ id: 'org-1', name: 'Acme' }],
    });

    const policy = await refreshRedactionPolicy(() => {});
    expect(policy.enabled).toBe(true);
    expect(policy.version).toBe('v2');
    expect(readCachedPolicy()?.version).toBe('v2');
    expect(redactionStatus()).toMatchObject({ enabled: true, version: 'v2', ruleCount: 1 });
  });

  it('turns enforcement off when the admin clears the policy', async () => {
    cachePolicy({ enabled: true, version: 'v1', rules: [SSN_RULE] });
    writeConfig();
    respondWith(200, { enabled: false, version: 'v2', rules: [] });

    const policy = await refreshRedactionPolicy(() => {});
    expect(policy.enabled).toBe(false);
    expect(redactionIsActive()).toBe(false);
  });
});

describe('fail closed', () => {
  it('keeps enforcing the cached policy when the API is unreachable', async () => {
    cachePolicy({ enabled: true, version: 'v1', rules: [SSN_RULE] });
    writeConfig();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const policy = await refreshRedactionPolicy(() => {});
    expect(policy.enabled).toBe(true);
    expect(policy.version).toBe('v1');
    expect(redactionIsActive()).toBe(true);
  });

  it('keeps enforcing when the API errors', async () => {
    cachePolicy({ enabled: true, version: 'v1', rules: [SSN_RULE] });
    writeConfig();
    respondWith(500, { message: 'boom' });

    expect((await refreshRedactionPolicy(() => {})).enabled).toBe(true);
  });

  it('keeps enforcing when the RetroDeck session is gone', async () => {
    // Deleting your credentials is the cheapest bypass anyone would try.
    cachePolicy({ enabled: true, version: 'v1', rules: [SSN_RULE] });
    writeConfig({ retrodeckAccessToken: undefined, retrodeckRefreshToken: undefined });

    expect((await refreshRedactionPolicy(() => {})).enabled).toBe(true);
    expect(redactionIsActive()).toBe(true);
  });

  it('keeps enforcing when the API is too old to know about redaction', async () => {
    cachePolicy({ enabled: true, version: 'v1', rules: [SSN_RULE] });
    writeConfig();
    respondWith(404);

    expect((await refreshRedactionPolicy(() => {})).enabled).toBe(true);
  });

  it('keeps enforcing when the response is malformed', async () => {
    cachePolicy({ enabled: true, version: 'v1', rules: [SSN_RULE] });
    writeConfig();
    respondWith(200, { unexpected: true });

    expect((await refreshRedactionPolicy(() => {})).enabled).toBe(true);
  });

  it('does not invent a policy when there was never one to keep', async () => {
    writeConfig();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    expect((await refreshRedactionPolicy(() => {})).enabled).toBe(false);
  });
});

describe('status', () => {
  it('reports counts and provenance, never values', () => {
    cachePolicy({
      enabled: true,
      version: 'v9',
      rules: [SSN_RULE, { ...SSN_RULE, enabled: false }],
      orgs: [{ id: 'org-1', name: 'Acme' }],
    });

    const status = redactionStatus();
    expect(status).toMatchObject({ enabled: true, version: 'v9', ruleCount: 1 });
    expect(status.orgs).toEqual([{ id: 'org-1', name: 'Acme' }]);
    // The token map is the sensitive artifact and has no business in a status
    // line; nothing here should be able to carry one.
    expect(JSON.stringify(status)).not.toMatch(/token(Map|Salt)/i);
  });

  it('reports disabled when a policy exists but has no active rules', () => {
    cachePolicy({ enabled: true, version: 'v1', rules: [] });
    expect(redactionStatus().enabled).toBe(false);
  });
});
