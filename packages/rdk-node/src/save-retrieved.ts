// packages/rdk-node/src/save-retrieved.ts
//
// Keeping what a query returned.
//
// Retrieved content used to be printed once and thrown away — paid for, read,
// and gone. Now a successful query leaves a real markdown file in the vault, so
// the answer is somewhere you can open, search and edit rather than something
// you have to re-query (and re-pay) to see again.
//
// It is saved LOCAL-ONLY and never republished. Chunk ids are content hashes and
// Central holds each hash exactly once, so a verbatim copy could not be
// published even if we tried — which is the right incentive: copying is not a
// contribution. Editing the file changes its hash and makes it genuinely new
// work, owned by whoever wrote it, with `derivedFrom` remembering what it grew
// out of so the original author keeps a share.

import fs from 'node:fs';
import path from 'node:path';
import {
  documentFileName,
  renderDocument,
  type RetrievedDocument,
} from '@rdk/core';

/** Where retrieved documents land, relative to the vault root. */
export const RETRIEVED_DIR = 'retrieved';

export interface SaveRetrievedOptions {
  vaultPath: string;
  query: string;
  /** Passed in rather than read from the clock, so callers can pin it in tests. */
  retrievedAt?: string;
}

export interface SavedDocument {
  /** Absolute path of the markdown file written. */
  filePath: string;
  /** True when an identical file was already there and nothing was rewritten. */
  unchanged: boolean;
  /**
   * The caller must NOT index this — it holds summaries, not the document.
   *
   * Indexing is the part that does damage: a summary in the local index matches
   * future queries in place of the real document and permanently shadows it.
   * Writing the file does no such harm, and refusing to write it left the user
   * clicking a result that did nothing at all.
   */
  summaryOnly: boolean;
}

/**
 * Write a retrieved document into the vault as markdown.
 *
 * Re-querying the same thing must not litter the vault with `foo (2).md`, so a
 * document overwrites its own earlier copy — and if the bytes are identical, it
 * is left alone entirely, which keeps file watchers and re-indexing quiet.
 */
export function saveRetrievedDocument(
  doc: RetrievedDocument,
  opts: SaveRetrievedOptions,
): SavedDocument {
  const dir = path.join(opts.vaultPath, RETRIEVED_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, documentFileName(doc.name, !doc.contentAvailable));
  const body = renderDocument(doc, {
    query: opts.query,
    retrievedAt: opts.retrievedAt ?? new Date().toISOString(),
  });

  // Compare everything after the frontmatter: the timestamp changes on every
  // retrieval, and rewriting a file whose content is unchanged would re-index
  // the whole document for nothing.
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
  if (existing !== null && stripFrontmatter(existing) === stripFrontmatter(body)) {
    return { filePath, unchanged: true, summaryOnly: !doc.contentAvailable };
  }

  fs.writeFileSync(filePath, body, 'utf-8');
  return { filePath, unchanged: false, summaryOnly: !doc.contentAvailable };
}

function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  return end === -1 ? md : md.slice(end + 4).trimStart();
}
