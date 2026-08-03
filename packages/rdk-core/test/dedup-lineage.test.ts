import { describe, it, expect } from 'vitest';
import { assertNotDuplicate, minHash } from '../src/index/dedup.js';

/**
 * Dedup stops the same CONTENT being indexed twice. It must not stop a node
 * re-indexing its own file.
 *
 * Chunk ids are content-addressed, so editing a document mints new ids. Without
 * lineage the new version is compared against the version it replaces, scores
 * ~1.0, and is rejected — so an edited document can never be re-indexed or
 * synced. Reported as "sync completed with 24 rejected chunks".
 */
const TEXT = 'Servers, categories and text channels are addressed by snowflake ids everywhere.';
const EDITED = 'Servers, categories and text channels are addressed by snowflake ids everywhere today.';

const vec = (fill: number) => new Float32Array(384).fill(fill);

function candidate(over: Partial<{ chunkId: string; documentHash: string; sourcePath: string }> = {}) {
  return {
    chunkId: 'old-chunk',
    signature: minHash(TEXT),
    embedding: vec(0.1),
    ...over,
  };
}

describe('dedup lineage', () => {
  it('rejects a genuine duplicate from unrelated content', () => {
    expect(() => assertNotDuplicate({
      chunkId: 'new', text: TEXT, embedding: vec(0.1),
      documentHash: 'docB', sourcePath: '/vault/b.md',
      existing: [candidate({ documentHash: 'docA', sourcePath: '/vault/a.md' })],
    })).toThrow(/Near-duplicate/);
  });

  it('allows re-indexing the same document after an edit', () => {
    // New chunk id and new document hash — the file was edited — but the same
    // source file, which is what identifies it as this node's own work.
    expect(() => assertNotDuplicate({
      chunkId: 'new', text: EDITED, embedding: vec(0.1),
      documentHash: 'docA-v2', sourcePath: '/vault/a.md',
      existing: [candidate({ documentHash: 'docA-v1', sourcePath: '/vault/a.md' })],
    })).not.toThrow();
  });

  it('allows sibling chunks of the same document', () => {
    expect(() => assertNotDuplicate({
      chunkId: 'sibling', text: TEXT, embedding: vec(0.1),
      documentHash: 'docA', sourcePath: '/vault/a.md',
      existing: [candidate({ documentHash: 'docA', sourcePath: '/vault/a.md' })],
    })).not.toThrow();
  });

  it('still rejects when the incoming chunk has no lineage to compare', () => {
    expect(() => assertNotDuplicate({
      chunkId: 'new', text: TEXT, embedding: vec(0.1),
      existing: [candidate()],
    })).toThrow(/Near-duplicate/);
  });
});
