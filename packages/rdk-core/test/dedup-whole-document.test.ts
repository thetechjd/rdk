import { describe, it, expect } from 'vitest';
import { RDKIndexer } from '../src/indexer.js';
import { findNearDuplicate } from '../src/index/dedup.js';
import type { LocalStore, StoredChunk, StoredDocument } from '../src/store/local-store.js';
import type { EmbeddingModel } from '../src/models/embedding.js';

/**
 * A DOCUMENT is the unit of deduplication, not a chunk.
 *
 * Judging each chunk on its own stored documents with holes punched in them. A
 * 41-chunk build spec was indexed as 39 because its tech-stack and Prisma-schema
 * sections resembled an older copy of the same spec on another node — the two
 * sections were dropped, the document was silently incomplete, and the node
 * re-pushed the missing chunks on every sync forever.
 *
 * So: a document that merely REPEATS some passages is new work and is indexed
 * whole; only a document that duplicates existing content in its entirety is a
 * republish and is rejected.
 */

/** Deterministic bag-of-words vector: identical text embeds identically, and
 *  unrelated text lands in different dimensions. */
function embed(text: string): Float32Array {
  const v = new Float32Array(384);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (let i = 0; i < word.length; i++) h = (Math.imul(31, h) + word.charCodeAt(i)) | 0;
    v[Math.abs(h) % 384] += 1;
  }
  return v;
}

const embeddingModel = { embed: async (t: string) => embed(t) } as unknown as EmbeddingModel;

type Candidate = {
  chunkId: string;
  signature: Uint32Array;
  embedding: Float32Array;
  documentHash?: string;
  sourcePath?: string;
};

function stubStore() {
  const saved: Array<Omit<StoredChunk, 'createdAt' | 'updatedAt'>> = [];
  const embeddings = new Map<string, Float32Array>();
  const signatures = new Map<string, Uint32Array>();
  const candidates: Candidate[] = [];
  const store = {
    saved,
    candidates,
    saveDocument: (d: Omit<StoredDocument, 'createdAt' | 'updatedAt'>) => d.hash,
    saveChunk: (c: Omit<StoredChunk, 'createdAt' | 'updatedAt'>, e: Float32Array) => {
      saved.push(c);
      embeddings.set(c.id, e);
      return c.id;
    },
    setChunkMinHash: (id: string, sig: Uint32Array) => { signatures.set(id, sig); },
    setChunkRisk: () => {},
    getDerivedFromForSource: () => undefined,
    getDedupCandidates: () => candidates,
    /** Promote what has been indexed so far into the dedup candidate set — what
     *  persisting the rows does in a real store — and start a clean slate. */
    seal: () => {
      for (const c of saved) {
        candidates.push({
          chunkId: c.id,
          signature: signatures.get(c.id)!,
          embedding: embeddings.get(c.id)!,
          documentHash: c.documentHash,
          sourcePath: c.sourcePath,
        });
      }
      saved.length = 0;
    },
  };
  return store as unknown as LocalStore & {
    saved: typeof saved;
    candidates: Candidate[];
    seal(): void;
  };
}

const section = (label: string, i: number) => `
## ${label} ${i}

Permission resolution for ${label} ${i} computes an effective mask per channel
from role bitfields, applying an allow/deny overwrite layer at read time rather
than materialising it. Delivery for ${label} ${i} fans out over the gateway, and
every write is ordered by a monotonic sequence the client reconciles against.
`;

const doc = (labels: string[]) =>
  labels.map((label, i) => section(label, i)).join('\n');

/** Every chunk the chunker produced was stored — nothing dropped in the middle. */
function expectWholeDocument(store: { saved: Array<{ chunkCount?: number }> }) {
  expect(store.saved.length).toBeGreaterThan(0);
  expect(store.saved.length).toBe(store.saved[0].chunkCount);
}

describe('deduplication is a decision about documents', () => {
  it('indexes a document in full even where it repeats content already indexed', async () => {
    const store = stubStore();
    const indexer = new RDKIndexer({ embeddingModel, localStore: store, domain: 'general', nodeId: 'n1' });

    const shared = ['Gateway', 'Snowflakes', 'Overwrites'];
    await indexer.indexDocument({
      content: doc(shared),
      title: 'original spec',
      sourcePath: '/other/original.md',
    });
    expectWholeDocument(store);
    const priorText = store.saved[0].content;
    store.seal();

    // The guard really would fire on this material: a shared section matches the
    // already-indexed copy once it arrives under a different document.
    expect(findNearDuplicate({
      chunkId: 'incoming',
      text: priorText,
      embedding: embed(priorText),
      documentHash: 'a-different-document',
      sourcePath: '/vault/revised.md',
      existing: store.candidates,
    })).not.toBeNull();

    // A revision that keeps those sections and adds new ones is new work.
    const revised = doc([...shared, 'Presence', 'Reactions', 'Threads', 'Attachments']);
    const result = await indexer.indexDocument({
      content: revised,
      title: 'revised spec',
      sourcePath: '/vault/revised.md',
    });

    expect(result.errors).toEqual([]);
    expect(result.chunksIndexed).toBe(store.saved.length);
    expectWholeDocument(store);

    // And at least one of the stored chunks really is a near-duplicate — under
    // the per-chunk rule this document would have been stored with a hole in it,
    // which is the whole reason this test exists.
    const colliding = store.saved.filter(c => findNearDuplicate({
      chunkId: c.id,
      text: c.content,
      embedding: embed(c.content),
      documentHash: c.documentHash,
      sourcePath: c.sourcePath,
      existing: store.candidates,
    }));
    expect(colliding.length).toBeGreaterThan(0);
  });

  it('rejects a document whose every chunk duplicates existing content', async () => {
    const store = stubStore();
    const indexer = new RDKIndexer({ embeddingModel, localStore: store, domain: 'general', nodeId: 'n1' });

    const labels = ['Gateway', 'Snowflakes', 'Overwrites'];
    await indexer.indexDocument({
      content: doc(labels),
      title: 'original spec',
      sourcePath: '/other/original.md',
    });
    store.seal();

    // Same body under a new heading: a different document hash and source path,
    // so none of the lineage exclusions apply — this is the republish the guard
    // is actually for.
    const result = await indexer.indexDocument({
      content: `# Copied\n${doc(labels)}`,
      title: 'copied spec',
      sourcePath: '/vault/copied.md',
    });

    expect(result.chunksIndexed).toBe(0);
    expect(store.saved).toHaveLength(0);
    expect(result.errors.join(' ')).toMatch(/document is a near-duplicate/i);
  });
});
