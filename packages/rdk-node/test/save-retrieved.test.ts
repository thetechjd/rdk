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

describe('what must never be saved', () => {
  it('marks a summary-only document as lacking content', () => {
    // Callers refuse to save these: a summary under the document's name becomes
    // a stub that every later local query matches instead of the real thing.
    const doc = docFrom(
      { ...chunk({ title: 'discord — Servers' }), content: undefined, summary: 'a one-line gist', available: false },
    );
    expect(doc.contentAvailable).toBe(false);
  });

  it('marks a partially-served document as lacking content', () => {
    const doc = docFrom(
      chunk({ title: 'spec — 1. Stack' }),
      { ...chunk({ title: 'spec — 2. Auth' }), chunkId: 'u2', chunkHash: 'h2', content: undefined, summary: 'gist', available: false },
    );
    expect(doc.contentAvailable).toBe(false);
  });
});
