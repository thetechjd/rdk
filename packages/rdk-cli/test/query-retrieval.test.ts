import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupIntoDocuments } from '../../rdk-core/src/retrieved.js';

const state = vi.hoisted(() => ({ query: vi.fn(), index: vi.fn(), fail: vi.fn(), succeed: vi.fn() }));
vi.mock('../src/config.js', () => ({ loadConfig: () => ({
  centralApiUrl: 'https://central.test', apiKey: 'key', nodeId: 'reader', domain: 'general',
}) }));
vi.mock('../src/require-dep.js', () => ({ requireDeps: async () => true }));
vi.mock('../src/model-egress.js', () => ({ modelEgress: () => ({ text: (s: string) => s, notice: () => null }) }));
vi.mock('../src/interactive.js', () => ({ isInteractive: () => false }));
vi.mock('../src/ws/events.js', () => ({ pushChunkIndexed: vi.fn() }));
vi.mock('ora', () => ({ default: () => ({ start() { return this; }, stop() {}, fail: state.fail, succeed: state.succeed }) }));
vi.mock('@rdk/node/ws/ownership', () => ({ withWsConnection: (fn: () => unknown) => fn() }));
vi.mock('@rdk/core', () => ({
  LocalStore: class {},
  LocalEmbeddingModel: class { async embed() { return new Float32Array(384).fill(0.1); } },
  RDKRouter: class { constructor(cfg: unknown) { (globalThis as Record<string, unknown>).__rdkRouterConfig = cfg; } query = state.query; },
  RDKIndexer: class { indexDocument = state.index; },
  keyFromHex: (s: string) => s,
  decrypt: (s: string) => s,
  groupIntoDocuments,
}));
const RouterSpy = { get lastConfig() { return (globalThis as Record<string, unknown>).__rdkRouterConfig; } };
import { unifiedQuery } from '../src/commands/query.js';
import { networkQuery } from '../src/commands/network.js';
import { publishUrl } from '../src/commands/publish.js';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = 0; });
const chunk = { chunkId: 'godot', title: 'Godot', nodeId: 'owner', score: 0.49, summary: '', content: '', categories: [], tipAmountUsdc: 0 };

describe('query CLI retrieval failures', () => {
  it('returns selectable JSON for a summary-less preview from an older node', async () => {
    state.query.mockResolvedValue({ source: 'network', chunks: [{ ...chunk, preview: true }] });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await unifiedQuery('Godot', { json: true, domain: 'all' });
    const result = JSON.parse(output.mock.calls[0][0]);
    expect(result).toMatchObject({ retrieved: false, reason: 'selection_required', documents: [{ chunkId: 'godot', name: 'Godot' }] });
    expect(state.query).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('reports empty grouped matches rather than silent stdout (json=%s)', async json => {
    state.query.mockResolvedValue({ source: 'network', chunks: [chunk] });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await unifiedQuery('Godot', { json });
    expect(output).toHaveBeenCalled();
    if (json) expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ retrieved: false, reason: 'content_unavailable' });
    else expect(output.mock.calls.flat().join(' ')).toContain('no readable content or previews');
  });
  it('sends lexical terms, requests unavailable matches, and removes the all-domain partition', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jwtToken: 'token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ ...chunk, available: false, unavailableReason: 'owner_offline' }] })));
    vi.stubGlobal('fetch', fetch);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await networkQuery('Godot', { domain: 'all' });
    const request = JSON.parse(fetch.mock.calls[1][1].body);
    expect(request).toMatchObject({ queryText: 'Godot', includeUnavailable: true });
    expect(request.domain).toBeUndefined();
    expect(output.mock.calls.flat().join(' ')).toContain('owner_offline');
  });
  it('does not partition by the node own domain when none is given', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jwtToken: 'token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    state.query.mockImplementation(async () => ({ source: 'network', chunks: [] }));
    await unifiedQuery('Godot', { json: true });
    // loadConfig() reports domain 'general'; a query that names no domain must
    // not inherit it, or content published under any other domain is invisible.
    expect(state.query).toHaveBeenCalledTimes(1);
    const cfg = (RouterSpy.lastConfig ?? {}) as { domain?: string };
    expect(cfg.domain).toBeUndefined();
  });
  it('does not report a rejected URL publication as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<title>Godot</title>article')));
    state.index.mockResolvedValue({ chunksIndexed: 1, errors: ['Central did not accept 1 chunk(s); pending sync'] });
    await publishUrl('https://example.test/Godot', {});
    expect(state.succeed).not.toHaveBeenCalled();
    expect(state.fail).toHaveBeenCalledWith(expect.stringContaining('pending sync'));
    expect(process.exitCode).toBe(1);
  });
});
