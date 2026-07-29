import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RDKRouter, type NetworkChunk } from '../src/router.js';
import type { LocalStore, SearchResult } from '../src/store/local-store.js';
import type { EmbeddingModel } from '../src/models/embedding.js';

/** A LocalStore stand-in — the router only searches and logs. */
function fakeStore(results: Partial<SearchResult>[]): LocalStore {
  return {
    search: () => results.map((r, i) => ({
      id: `local-${i}`, title: 'local', content: 'local body', categories: [],
      isPublic: false, isEncrypted: false, qualityScore: 0,
      createdAt: new Date(), updatedAt: new Date(), score: 0, ...r,
    })) as SearchResult[],
    logQuery: () => {},
    enqueueTip: () => 'tip-id',
  } as unknown as LocalStore;
}

const embedder = { embed: async () => new Float32Array(384).fill(0.1) } as unknown as EmbeddingModel;

function router(store: LocalStore) {
  return new RDKRouter({
    localStore: store,
    embeddingModel: embedder,
    centralApiUrl: 'https://central.test',
    centralApiKey: 'key',
    nodeId: 'me',
  });
}

function mockCentral(status: number, body: unknown) {
  return vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('/nodes/auth')) {
      return new Response(JSON.stringify({ jwtToken: 'jwt' }), { status: 200 });
    }
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  });
}

const networkChunk = (over: Partial<NetworkChunk> = {}): NetworkChunk => ({
  chunkId: 'c1', nodeId: 'other', title: 'Some Doc — Section', score: 0.9,
  tipAmountUsdc: 0, categories: [], ...over,
});

describe('RDKRouter network results', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('reads the body Central sends as contentEncrypted', async () => {
    // Central's wire name for live-fetched content. Reading only `content` left
    // every network result with an empty body.
    globalThis.fetch = mockCentral(200, {
      results: [networkChunk({ contentEncrypted: 'the actual content', available: true })],
      queryId: 'q', settledByCentral: true,
    }) as never;

    const result = await router(fakeStore([])).query('anything');
    expect(result.source).toBe('network');
    expect(result.context).toContain('the actual content');
  });

  it('sends the raw query text so Central can recognize exact title matches', async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/nodes/auth')) {
        return new Response(JSON.stringify({ jwtToken: 'jwt' }), { status: 200 });
      }
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        results: [networkChunk({ contentEncrypted: 'exact result', available: true })],
        queryId: 'q',
        settledByCentral: true,
      }), { status: 200 });
    }) as never;

    await router(fakeStore([])).query('instagram clone');

    expect(requestBody?.queryText).toBe('instagram clone');
  });

  it('reports matched-but-unretrievable chunks instead of hiding them', async () => {
    globalThis.fetch = mockCentral(200, {
      results: [networkChunk({ available: false, unavailableReason: 'owner_offline' })],
      queryId: 'q',
      message: 'Matched 1 chunk(s), but the node that owns them is offline',
    }) as never;

    const result = await router(fakeStore([])).query('anything');
    expect(result.chunks).toHaveLength(0);
    expect(result.unavailableChunks).toEqual([
      { chunkId: 'c1', title: 'Some Doc — Section', nodeId: 'other', reason: 'owner_offline' },
    ]);
    expect(result.networkMessage).toContain('offline');
  });

  it('surfaces a network failure instead of reporting it as "no match"', async () => {
    // A 402 credit gate used to be swallowed by an empty catch and rendered
    // identically to a genuine miss.
    globalThis.fetch = mockCentral(402, { message: 'Insufficient balance. Top up at retrodeck.ai' }) as never;

    const result = await router(fakeStore([])).query('anything');
    expect(result.source).toBe('llm_fallback');
    expect(result.networkError).toBe('Insufficient balance. Top up at retrodeck.ai');
  });

  it('answers from the summary when the owning node is offline, without tipping', async () => {
    globalThis.fetch = mockCentral(200, {
      results: [networkChunk({
        available: false,
        unavailableReason: 'owner_offline',
        summary: 'The gateway fans out events over a persistent socket.',
        tipAmountUsdc: 0,
      })],
      queryId: 'q',
    }) as never;

    const result = await router(fakeStore([])).query('anything');
    expect(result.source).toBe('network');
    expect(result.lowConfidence).toBe(true);
    expect(result.context).toContain('fans out events');
    expect(result.tipsPaid).toHaveLength(0);
    expect(result.unavailableChunks).toHaveLength(1);
  });

  it('does not answer from a summary that does not clear the confidence bar', async () => {
    globalThis.fetch = mockCentral(200, {
      results: [networkChunk({ available: false, score: 0.2, summary: 'unrelated' })],
      queryId: 'q',
    }) as never;

    const result = await router(fakeStore([])).query('anything');
    expect(result.source).toBe('llm_fallback');
  });

  it('never tips for a chunk the network could not serve', async () => {
    globalThis.fetch = mockCentral(200, {
      results: [
        networkChunk({ chunkId: 'ok', contentEncrypted: 'body', available: true, tipAmountUsdc: 0.01 }),
        networkChunk({ chunkId: 'gone', available: false, tipAmountUsdc: 0.01 }),
      ],
      queryId: 'q', settledByCentral: true,
    }) as never;

    const result = await router(fakeStore([])).query('anything');
    expect(result.tipsPaid.map(t => t.chunkId)).toEqual(['ok']);
  });
});

describe('RDKRouter local fallback', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('answers from the local vault when a match is confident', async () => {
    const result = await router(fakeStore([{ score: 0.8, content: 'my own note' }])).query('q');
    expect(result.source).toBe('private');
    expect(result.lowConfidence).toBeUndefined();
    expect(result.context).toContain('my own note');
  });

  it('returns near-misses as low confidence rather than nothing at all', async () => {
    globalThis.fetch = mockCentral(200, { results: [], queryId: 'q' }) as never;

    const result = await router(fakeStore([{ score: 0.44, content: 'close enough to show' }])).query('q');
    expect(result.source).toBe('private');
    expect(result.lowConfidence).toBe(true);
    expect(result.context).toContain('close enough to show');
  });

  it('still reports nothing when the best local match is noise', async () => {
    globalThis.fetch = mockCentral(200, { results: [], queryId: 'q' }) as never;

    const result = await router(fakeStore([{ score: 0.05 }])).query('q');
    expect(result.source).toBe('llm_fallback');
    expect(result.chunks).toHaveLength(0);
  });
});
