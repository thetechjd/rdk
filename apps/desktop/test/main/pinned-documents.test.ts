import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test' },
}));

/**
 * The tree marks a file as pinned by its DOCUMENT hash, because that is what a
 * pin is keyed on. Neither the tree nodes nor the indexed-document list carried
 * one, so the desktop had no way to know what was pinned — every file rendered
 * unpinned however many were paid for.
 *
 * A document indexed before RDK recorded hashes has none, and must come back
 * undefined rather than as some other document's hash: the pin badge and the
 * Pinned folder both key off this, and a wrong hash would mark the wrong file.
 */

function chunk(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    title: 'Spec — 1. Overview',
    docTitle: 'Spec',
    content: 'body',
    sourcePath: '/vault/spec.md',
    documentHash: 'dochash-aaa',
    isPublic: true,
    isEncrypted: false,
    categories: [],
    qualityScore: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

async function serviceWithChunks(chunks: unknown[]) {
  const { NodeService } = await import('../../electron/node-service.js');
  const service = new NodeService() as unknown as {
    getIndexedDocuments(): Array<{ title: string; documentHash?: string; chunkCount: number }>;
    getStore(): unknown;
    getConfig(): unknown;
  };
  service.getStore = () => ({
    getAllChunks: () => chunks,
    getRetrievalCounts: () => ({}),
  });
  service.getConfig = () => ({ nodeId: 'node-me', vaultPath: '/vault' });
  return service;
}

describe('document hashes reach the desktop tree', () => {
  it('carries the document hash onto each indexed document', async () => {
    const service = await serviceWithChunks([
      chunk({ id: 'c1' }),
      chunk({ id: 'c2', title: 'Spec — 2. Detail' }),
    ]);

    const docs = service.getIndexedDocuments();

    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ title: 'Spec', documentHash: 'dochash-aaa', chunkCount: 2 });
  }, 30_000);

  it('leaves the hash undefined for a document indexed before RDK recorded them', async () => {
    const service = await serviceWithChunks([
      chunk({ id: 'old', sourcePath: '/vault/old.md', docTitle: 'Old', documentHash: undefined }),
    ]);

    const [doc] = service.getIndexedDocuments();

    // Undefined, NOT inherited from a sibling document — the Pinned folder and
    // the badge both key off this, so a borrowed hash marks the wrong file.
    expect(doc.documentHash).toBeUndefined();
  }, 30_000);

  it('takes the hash from whichever chunk has one', async () => {
    // Older chunks of a document can predate the hash while newer ones have it.
    const service = await serviceWithChunks([
      chunk({ id: 'c1', documentHash: undefined }),
      chunk({ id: 'c2', documentHash: 'dochash-bbb' }),
    ]);

    const [doc] = service.getIndexedDocuments();

    expect(doc.documentHash).toBe('dochash-bbb');
  }, 30_000);
});
