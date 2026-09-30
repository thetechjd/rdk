import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RDKNode } from '../src/node.js';

/**
 * MCP-indexed content must carry its provenance.
 *
 * `sourcePath` is a document's identity across re-indexes: it keys the version
 * series, lets the desktop associate the document with a file, and is the
 * lineage central uses to tell "this node updated its own document" from
 * "someone republished existing content". `handleIndexUrl` used to fetch a URL
 * and then drop it on the way to `handleIndex`, so every page indexed through
 * Claude Desktop arrived anonymous — and re-indexing one was rejected as a
 * near-duplicate of the copy it was meant to replace, permanently.
 */

interface Captured { sourcePath?: string; sourceAdapter?: string; title?: string; isPublic?: boolean }

function nodeWithFakeIndexer(): { node: RDKNode; docs: Captured[] } {
  const docs: Captured[] = [];
  // The class builds its store/router/indexer in init(), which needs a real
  // vault and model. Only the indexer call is under test here.
  const node = Object.create(RDKNode.prototype) as RDKNode;
  const internals = node as unknown as {
    config: { domain: string };
    indexer: { indexDocument(doc: Captured): Promise<unknown> };
  };
  internals.config = { domain: 'general' };
  internals.indexer = {
    indexDocument: async (doc: Captured) => {
      docs.push(doc);
      return { chunksIndexed: 3, chunksSkipped: 0, filesProcessed: 1, categories: [], errors: [] };
    },
  };
  return { node, docs };
}

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response(
    '<html><head><title>Chess - Wikipedia</title></head><body><p>Chess is a board game.</p></body></html>',
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )) as unknown as typeof fetch;
});

afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

describe('MCP indexing records where content came from', () => {
  it('keeps the URL as the source path when indexing a page', async () => {
    const { node, docs } = nodeWithFakeIndexer();

    await node.handleIndexUrl({ url: 'https://en.wikipedia.org/wiki/Chess' });

    expect(docs).toHaveLength(1);
    expect(docs[0].sourcePath).toBe('https://en.wikipedia.org/wiki/Chess');
    expect(docs[0].title).toBe('Chess - Wikipedia');
  });

  it('re-indexing the same URL reports the same source path', async () => {
    const { node, docs } = nodeWithFakeIndexer();

    await node.handleIndexUrl({ url: 'https://en.wikipedia.org/wiki/Chess' });
    await node.handleIndexUrl({ url: 'https://en.wikipedia.org/wiki/Chess' });

    // Stable across re-indexes is the whole point — a value that changed per
    // call would satisfy "not undefined" while still breaking lineage.
    expect(docs.map(d => d.sourcePath)).toEqual([
      'https://en.wikipedia.org/wiki/Chess',
      'https://en.wikipedia.org/wiki/Chess',
    ]);
  });

  it('passes through a source path supplied by the caller', async () => {
    const { node, docs } = nodeWithFakeIndexer();

    await node.handleIndex({
      content: 'Board model, move validator, game controller.',
      title: 'Chess game structural design',
      sourcePath: 'notes/chess-design.md',
    });

    expect(docs[0].sourcePath).toBe('notes/chess-design.md');
    expect(docs[0].sourceAdapter).toBe('manual');
  });

  it('still indexes content with no source path', async () => {
    const { node, docs } = nodeWithFakeIndexer();

    // Provenance is optional: a scratch note typed at the agent has no origin,
    // and must not become an error.
    await node.handleIndex({ content: 'A passing thought.', title: 'Scratch' });

    expect(docs).toHaveLength(1);
    expect(docs[0].sourcePath).toBeUndefined();
  });
});
