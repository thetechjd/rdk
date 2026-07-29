import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupIntoDocuments, type NetworkChunk } from '@rdk/core';
import { saveRetrievedDocument, RETRIEVED_DIR } from '../src/save-retrieved.js';

let vault: string;

beforeEach(() => { vault = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-vault-')); });
afterEach(() => { fs.rmSync(vault, { recursive: true, force: true }); });

const chunk = (over: Partial<NetworkChunk> & { title: string }): NetworkChunk => ({
  chunkId: 'uuid-1',
  chunkHash: 'hash-1',
  nodeId: 'node-a',
  content: 'the real content',
  score: 0.6,
  tipAmountUsdc: 0,
  categories: [],
  ...over,
});

const docFrom = (...chunks: NetworkChunk[]) => groupIntoDocuments(chunks)[0];

describe('keeping what a query returned', () => {
  it('writes the document into the vault as markdown', () => {
    const { filePath, unchanged } = saveRetrievedDocument(
      docFrom(chunk({ title: 'discord — Servers' })),
      { vaultPath: vault, query: 'discord clone', retrievedAt: 'T0' },
    );

    expect(filePath).toBe(path.join(vault, RETRIEVED_DIR, 'discord.md'));
    expect(unchanged).toBe(false);
    const body = fs.readFileSync(filePath, 'utf-8');
    expect(body).toContain('# discord');
    expect(body).toContain('the real content');
  });

  it('records the content hash, not a database row id', () => {
    // A UUID identifies a row in Central and nothing else. The content hash is
    // the same wherever the content lives, and it is what changes on an edit —
    // so it is the only thing a derivative can honestly point at.
    const { filePath } = saveRetrievedDocument(
      docFrom(chunk({ title: 'discord — Servers' })),
      { vaultPath: vault, query: 'q', retrievedAt: 'T0' },
    );
    const body = fs.readFileSync(filePath, 'utf-8');
    expect(body).toContain('rdk_derived_from: hash-1');
    expect(body).not.toContain('uuid-1');
  });

  it('leaves an unchanged document alone so it does not re-index for nothing', () => {
    const doc = docFrom(chunk({ title: 'discord — Servers' }));
    saveRetrievedDocument(doc, { vaultPath: vault, query: 'q', retrievedAt: 'T0' });
    // A later retrieval carries a new timestamp; only the BODY decides whether
    // anything actually changed.
    const again = saveRetrievedDocument(doc, { vaultPath: vault, query: 'q', retrievedAt: 'T1' });
    expect(again.unchanged).toBe(true);
  });

  it('rewrites in place when the content really changed', () => {
    saveRetrievedDocument(
      docFrom(chunk({ title: 'discord — Servers', content: 'first' })),
      { vaultPath: vault, query: 'q', retrievedAt: 'T0' },
    );
    const second = saveRetrievedDocument(
      docFrom(chunk({ title: 'discord — Servers', content: 'revised' })),
      { vaultPath: vault, query: 'q', retrievedAt: 'T1' },
    );

    expect(second.unchanged).toBe(false);
    // Re-querying must not litter the vault with "discord (2).md".
    expect(fs.readdirSync(path.join(vault, RETRIEVED_DIR))).toEqual(['discord.md']);
    expect(fs.readFileSync(second.filePath, 'utf-8')).toContain('revised');
  });

  it('creates the retrieved folder on first use', () => {
    expect(fs.existsSync(path.join(vault, RETRIEVED_DIR))).toBe(false);
    saveRetrievedDocument(
      docFrom(chunk({ title: 'discord — Servers' })),
      { vaultPath: vault, query: 'q', retrievedAt: 'T0' },
    );
    expect(fs.existsSync(path.join(vault, RETRIEVED_DIR))).toBe(true);
  });

  it('assembles every section of a multi-part document into one file', () => {
    const doc = docFrom(
      { ...chunk({ title: 'spec — 2. Auth' }), chunkId: 'u2', chunkHash: 'h2', content: 'auth section', score: 0.7 },
      { ...chunk({ title: 'spec — 1. Stack' }), chunkId: 'u1', chunkHash: 'h1', content: 'stack section', score: 0.5 },
    );
    const { filePath } = saveRetrievedDocument(doc, { vaultPath: vault, query: 'q', retrievedAt: 'T0' });
    const body = fs.readFileSync(filePath, 'utf-8');

    expect(body).toContain('stack section');
    expect(body).toContain('auth section');
    // The document's own order, not the search ranking's.
    expect(body.indexOf('stack section')).toBeLessThan(body.indexOf('auth section'));
  });
});

/**
 * When the owning node isn't serving, Central returns summaries. That is the
 * COMMON case, and refusing to write anything for it left the user clicking a
 * result that produced nothing at all — no file, no tab, not even a toast.
 *
 * So a summary is written, under its own name, and simply never indexed.
 * Indexing is the part that does damage: a summary in the local index answers
 * future queries in place of the real document and permanently shadows it.
 */
const summaryDoc = () => docFrom(
  { ...chunk({ title: 'discord — Servers' }), content: undefined, summary: 'a one-line gist', available: false },
);

describe('when only summaries came back', () => {
  it('marks the document as lacking content', () => {
    expect(summaryDoc().contentAvailable).toBe(false);
  });

  it('marks a PARTIALLY served document as lacking content too', () => {
    const doc = docFrom(
      chunk({ title: 'spec — 1. Stack' }),
      { ...chunk({ title: 'spec — 2. Auth' }), chunkId: 'u2', chunkHash: 'h2', content: undefined, summary: 'gist', available: false },
    );
    expect(doc.contentAvailable).toBe(false);
  });

  it('still writes a file, so clicking the result always opens something', () => {
    const saved = saveRetrievedDocument(summaryDoc(), { vaultPath: vault, query: 'q', retrievedAt: 'T0' });
    expect(fs.existsSync(saved.filePath)).toBe(true);
  });

  it('tells the caller not to index it', () => {
    const saved = saveRetrievedDocument(summaryDoc(), { vaultPath: vault, query: 'q', retrievedAt: 'T0' });
    expect(saved.summaryOnly).toBe(true);
  });

  it('says so in the file, not only in the UI that opened it', () => {
    // Someone reading this a week later has no query results on screen.
    const { filePath } = saveRetrievedDocument(summaryDoc(), { vaultPath: vault, query: 'q', retrievedAt: 'T0' });
    const body = fs.readFileSync(filePath, 'utf-8');
    expect(body).toContain('rdk_summary_only: true');
    expect(body).toContain('Summary only.');
  });

  it('never overwrites the real document', () => {
    // A user who has both should be able to see that they have both.
    saveRetrievedDocument(docFrom(chunk({ title: 'discord — Servers' })), { vaultPath: vault, query: 'q', retrievedAt: 'T0' });
    saveRetrievedDocument(summaryDoc(), { vaultPath: vault, query: 'q', retrievedAt: 'T0' });

    expect(fs.readdirSync(path.join(vault, RETRIEVED_DIR)).sort())
      .toEqual(['discord (summary).md', 'discord.md']);
    expect(fs.readFileSync(path.join(vault, RETRIEVED_DIR, 'discord.md'), 'utf-8'))
      .toContain('the real content');
  });
});
