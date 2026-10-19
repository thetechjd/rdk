import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, saveConfig } from '../src/config.js';
import {
  isWellFormedPairCode, normalizePairCode, redeemPairCode, removePartnerLink, savePartnerLink,
  setPartnerEnabled, PartnerLinkError,
} from '../src/partner-link.js';
import { syncWalletToCentral } from '../src/central-client.js';
import { ensureNodeLinked, linkRetrodeckOnCentral } from '../src/link-node.js';

/** Pairing (00A C1), wallet sync (C6) and link-retrodeck proof (D), against a mocked Central. */

const CENTRAL = 'https://central.test';
const LINK = {
  partnerId: 'parlayledger', partnerName: 'ParlayLedger', linkId: 'lnk_01J9',
  accountId: '6f1c2d3e-0000-4000-8000-000000000001', allowedJobTypes: ['publish_doc', 'unpublish_doc', 'ping'],
};

function baseConfig() {
  return {
    nodeId: 'node-1', apiKey: 'rdk_live_x', centralApiUrl: CENTRAL,
    plan: 'free', vaultAdapter: 'filesystem', vaultPath: '', domain: 'general',
    walletChain: 'base', mcpPort: 4242, createdAt: new Date().toISOString(),
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];

function stubCentral(route: (url: string, body: unknown) => Response | undefined) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body });
    if (url.endsWith('/api/v1/nodes/auth')) return new Response(JSON.stringify({ jwtToken: 'node-jwt' }));
    const res = route(url, body);
    if (res) return res;
    throw new Error(`unexpected ${url}`);
  }));
}

beforeEach(() => { calls = []; saveConfig(baseConfig()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('pair codes', () => {
  it('normalizes case, spaces and dashes', () => {
    expect(normalizePairCode(' k7q2-m9xd ')).toBe('K7Q2M9XD');
    expect(isWellFormedPairCode('k7q2 m9xd')).toBe(true);
    expect(isWellFormedPairCode('K7Q2-M9X')).toBe(false);
    expect(isWellFormedPairCode('K7Q2-M9XU')).toBe(false); // U is not Crockford
  });

  it('redeems on Central with the node JWT and the normalized code', async () => {
    stubCentral((url) => url.endsWith('/api/v1/nodes/partner-link') ? new Response(JSON.stringify(LINK)) : undefined);
    const link = await redeemPairCode({ centralApiUrl: CENTRAL, apiKey: 'rdk_live_x', pairCode: 'k7q2-m9xd' });
    expect(link).toEqual(LINK);
    const call = calls.find((c) => c.url === `${CENTRAL}/api/v1/nodes/partner-link`)!;
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer node-jwt');
    expect(call.body).toEqual({ pairCode: 'K7Q2M9XD' });
  });

  it.each([
    [404, 'pair_code_invalid'], [410, 'pair_code_expired'], [409, 'pair_code_used'], [409, 'node_owned_by_other_account'],
  ])('surfaces HTTP %i %s as a PartnerLinkError with the platform message', async (status, code) => {
    stubCentral(() => new Response(JSON.stringify({ code, message: `platform says ${code}` }), { status }));
    const err = await redeemPairCode({ centralApiUrl: CENTRAL, apiKey: 'k', pairCode: 'K7Q2M9XD' }).catch((e) => e);
    expect(err).toBeInstanceOf(PartnerLinkError);
    expect(err).toMatchObject({ code, status, message: `platform says ${code}` });
  });

  it("reads Nest's error envelope too", async () => {
    stubCentral(() => new Response(JSON.stringify({ statusCode: 410, error: { code: 'pair_code_expired', message: 'gone' } }), { status: 410 }));
    await expect(redeemPairCode({ centralApiUrl: CENTRAL, apiKey: 'k', pairCode: 'K7Q2M9XD' }))
      .rejects.toMatchObject({ code: 'pair_code_expired', message: 'gone' });
  });
});

describe('partners config block', () => {
  it('saves the link, the account as retrodeckUserId and a private managed folder', () => {
    savePartnerLink(LINK, new Date('2026-10-11T18:00:00Z'));
    const config = loadConfig();
    expect(config.retrodeckUserId).toBe(LINK.accountId);
    expect(config.partners).toEqual({
      parlayledger: {
        name: 'ParlayLedger', linkId: 'lnk_01J9', enabled: true,
        allowedJobTypes: ['publish_doc', 'unpublish_doc', 'ping'], linkedAt: '2026-10-11T18:00:00.000Z',
      },
    });
    const dir = path.join(process.env.RDK_HOME!, 'partners', 'parlayledger');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    // Nothing in the block is secret, so it is stored in the clear.
    const raw = JSON.parse(fs.readFileSync(path.join(process.env.RDK_HOME!, 'config.json'), 'utf8'));
    expect(raw.partners.parlayledger.linkId).toBe('lnk_01J9');
  });

  it('enables, disables and removes', () => {
    savePartnerLink(LINK);
    expect(setPartnerEnabled('parlayledger', false)).toBe(true);
    expect(loadConfig().partners?.parlayledger.enabled).toBe(false);
    expect(setPartnerEnabled('nope', true)).toBe(false);
    expect(removePartnerLink('parlayledger')).toBe(true);
    expect(loadConfig().partners).toBeUndefined();
    expect(removePartnerLink('parlayledger')).toBe(false);
  });
});

describe('wallet sync (00A C6)', () => {
  it('PATCHes /nodes/me/wallet with the node JWT', async () => {
    stubCentral((url) => url.endsWith('/api/v1/nodes/me/wallet') ? new Response(null, { status: 204 }) : undefined);
    const addr = '0x' + 'ab'.repeat(20);
    expect(await syncWalletToCentral({ centralApiUrl: CENTRAL, apiKey: 'k', walletAddress: addr, walletChain: 'base' }))
      .toEqual({ ok: true });
    const call = calls.find((c) => c.url.endsWith('/nodes/me/wallet'))!;
    expect(call).toMatchObject({ method: 'PATCH', body: { walletAddress: addr, walletChain: 'base' } });
    expect(call.headers.Authorization).toBe('Bearer node-jwt');
  });

  it('is best effort: an offline Central reports, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const r = await syncWalletToCentral({ centralApiUrl: CENTRAL, apiKey: 'k', walletAddress: '0x' + '1'.repeat(40), walletChain: 'base' });
    expect(r.ok).toBe(false);
  });

  it('refuses a malformed address without calling Central', async () => {
    stubCentral(() => undefined);
    const r = await syncWalletToCentral({ centralApiUrl: CENTRAL, apiKey: 'k', walletAddress: '0x123', walletChain: 'base' });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('link-retrodeck proof (00A D)', () => {
  it('sends retrodeckAccessToken with retrodeckUserId', async () => {
    stubCentral((url) => url.includes('/link-retrodeck') ? new Response(JSON.stringify({ linked: true })) : undefined);
    const r = await linkRetrodeckOnCentral({
      centralApiUrl: CENTRAL, nodeId: 'node-1', apiKey: 'k', retrodeckUserId: 'user-1', retrodeckAccessToken: 'rd-token',
    });
    expect(r).toEqual({ ok: true });
    const call = calls.find((c) => c.url === `${CENTRAL}/api/v1/nodes/node-1/link-retrodeck`)!;
    expect(call.body).toEqual({ retrodeckUserId: 'user-1', retrodeckAccessToken: 'rd-token' });
    expect(call.headers.Authorization).toBe('Bearer node-jwt');
  });

  it('reports link_proof_required without throwing', async () => {
    stubCentral(() => new Response(JSON.stringify({ code: 'link_proof_required' }), { status: 403 }));
    const r = await linkRetrodeckOnCentral({
      centralApiUrl: CENTRAL, nodeId: 'node-1', jwt: 'j', retrodeckUserId: 'u', retrodeckAccessToken: 't',
    });
    expect(r).toEqual({ ok: false, reason: 'link_proof_required (HTTP 403)' });
  });

  it('account:relink (ensureNodeLinked) records the binding on Central with the proof', async () => {
    saveConfig({ ...baseConfig(), retrodeckUserId: 'user-1', retrodeckAccessToken: 'rd-token', retrodeckApiUrl: 'https://api.test' });
    stubCentral((url) => {
      if (url === 'https://api.test/api/v1/nodes/me') return new Response(JSON.stringify([{ node_id: 'node-1' }]));
      if (url.includes('/link-retrodeck')) return new Response(JSON.stringify({ linked: true }));
      return undefined;
    });
    const r = await ensureNodeLinked();
    expect(r.status).toBe('already-linked');
    const call = calls.find((c) => c.url.includes('/link-retrodeck'))!;
    expect(call.body).toEqual({ retrodeckUserId: 'user-1', retrodeckAccessToken: 'rd-token' });
  });
});
