import { describe, it, expect } from 'vitest';
import { groupIntoDocuments, renderDocument, documentFileName } from '../src/retrieved.js';
import type { NetworkChunk } from '../src/router.js';

/**
 * A query returns chunks; a question is about a DOCUMENT. Retrieval used to show
 * five fragments of one spec as five results and ask the user to choose — a
 * choice nobody can make, because a fragment shows too little to judge and
 * picking one throws the rest of the answer away.
 */

const chunk = (over: Partial<NetworkChunk> & { title: string; score: number }): NetworkChunk => ({
  chunkId: over.title.replace(/\W+/g, '').slice(0, 16),
  nodeId: 'node-a',
  summary: '',
  content: `body of ${over.title}`,
  tipAmountUsdc: 0.0001,
  categories: [],
  ...over,
});

describe('assembling documents from chunks', () => {
  it('collapses sections of one document into a single result', () => {
    const docs = groupIntoDocuments([
      chunk({ title: 'instagram-clone — Phase 6: Client Apps', score: 0.42 }),
      chunk({ title: 'instagram-clone — Phase 1: Foundation', score: 0.38 }),
      chunk({ title: 'instagram-clone — stories', score: 0.32 }),
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe('instagram-clone');
    expect(docs[0].sections).toHaveLength(3);
  });

  it('ranks documents by their best section, not their section count', () => {
    const docs = groupIntoDocuments([
      chunk({ title: 'telegram-clone — 1. Stack', score: 0.30 }),
      chunk({ title: 'telegram-clone — 2. Auth', score: 0.29 }),
      chunk({ title: 'telegram-clone — 3. Data', score: 0.28 }),
      chunk({ title: 'discord — Servers', score: 0.55 }),
    ]);
    expect(docs.map((d) => d.name)).toEqual(['discord', 'telegram-clone']);
  });

  it("reads in the document's own order, not in relevance order", () => {
    // Assembling by relevance produces a file that runs backwards: the most
    // relevant section is rarely the first one.
    const docs = groupIntoDocuments([
      chunk({ title: 'spec — 11. Attachments', score: 0.61 }),
      chunk({ title: 'spec — 1. Tech Stack', score: 0.40 }),
      chunk({ title: 'spec — 6. Transport', score: 0.55 }),
    ]);
    expect(docs[0].sections.map((s) => s.heading)).toEqual([
      '1. Tech Stack', '6. Transport', '11. Attachments',
    ]);
  });

  it('falls back to relevance order when sections are not numbered', () => {
    const docs = groupIntoDocuments([
      chunk({ title: 'notes — Deployment', score: 0.30 }),
      chunk({ title: 'notes — Overview', score: 0.60 }),
    ]);
    expect(docs[0].sections.map((s) => s.heading)).toEqual(['Overview', 'Deployment']);
  });

  it('drops a duplicate section rather than printing it twice', () => {
    // Re-indexing the same file mints new chunk ids for identical text; the
    // reader must not see the same paragraph twice in one document.
    const docs = groupIntoDocuments([
      { ...chunk({ title: 'twitter-clone — 1. Tech Stack', score: 0.44 }), chunkId: 'a' },
      { ...chunk({ title: 'twitter-clone — 1. Tech Stack', score: 0.43 }), chunkId: 'b' },
    ]);
    expect(docs[0].sections).toHaveLength(1);
  });

  it('skips chunks whose content never arrived', () => {
    const docs = groupIntoDocuments([
      { ...chunk({ title: 'ghost — Section', score: 0.9 }), content: '', summary: '' },
      chunk({ title: 'real — Section', score: 0.3 }),
    ]);
    expect(docs.map((d) => d.name)).toEqual(['real']);
  });

  it('prefers docTitle over splitting the composite title', () => {
    const docs = groupIntoDocuments([
      chunk({ title: 'Guide — A — B', docTitle: 'Guide — A', score: 0.5 }),
    ]);
    expect(docs[0].name).toBe('Guide — A');
  });

  it('sums the tip across the sections actually retrieved', () => {
    const docs = groupIntoDocuments([
      chunk({ title: 'spec — 1. One', score: 0.5 }),
      chunk({ title: 'spec — 2. Two', score: 0.4 }),
    ]);
    expect(docs[0].tipUsdc).toBeCloseTo(0.0002, 6);
  });
});

describe('rendering a retrieved document', () => {
  const doc = groupIntoDocuments([
    chunk({ title: 'discord — 1. Servers', score: 0.6 }),
    chunk({ title: 'discord — 2. Channels', score: 0.5 }),
  ])[0];

  const md = renderDocument(doc, { query: 'discord clone', retrievedAt: '2026-07-29T00:00:00.000Z' });

  it('records where it came from, so the file explains itself', () => {
    expect(md).toContain('rdk_retrieved_from: node-a');
    expect(md).toContain('rdk_retrieved_query: "discord clone"');
    expect(md).toContain('rdk_retrieved_at: 2026-07-29T00:00:00.000Z');
  });

  it('records the lineage that lets an edit still credit the original', () => {
    // Editing this file changes its content hash and makes it genuinely new
    // work. This is the only thing that remembers what seeded it.
    expect(md).toMatch(/rdk_derived_from: \w+/);
  });

  it('is a readable markdown document, not a dump of fragments', () => {
    expect(md).toContain('# discord');
    expect(md).toContain('## 1. Servers');
    expect(md).toContain('## 2. Channels');
    expect(md.indexOf('## 1. Servers')).toBeLessThan(md.indexOf('## 2. Channels'));
  });

  it('does not stack a heading on a section that already has one', () => {
    const withHeading = groupIntoDocuments([
      { ...chunk({ title: 'spec — Overview', score: 0.5 }), content: '## Overview\n\nthe body' },
    ])[0];
    const out = renderDocument(withHeading, { query: 'q', retrievedAt: 'now' });
    expect(out.match(/## Overview/g)).toHaveLength(1);
  });

  it('preserves an authoritative full document without adding duplicate headings', () => {
    const source = '# WeChat Clone: Build Specification\n\n## 1. Overview\n\nThe complete source.';
    const complete = groupIntoDocuments([
      {
        ...chunk({ title: 'WeChat Clone: Build Specification', score: 0.8 }),
        docTitle: 'WeChat Clone: Build Specification',
        documentHash: 'sha256:complete',
        content: source,
      },
    ])[0];

    const out = renderDocument(complete, { query: 'wechat clone', retrievedAt: 'now' });
    expect(complete.completeDocument).toBe(true);
    expect(out.match(/# WeChat Clone: Build Specification/g)).toHaveLength(1);
    expect(out).toContain(source);
  });
});

describe('naming the file', () => {
  it('strips characters a filesystem will reject', () => {
    expect(documentFileName('a/b:c*d?"e<f>g|h')).toBe('a-b-c-d--e-f-g-h.md');
  });

  it('never produces a nameless file', () => {
    expect(documentFileName('   ')).toBe('retrieved.md');
  });
});
