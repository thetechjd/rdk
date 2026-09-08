import { afterEach, describe, expect, it, vi } from 'vitest';
import { RDKIndexer } from '../src/indexer.js';

const body = 'Godot is a game engine with a scene tree and reusable nodes. Developers compose scenes and attach scripts to build interactive games. Rendering supports both two dimensional sprites and three dimensional worlds.';
afterEach(() => vi.unstubAllGlobals());

async function indexWithAck(ack: (ids: string[]) => unknown) {
  const saved = new Map<string, any>();
  const markSynced = vi.fn();
  const fetch = vi.fn(async (url: string, opts: any) => {
    if (url.endsWith('/auth')) return new Response(JSON.stringify({ jwtToken: 'test-token' }));
    const ids = JSON.parse(opts.body).chunks.map((c: any) => c.chunkHash);
    return new Response(JSON.stringify(ack(ids)));
  });
  vi.stubGlobal('fetch', fetch);
  const indexer = new RDKIndexer({
    localStore: {
      saveDocument: (doc: any) => doc.hash,
      saveChunk: (chunk: any) => { saved.set(chunk.id, chunk); return chunk.id; },
      getChunk: (id: string) => saved.get(id),
      getEmbedding: () => new Float32Array(384).fill(0.1),
      getDerivedFromForSource: () => undefined,
      getIndexRateState: () => undefined,
      setIndexRateState: () => {},
      markSynced,
    } as any,
    embeddingModel: { embed: async () => new Float32Array(384).fill(0.1) } as any,
    syncToNetwork: true, centralApiUrl: 'https://central.test', centralApiKey: 'test-key',
  });
  const result = await indexer.indexDocument({ title: 'Godot', content: body, isPublic: true });
  expect(result.chunksIndexed).toBeGreaterThan(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  return { result, markSynced, saved };
}

describe('index publication acknowledgments', () => {
  it.each([{ synced: 0 }, {}, { synced: 0, acceptedHashes: [], errors: ['Plan limit reached'] }])(
    'reports rejected or ambiguous HTTP 200 responses and keeps chunks pending: %j', async ack => {
      const { result, markSynced } = await indexWithAck(() => ack);
      expect(result.errors.join(' ')).toContain('pending sync');
      expect(markSynced).not.toHaveBeenCalled();
    },
  );
  it('marks explicitly accepted hashes synced', async () => {
    const { result, markSynced, saved } = await indexWithAck(ids => ({ acceptedHashes: ids, synced: ids.length }));
    expect(result.errors).toEqual([]);
    expect(markSynced).toHaveBeenCalledTimes(saved.size);
  });
  it('supports legacy acknowledgments when all submitted chunks are accepted', async () => {
    const { result, markSynced, saved } = await indexWithAck(ids => ({ synced: ids.length }));
    expect(result.errors).toEqual([]);
    expect(markSynced).toHaveBeenCalledTimes(saved.size);
  });
});
