import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  apiServe, readTokenFile, resolveHost, startApiServer,
  type ApiNetworkChunk, type ApiServeDeps,
} from '../src/commands/api-serve.js';

/**
 * SPEC 02 Phase 5 item 7: `rdk api:serve` refuses 0.0.0.0, refuses a
 * world-readable token file, rejects a bad token, and stops fetching at the tip
 * cap (RDK_PL_00A C5). Central is a stub; no network.
 */

const TOKEN = 'plq-test-token-0123456789abcdef';
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  vi.restoreAllMocks();
  process.exitCode = 0;
});

function tokenFile(mode: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-api-token-'));
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, `${TOKEN}\n`);
  fs.chmodSync(file, mode);
  return file;
}

function chunk(id: string, score: number, tip: number, extra: Partial<ApiNetworkChunk> = {}): ApiNetworkChunk {
  return {
    chunkId: id, nodeId: `node-${id}`, title: `Doc ${id}`, summary: `summary ${id}`, score, tipAmountUsdc: tip,
    categories: ['parlayledger', 'basketball'], available: true,
    externalRef: { partner: 'parlayledger', ref: `pub_${id}` },
    attestation: { kind: 'strategy', status: 'verified_winning', record: { sample: 41 }, signedAt: '2026-10-11T23:58:00Z' },
    publisherRecord: { sample: 120 },
    ...extra,
  };
}

function fakeDeps(preview: ApiNetworkChunk[], opts: { failSelectOn?: string; status?: number } = {}) {
  const network = vi.fn<ApiServeDeps['network']>(async (_q, _e, o) => {
    if (o.previewOnly) return { results: preview.map((c) => ({ ...c, preview: true })), queryId: 'q-123' };
    if (o.selectedChunkId === opts.failSelectOn) {
      throw Object.assign(new Error('Insufficient balance'), { status: opts.status ?? 402 });
    }
    const c = preview.find((x) => x.chunkId === o.selectedChunkId)!;
    return { results: [{ ...c, contentEncrypted: `full text of ${c.chunkId}` }], queryId: 'q-sel' };
  });
  const deps: ApiServeDeps = {
    nodeId: 'pl-query-node',
    embed: async () => new Float32Array(384).fill(0.1),
    network,
    privateSearch: async () => [],
    wsConnected: () => true,
    walletBalanceUsdc: async () => 12.5,
  };
  return { deps, network };
}

async function serve(deps: ApiServeDeps): Promise<string> {
  const server = await startApiServer({ port: 0, token: TOKEN, deps });
  servers.push(server);
  const addr = server.address() as AddressInfo;
  expect(addr.address).toBe('127.0.0.1');
  return `http://127.0.0.1:${addr.port}`;
}

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

describe('startup checks', () => {
  it('refuses to bind anywhere but 127.0.0.1', async () => {
    expect(resolveHost(undefined)).toBe('127.0.0.1');
    expect(resolveHost('127.0.0.1')).toBe('127.0.0.1');
    for (const host of ['0.0.0.0', '::', 'localhost', '192.168.1.10']) expect(() => resolveHost(host)).toThrow(/Refusing to bind/);
    await expect(startApiServer({ port: 0, host: '0.0.0.0', token: TOKEN, deps: fakeDeps([]).deps })).rejects.toThrow(/Refusing/);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await apiServe({ port: 0, host: '0.0.0.0', tokenFile: tokenFile(0o600) })).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.flat().join(' ')).toContain('Refusing to bind to 0.0.0.0');
  });

  it.skipIf(process.platform === 'win32')('refuses a token file readable by group or others', async () => {
    expect(readTokenFile(tokenFile(0o600))).toBe(TOKEN);
    for (const mode of [0o644, 0o640, 0o604, 0o660]) expect(() => readTokenFile(tokenFile(mode))).toThrow(/chmod 600/);
    expect(() => readTokenFile(undefined)).toThrow(/token file is required/i);
    expect(() => readTokenFile('/nonexistent/token')).toThrow(/not found/);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await apiServe({ port: 0, tokenFile: tokenFile(0o644) })).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.flat().join(' ')).toContain('chmod 600');
  });
});

describe('requests', () => {
  it('rejects a missing or wrong bearer token with 401', async () => {
    const { deps, network } = fakeDeps([chunk('a', 0.9, 0.01)]);
    const base = await serve(deps);
    for (const headers of [{}, { Authorization: 'Bearer wrong-token-wrong-token' }, { Authorization: TOKEN }]) {
      const res = await fetch(`${base}/v1/query`, { method: 'POST', headers, body: JSON.stringify({ q: 'x' }) });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect((await fetch(`${base}/v1/health`)).status).toBe(401);
    expect(network).not.toHaveBeenCalled();
  });

  it('walks results in score order and stops fetching at the tip cap', async () => {
    // Preview tips 0.10 each; cap 0.25 → two retrievals, the third is skipped.
    const preview = [chunk('c', 0.70, 0.10), chunk('a', 0.90, 0.10), chunk('b', 0.80, 0.10), chunk('d', 0.60, 0.01)];
    const { deps, network } = fakeDeps(preview);
    const base = await serve(deps);
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        q: 'NBA unders when both teams are on no rest', topK: 8,
        filters: { externalPartner: 'parlayledger', attestedStatus: ['verified_winning', 'graded'], categories: ['basketball'] },
        maxTipUsdc: 0.25, requestId: 'plq_01J9',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Phase 1 carried the filters; phase 2 selected only a and b.
    expect(network.mock.calls[0][2]).toMatchObject({
      previewOnly: true,
      filters: { externalPartner: 'parlayledger', attestedStatus: ['verified_winning', 'graded'], categories: ['basketball'] },
    });
    const selected = network.mock.calls.slice(1).map((c) => c[2].selectedChunkId);
    expect(selected).toEqual(['a', 'b']);

    expect(body).toMatchObject({ requestId: 'plq_01J9', queryId: 'q-123', tipSpentUsdc: 0.2 });
    expect(body.results.map((r: { chunkId: string }) => r.chunkId)).toEqual(['a', 'b', 'c', 'd']);
    expect(body.results[0]).toEqual({
      chunkId: 'a', nodeId: 'node-a', title: 'Doc a', summary: 'summary a', content: 'full text of a',
      score: 0.9, tipPaidUsdc: 0.1, categories: ['parlayledger', 'basketball'],
      externalRef: { partner: 'parlayledger', ref: 'pub_a' },
      attestation: { kind: 'strategy', status: 'verified_winning', record: { sample: 41 }, signedAt: '2026-10-11T23:58:00Z' },
      publisherRecord: { sample: 120 }, skippedReason: null,
    });
    // Once the cap stops the walk, the rest are skipped (even a cheaper one).
    for (const r of body.results.slice(2)) expect(r).toMatchObject({ content: null, tipPaidUsdc: 0, skippedReason: 'tip_cap' });
  });

  it('returns 402 wallet_insufficient with the results fetched so far', async () => {
    const { deps } = fakeDeps([chunk('a', 0.9, 0.05), chunk('b', 0.8, 0.05)], { failSelectOn: 'b' });
    const base = await serve(deps);
    const res = await fetch(`${base}/v1/query`, { method: 'POST', headers: auth, body: JSON.stringify({ q: 'x', requestId: 'r1' }) });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'wallet_insufficient', requestId: 'r1', tipSpentUsdc: 0.05 });
    expect(body.results[0]).toMatchObject({ chunkId: 'a', content: 'full text of a' });
    expect(body.results[1]).toMatchObject({ chunkId: 'b', content: null, skippedReason: 'wallet_insufficient' });
  });

  it('returns 503 central_unreachable when Central cannot be reached', async () => {
    const { deps } = fakeDeps([]);
    deps.network = async () => { throw new TypeError('fetch failed'); };
    const base = await serve(deps);
    const res = await fetch(`${base}/v1/query`, { method: 'POST', headers: auth, body: JSON.stringify({ q: 'x' }) });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'central_unreachable' });
  });

  it.each([
    [{}], [{ q: '' }], [{ q: 'x', topK: 0 }], [{ q: 'x', tiers: ['everything'] }],
    [{ q: 'x', maxTipUsdc: -1 }], [{ q: 'x', filters: { externalPartner: '../x' } }],
  ])('rejects %j with 422 invalid_request', async (payload) => {
    const { deps, network } = fakeDeps([]);
    const base = await serve(deps);
    const res = await fetch(`${base}/v1/query`, { method: 'POST', headers: auth, body: JSON.stringify(payload) });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
    expect(network).not.toHaveBeenCalled();
  });

  it('serves /v1/health', async () => {
    const base = await serve(fakeDeps([]).deps);
    const res = await fetch(`${base}/v1/health`, { headers: auth });
    expect(await res.json()).toEqual({ ok: true, nodeId: 'pl-query-node', wsConnected: true, walletBalanceUsdc: 12.5 });
  });
});
