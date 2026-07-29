import { describe, it, expect } from 'vitest';
import { RDKIndexer } from '../src/indexer.js';
import type { LocalStore, StoredChunk } from '../src/store/local-store.js';
import type { EmbeddingModel } from '../src/models/embedding.js';

/**
 * Lineage has to survive the edit that creates it.
 *
 * Retrieved content is saved with `derivedFrom` pointing at the published chunk
 * it came from. Editing that file re-chunks it and mints NEW content hashes —
 * which is exactly what makes the result the editor's own work, and exactly what
 * would otherwise erase every trace of the original author on the very first
 * edit. The file path is the only identity that survives a re-chunk, so lineage
 * is carried across on it.
 *
 * LocalStore needs better-sqlite3, which doesn't load under vitest (see
 * publish-resync.test.ts for the same constraint), so the indexer is driven
 * against a stub store — the inheritance logic under test is the real one.
 */

const LONG_ENOUGH = `
# Discord clone

A build spec describing servers, channels, roles and message delivery in enough
detail that the cleaner keeps it and the chunker produces a real chunk from it.
Permissions are computed per channel from role bitfields, with an explicit
allow/deny overwrite layer resolved at read time rather than materialised.
`.repeat(3);

function stubStore(derivedBySource: Record<string, string> = {}) {
  const saved: Array<Omit<StoredChunk, 'createdAt' | 'updatedAt'>> = [];
  const store = {
    saved,
    saveChunk(chunk: Omit<StoredChunk, 'createdAt' | 'updatedAt'>) {
      saved.push(chunk);
      return chunk.id;
    },
    getDerivedFromForSource(sourcePath: string) {
      return derivedBySource[sourcePath];
    },
  };
  return store as unknown as LocalStore & { saved: typeof saved };
}

const embeddingModel: EmbeddingModel = {
  embed: async () => new Float32Array(384).fill(0.1),
} as unknown as EmbeddingModel;

const index = async (
  store: LocalStore,
  doc: Partial<Parameters<RDKIndexer['indexDocument']>[0]> = {},
) => {
  const indexer = new RDKIndexer({ embeddingModel, localStore: store, domain: 'general' });
  return indexer.indexDocument({ content: LONG_ENOUGH, title: 'discord', ...doc });
};

describe('carrying lineage through an edit', () => {
  it('records the origin passed on first save', async () => {
    const store = stubStore();
    await index(store, { derivedFrom: 'origin-hash' });
    expect(store.saved.length).toBeGreaterThan(0);
    expect(store.saved.every((c) => c.derivedFrom === 'origin-hash')).toBe(true);
  });

  it('inherits the origin from the FILE when re-indexing an edit', async () => {
    // The edit passes no lineage — the editor is just saving a file. Without
    // this inheritance the original author stops being credited on edit one.
    const store = stubStore({ '/vault/retrieved/discord.md': 'origin-hash' });
    await index(store, { sourcePath: '/vault/retrieved/discord.md' });
    expect(store.saved.every((c) => c.derivedFrom === 'origin-hash')).toBe(true);
  });

  it('leaves original work unattributed', async () => {
    const store = stubStore({ '/vault/retrieved/other.md': 'origin-hash' });
    await index(store, { sourcePath: '/vault/mine.md' });
    expect(store.saved.every((c) => c.derivedFrom === undefined)).toBe(true);
  });

  it('leaves work with no source path unattributed', async () => {
    const store = stubStore({ '/vault/retrieved/discord.md': 'origin-hash' });
    await index(store);
    expect(store.saved.every((c) => c.derivedFrom === undefined)).toBe(true);
  });

  it('prefers an explicitly passed origin over the file\'s', async () => {
    const store = stubStore({ '/vault/retrieved/discord.md': 'stale-hash' });
    await index(store, { sourcePath: '/vault/retrieved/discord.md', derivedFrom: 'explicit-hash' });
    expect(store.saved.every((c) => c.derivedFrom === 'explicit-hash')).toBe(true);
  });
});

/**
 * How a tip divides along a derivation chain, mirroring QueryService's
 * `lineageShares`. The served document keeps DERIVATIVE_SHARE and the remainder
 * flows to what it came from, which keeps the same fraction of what reaches it.
 * A chain of real improvements therefore stands on its own within a few
 * generations rather than paying an original author forever.
 */
const DERIVATIVE_SHARE = 0.7;

function splitAlongChain(amount: number, ancestors: number): number[] {
  const shares: number[] = [];
  let remaining = amount;
  for (let i = 0; i < ancestors; i++) {
    const keep = remaining * DERIVATIVE_SHARE;
    shares.push(keep);
    remaining -= keep;
  }
  shares.push(remaining);
  return shares;
}

describe('splitting a tip along the chain', () => {
  it('pays everything to the author when nothing was derived', () => {
    expect(splitAlongChain(1, 0)).toEqual([1]);
  });

  it('splits 70/30 with the document it was derived from', () => {
    const [author, origin] = splitAlongChain(1, 1);
    expect(author).toBeCloseTo(0.7, 6);
    expect(origin).toBeCloseTo(0.3, 6);
  });

  it('decays with each generation so a chain eventually stands alone', () => {
    const [c, b, a] = splitAlongChain(1, 2);
    expect(c).toBeCloseTo(0.7, 6);
    expect(b).toBeCloseTo(0.21, 6);
    expect(a).toBeCloseTo(0.09, 6);
  });

  it('never pays out more than was collected', () => {
    for (const depth of [0, 1, 2, 3, 4]) {
      const total = splitAlongChain(0.0001, depth).reduce((s, x) => s + x, 0);
      expect(total).toBeCloseTo(0.0001, 12);
    }
  });

  it('always leaves the author the largest single share', () => {
    for (const depth of [1, 2, 3, 4]) {
      const shares = splitAlongChain(1, depth);
      expect(Math.max(...shares)).toBeCloseTo(shares[0], 6);
    }
  });
});
