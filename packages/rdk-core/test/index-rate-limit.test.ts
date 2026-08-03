import { describe, it, expect } from 'vitest';
import { RDKIndexer } from '../src/indexer.js';
import { INDEX_RATE_LIMIT_BURST } from '../src/query/pipeline.constants.js';
import type { LocalStore, StoredChunk, StoredDocument } from '../src/store/local-store.js';
import type { EmbeddingModel } from '../src/models/embedding.js';

/**
 * The rate limit bounds how OFTEN a node indexes, not how large a document is.
 *
 * Charging a token per chunk turned INDEX_RATE_LIMIT_BURST into a document-size
 * cap: a spec long enough to produce more than 20 chunks failed partway through
 * with "Index rate limit exceeded". Reported on v1.9.0 by a user indexing a
 * single spec on Windows.
 */

/** Long enough to chunk well past the burst size. */
const BIG_SPEC = Array.from({ length: 120 }, (_, i) => `
## Section ${i}

Servers, categories and text channels are addressed by snowflake ids. Permission
resolution for section ${i} computes an effective mask per channel from role
bitfields, applying an allow/deny overwrite layer at read time rather than
materialising it. Message delivery for section ${i} fans out over the gateway.
`).join('\n');

function stubStore() {
  const saved: Array<Omit<StoredChunk, 'createdAt' | 'updatedAt'>> = [];
  const rate = new Map<string, { tokens: number; updatedAt: number }>();
  const store = {
    saved,
    rate,
    saveDocument: (d: Omit<StoredDocument, 'createdAt' | 'updatedAt'>) => d.hash,
    saveChunk: (c: Omit<StoredChunk, 'createdAt' | 'updatedAt'>) => { saved.push(c); return c.id; },
    getDerivedFromForSource: () => undefined,
    getIndexRateState: (nodeId: string) => rate.get(nodeId),
    setIndexRateState: (nodeId: string, state: { tokens: number; updatedAt: number }) =>
      { rate.set(nodeId, state); },
  };
  return store as unknown as LocalStore & {
    saved: typeof saved;
    rate: typeof rate;
  };
}

const embeddingModel = {
  embed: async () => new Float32Array(384).fill(0.1),
} as unknown as EmbeddingModel;

describe('index rate limiting', () => {
  it('indexes a document with far more chunks than the burst size', async () => {
    const store = stubStore();
    const indexer = new RDKIndexer({ embeddingModel, localStore: store, domain: 'general', nodeId: 'n1' });

    const result = await indexer.indexDocument({ content: BIG_SPEC, title: 'discord spec' });

    expect(result.errors).toEqual([]);
    // The document must produce more chunks than the burst, or it cannot regress.
    expect(store.saved.length).toBeGreaterThan(INDEX_RATE_LIMIT_BURST);
    expect(result.chunksIndexed).toBe(store.saved.length);
  });

  it('charges one token per document, not per chunk', async () => {
    const store = stubStore();
    const indexer = new RDKIndexer({ embeddingModel, localStore: store, domain: 'general', nodeId: 'n1' });

    await indexer.indexDocument({ content: BIG_SPEC, title: 'one' });

    // A single document, however long, costs exactly one token.
    expect(store.rate.get('n1')?.tokens).toBeCloseTo(INDEX_RATE_LIMIT_BURST - 1, 5);
  });

  it('still refuses once the bucket is genuinely empty', async () => {
    const store = stubStore();
    store.rate.set('n1', { tokens: 0, updatedAt: Date.now() });
    const indexer = new RDKIndexer({ embeddingModel, localStore: store, domain: 'general', nodeId: 'n1' });

    const result = await indexer.indexDocument({ content: BIG_SPEC, title: 'blocked' });
    expect(result.errors.join(' ')).toMatch(/rate limit/i);
    expect(store.saved).toHaveLength(0);
  });
});
