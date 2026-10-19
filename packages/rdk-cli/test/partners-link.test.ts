import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SPEC 02 Phase 5 items 1 and 2: `rdk link` prints the exact strings, and
 * `rdk init --link` on a clean RDK_HOME creates a node and links it in one run
 * with no RetroDeck credentials. Central is mocked; nothing touches the network.
 */

vi.hoisted(() => {
  // init.ts reads these into module-level constants at import time.
  process.env.RDK_CENTRAL_URL = 'https://central.test';
  process.env.RETRODECK_API_URL = 'https://retrodeck.test';
});

import { saveConfig, loadConfig } from '../src/config.js';
import { linkPartner } from '../src/commands/partners.js';
import { runInit } from '../src/commands/init.js';

const HOME = process.env.RDK_HOME!;
const CONFIG = path.join(HOME, 'config.json');
const LINK = {
  partnerId: 'parlayledger', partnerName: 'ParlayLedger', linkId: 'lnk_01J9',
  accountId: '6f1c2d3e-0000-4000-8000-000000000001', allowedJobTypes: ['publish_doc', 'unpublish_doc', 'ping'],
};
const OWNED_MESSAGE =
  'This node belongs to a different RetroDeck account. To pair a node for this account, set up a new one with: rdk init --link <code>';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let out: string[];
let err: string[];

function stubCentral(opts: { register?: 'ok' | 'fail' } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method ?? 'GET', body });
    const json = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://central.test/api/v1/nodes/register') {
      return opts.register === 'fail' ? json(500, { message: 'boom' }) : json(201, { nodeId: 'node-new', apiKey: 'rdk_live_new' });
    }
    if (url === 'https://central.test/api/v1/nodes/auth') return json(200, { jwtToken: 'node-jwt' });
    if (url === 'https://central.test/api/v1/nodes/partner-link') {
      switch ((body as { pairCode: string }).pairCode) {
        case 'K7Q2M9XD': return json(200, LINK);
        case 'EXP1RED0': return json(410, { code: 'pair_code_expired', message: 'Pair code expired' });
        case 'XSED0000': return json(409, { code: 'pair_code_used', message: 'Pair code already used' });
        case 'TAKEN000': return json(409, { code: 'node_owned_by_other_account', message: OWNED_MESSAGE });
        default: return json(404, { code: 'pair_code_invalid', message: 'Pair code not found' });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

beforeEach(() => {
  calls = []; out = []; err = [];
  fs.rmSync(CONFIG, { force: true });
  fs.rmSync(path.join(HOME, 'partners'), { recursive: true, force: true });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  process.exitCode = 0;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = 0; });

function registeredNode() {
  saveConfig({
    nodeId: 'node-1', apiKey: 'rdk_live_x', centralApiUrl: 'https://central.test',
    plan: 'free', vaultAdapter: 'filesystem', vaultPath: '', domain: 'general',
    walletChain: 'base', mcpPort: 4242, createdAt: new Date().toISOString(),
  });
}

describe('rdk link <code>', () => {
  it('prints exactly the SPEC 02 success text and saves the link', async () => {
    registeredNode();
    stubCentral();
    expect(await linkPartner('K7Q2-M9XD')).toBe(true);
    expect(out).toEqual([
      'Linked to ParlayLedger.',
      'Picks and strategies you publish on ParlayLedger will be saved to this node and shared on the RDK network.',
      'Keep `rdk mcp:serve` running so your publications can be retrieved and you can earn.',
    ]);
    expect(process.exitCode).toBe(0);
    const config = loadConfig();
    expect(config.retrodeckUserId).toBe(LINK.accountId);
    expect(config.partners?.parlayledger).toMatchObject({ name: 'ParlayLedger', linkId: 'lnk_01J9', enabled: true });
    expect(fs.statSync(path.join(HOME, 'partners', 'parlayledger')).mode & 0o777).toBe(0o700);
    const pair = calls.find((c) => c.url.endsWith('/partner-link'))!;
    expect(pair.body).toEqual({ pairCode: 'K7Q2M9XD' });
  });

  it.each([
    ['ABCD-EFGH', 'That code is not valid. Get a new one from your ParlayLedger dashboard.'],
    ['EXP1-RED0', 'That code expired. Get a new one from your ParlayLedger dashboard.'],
    ['XSED-0000', 'That code was already used. Get a new one from your ParlayLedger dashboard.'],
    ['TAKE-N000', OWNED_MESSAGE],
    ['not-a-code!', 'That code is not valid. Get a new one from your ParlayLedger dashboard.'],
  ])('%s prints the mapped message and exits 1', async (code, message) => {
    registeredNode();
    stubCentral();
    expect(await linkPartner(code)).toBe(false);
    expect(err).toEqual([message]);
    expect(out).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(loadConfig().partners).toBeUndefined();
  });

  it('without a registered node points at rdk init --link', async () => {
    stubCentral();
    expect(await linkPartner('K7Q2-M9XD')).toBe(false);
    expect(err).toEqual(['No node found. Run: rdk init --link K7Q2-M9XD']);
    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);

    saveConfig({ ...loadConfigLike(), nodeId: 'local-123', apiKey: 'rdk_local_abc' });
    err = [];
    expect(await linkPartner('K7Q2-M9XD')).toBe(false);
    expect(err).toEqual(['No node found. Run: rdk init --link K7Q2-M9XD']);
  });
});

function loadConfigLike() {
  return {
    nodeId: 'x', apiKey: 'x', centralApiUrl: 'https://central.test', plan: 'free', vaultAdapter: 'filesystem',
    vaultPath: '', domain: 'general', walletChain: 'base', mcpPort: 4242, createdAt: new Date().toISOString(),
  };
}

describe('rdk init --link <code>', () => {
  it('creates a node and links it in one run on a clean RDK_HOME, with no RetroDeck credentials', async () => {
    stubCentral();
    expect(fs.existsSync(CONFIG)).toBe(false);
    await runInit({ link: 'K7Q2-M9XD', yes: true, mcpConfig: false, autostart: false });

    expect(process.exitCode).toBe(0);
    const config = loadConfig();
    expect(config.nodeId).toBe('node-new');
    expect(config.apiKey).toBe('rdk_live_new');
    expect(config.retrodeckUserId).toBe(LINK.accountId);
    expect(config.retrodeckAccessToken).toBeUndefined();
    expect(config.vaultKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(config.partners?.parlayledger).toMatchObject({ linkId: 'lnk_01J9', enabled: true });
    expect(out).toContain('Linked to ParlayLedger.');

    // Never touched the RetroDeck account API: no sign-in, no registration.
    expect(calls.some((c) => c.url.startsWith('https://retrodeck.test'))).toBe(false);
    const register = calls.find((c) => c.url.endsWith('/nodes/register'))!;
    expect((register.body as { email: string }).email).toMatch(/@pairing\.invalid$/);
    // Registration happened before pairing.
    expect(calls.findIndex((c) => c.url.endsWith('/nodes/register')))
      .toBeLessThan(calls.findIndex((c) => c.url.endsWith('/partner-link')));
  });

  it('does not attempt the link when node setup fails', async () => {
    stubCentral({ register: 'fail' });
    await runInit({ link: 'K7Q2-M9XD', yes: true, mcpConfig: false, autostart: false });
    expect(process.exitCode).toBe(1);
    expect(calls.some((c) => c.url.endsWith('/partner-link'))).toBe(false);
    expect(fs.existsSync(CONFIG)).toBe(false);
  });

  it('refuses a malformed code before setting anything up', async () => {
    stubCentral();
    await runInit({ link: 'nope', yes: true, mcpConfig: false, autostart: false });
    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(err).toEqual(['That code is not valid. Get a new one from your ParlayLedger dashboard.']);
  });

  it('on a machine that already has a node, only links (keeps identity and vault key)', async () => {
    registeredNode();
    stubCentral();
    await runInit({ link: 'K7Q2-M9XD', yes: true });
    expect(calls.some((c) => c.url.endsWith('/nodes/register'))).toBe(false);
    expect(loadConfig().nodeId).toBe('node-1');
    expect(loadConfig().partners?.parlayledger.linkId).toBe('lnk_01J9');
  });
});
