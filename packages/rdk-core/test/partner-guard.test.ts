import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RDKIndexer } from '../src/indexer.js';
import { isManagedPartnerPath, partnerDocsDir, partnerDocsRoot } from '../src/partners.js';

/**
 * SPEC 02 Phase 5 item 6: a vault re-index never touches managed partner docs,
 * even when the vault is rooted at (or above) RDK_HOME, where the dot-path
 * convention that normally hides ~/.rdk no longer applies.
 */

const body = 'Both teams are on the second night of a back to back with no rest. Pace drops measurably in that spot and the under hit in most recent matchups.';
const saved = vi.hoisted(() => new Map<string, Record<string, unknown>>());
afterEach(() => { saved.clear(); vi.unstubAllGlobals(); });

function indexer() {
  return new RDKIndexer({
    localStore: {
      saveDocument: (doc: { hash: string }) => doc.hash,
      saveChunk: (chunk: { id: string }) => { saved.set(chunk.id, chunk); return chunk.id; },
      getChunk: (id: string) => saved.get(id),
      getEmbedding: () => new Float32Array(384).fill(0.1),
      getDerivedFromForSource: () => undefined,
      getIndexRateState: () => undefined,
      setIndexRateState: () => {},
      markSynced: () => {},
    } as never,
    embeddingModel: { embed: async () => new Float32Array(384).fill(0.1) } as never,
    domain: 'general',
  });
}

describe('managed partner folder', () => {
  it('lives under RDK_HOME/partners and recognises paths inside it only', () => {
    const home = process.env.RDK_HOME ?? '';
    process.env.RDK_HOME = '/tmp/rdk-home-test';
    try {
      expect(partnerDocsRoot()).toBe(path.resolve('/tmp/rdk-home-test/partners'));
      expect(partnerDocsDir('parlayledger')).toBe(path.resolve('/tmp/rdk-home-test/partners/parlayledger'));
      expect(isManagedPartnerPath('/tmp/rdk-home-test/partners/parlayledger/pub_X.md')).toBe(true);
      expect(isManagedPartnerPath('/tmp/rdk-home-test/partners-old/x.md')).toBe(false);
      expect(isManagedPartnerPath('/tmp/rdk-home-test/vault/note.md')).toBe(false);
      expect(isManagedPartnerPath(undefined)).toBe(false);
      expect(() => partnerDocsDir('../etc')).toThrow();
    } finally {
      if (home) process.env.RDK_HOME = home; else delete process.env.RDK_HOME;
    }
  });

  it('a vault adapter re-indexing a managed doc is skipped and stores nothing', async () => {
    const managed = path.join(partnerDocsRoot(), 'parlayledger', 'pub_01J9ZX4K7Q2M9XDABCDEFGHJKM.md');
    for (const sourceAdapter of ['filesystem', 'obsidian', undefined]) {
      const result = await indexer().indexDocument({ title: 'pick', content: body, sourcePath: managed, sourceAdapter });
      expect(result.chunksIndexed).toBe(0);
      expect(result.errors.join(' ')).toContain('managed partner document');
    }
    expect(saved.size).toBe(0);
  });

  it('the partner-job handler (sourceAdapter partner:<id>) indexes it, with external refs on every chunk', async () => {
    const managed = path.join(partnerDocsRoot(), 'parlayledger', 'pub_01J9ZX4K7Q2M9XDABCDEFGHJKM.md');
    const result = await indexer().indexDocument({
      title: 'pick', content: body, sourcePath: managed, sourceAdapter: 'partner:parlayledger', isPublic: true,
      externalPartner: 'parlayledger', externalRef: 'pub_01J9ZX4K7Q2M9XDABCDEFGHJKM',
    });
    expect(result.chunksIndexed).toBeGreaterThan(0);
    expect(result.chunkIds).toEqual([...saved.keys()]);
    for (const chunk of saved.values()) {
      expect(chunk).toMatchObject({ externalPartner: 'parlayledger', externalRef: 'pub_01J9ZX4K7Q2M9XDABCDEFGHJKM', isPublic: true });
    }
  });

  it('ordinary vault files are unaffected', async () => {
    const result = await indexer().indexDocument({ title: 'note', content: body, sourcePath: '/home/u/vault/note.md', sourceAdapter: 'filesystem' });
    expect(result.chunksIndexed).toBeGreaterThan(0);
  });
});
