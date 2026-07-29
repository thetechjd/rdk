// packages/rdk-core/src/retrieved.ts
//
// What a successful query produces.
//
// A query returns CHUNKS, but nobody asked a question about a chunk. Retrieval
// used to hand back five fragments of one document as five separate results and
// ask the user to pick one — an impossible choice, since a fragment shows too
// little to judge and picking wrongly discards the rest of the answer.
//
// So results are assembled back into the DOCUMENTS they came from. One document
// matched → that is the answer. Several matched → those are the choices, and
// each choice is a whole document rather than a slice of one.

import type { NetworkChunk } from './router.js';

/** One source document, reassembled from the chunks a query matched. */
export interface RetrievedDocument {
  /** Document name — what the sections were grouped by, and the file's name. */
  name: string;
  /** The node that published it. Attribution follows this, not the retriever. */
  originNodeId: string;
  /** Best score across its sections — how the documents rank against each other. */
  score: number;
  /** True when this is the caller's own content (never charged, never tipped). */
  isOwn: boolean;
  /** Total tip across the sections actually retrieved. */
  tipUsdc: number;
  domain?: string;
  /**
   * False when this was assembled from SUMMARIES because the owning node could
   * not serve the real content.
   *
   * The distinction has to survive, because a summary wearing the document's
   * name is worse than no answer: saved to a vault it becomes a stub that future
   * local queries match instead of the real thing, permanently shadowing the
   * document it claims to be.
   */
  contentAvailable: boolean;
  sections: RetrievedSection[];
}

export interface RetrievedSection {
  chunkId: string;
  /** Content hash — what a derivative points at to record what seeded it.
   *  Falls back to `chunkId` on centrals that don't send it. */
  chunkHash: string;
  /** Section heading with the document prefix stripped. */
  heading: string;
  content: string;
  score: number;
}

/** Everything before the section separator — the document, not the section. */
function documentName(chunk: { docTitle?: string; title: string }): string {
  return (chunk.docTitle ?? chunk.title.split(' — ')[0] ?? chunk.title).trim();
}

function sectionHeading(name: string, title: string): string {
  const rest = title.slice(title.indexOf(' — ') + 3);
  return title.startsWith(`${name} — `) && rest ? rest.trim() : title.trim();
}

/**
 * Documents read in their own order, not in relevance order.
 *
 * Most specs number their sections ("1. Tech Stack", "11. Attachments",
 * "Phase 6: Client Apps"), so when a leading number is present it is the
 * document's own ordering and beats the search ranking — assembling
 * "11. Attachments" above "1. Tech Stack" produces a file that reads backwards.
 * With no number to go on, relevance order is the best available guess.
 */
function sectionOrder(heading: string): number | null {
  const m = /^(?:phase|part|step|section|chapter)?\s*(\d+)\b/i.exec(heading.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Group matched chunks into the documents they belong to, best document first.
 *
 * Near-duplicate sections are collapsed: re-indexing the same file produces
 * chunks with different ids but identical text, and showing the reader the same
 * paragraph twice in one document is never right.
 */
export function groupIntoDocuments(chunks: NetworkChunk[]): RetrievedDocument[] {
  const byName = new Map<string, RetrievedDocument>();

  for (const chunk of chunks) {
    const content = (chunk.content ?? chunk.summary ?? '').trim();
    if (!content) continue;

    const name = documentName(chunk);
    let doc = byName.get(name);
    if (!doc) {
      doc = {
        name,
        originNodeId: chunk.nodeId,
        score: chunk.score,
        isOwn: chunk.isOwn === true,
        tipUsdc: 0,
        domain: chunk.domain,
        contentAvailable: chunk.available !== false,
        sections: [],
      };
      byName.set(name, doc);
    }

    const heading = sectionHeading(name, chunk.title);
    const fingerprint = content.slice(0, 200);
    if (doc.sections.some(s => s.heading === heading && s.content.slice(0, 200) === fingerprint)) {
      continue;
    }

    doc.sections.push({
      chunkId: chunk.chunkId,
      chunkHash: chunk.chunkHash ?? chunk.chunkId,
      heading,
      content,
      score: chunk.score,
    });
    doc.score = Math.max(doc.score, chunk.score);
    // One unserved section makes the whole document partial — it is not the
    // document the user asked for.
    if (chunk.available === false) doc.contentAvailable = false;
    doc.tipUsdc += chunk.tipAmountUsdc ?? 0;
  }

  for (const doc of byName.values()) {
    doc.sections.sort((a, b) => {
      const [x, y] = [sectionOrder(a.heading), sectionOrder(b.heading)];
      if (x !== null && y !== null && x !== y) return x - y;
      if (x !== null && y === null) return -1;
      if (x === null && y !== null) return 1;
      return b.score - a.score;
    });
  }

  return [...byName.values()].sort((a, b) => b.score - a.score);
}

export interface RenderOptions {
  /** The question that retrieved it — recorded so the file explains itself. */
  query: string;
  /** ISO timestamp. Passed in rather than read, so rendering stays pure. */
  retrievedAt: string;
}

/**
 * A retrieved document as a markdown file, with its provenance in frontmatter.
 *
 * `rdk_derived_from` is the part that matters beyond bookkeeping. A verbatim
 * copy cannot be republished — chunk ids are content hashes and Central holds
 * each hash once, so copying earns nothing and is not meant to. But EDIT this
 * file and the content hash changes, which makes it genuinely new work owned by
 * whoever wrote it. This field is what lets the original author still be
 * credited for having seeded it.
 */
export function renderDocument(doc: RetrievedDocument, opts: RenderOptions): string {
  const yaml = [
    '---',
    `title: ${JSON.stringify(doc.name)}`,
    `rdk_retrieved_from: ${doc.originNodeId}`,
    `rdk_retrieved_query: ${JSON.stringify(opts.query)}`,
    `rdk_retrieved_at: ${opts.retrievedAt}`,
    `rdk_derived_from: ${doc.sections[0]?.chunkHash ?? ''}`,
    'rdk_source_chunks:',
    ...doc.sections.map(s => `  - ${s.chunkHash}`),
    '---',
    '',
  ];

  const body: string[] = [`# ${doc.name}`, ''];
  for (const s of doc.sections) {
    // A section whose text already opens with its own heading must not get a
    // second one stacked above it.
    const startsWithHeading = new RegExp(`^#{1,6}\\s*${escapeRegExp(s.heading)}\\s*$`, 'im')
      .test(s.content.split('\n', 1)[0] ?? '');
    if (!startsWithHeading && s.heading && s.heading !== doc.name) body.push(`## ${s.heading}`, '');
    body.push(s.content.trim(), '');
  }

  return `${yaml.join('\n')}${body.join('\n').trimEnd()}\n`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Filesystem-safe file name for a retrieved document. */
export function documentFileName(name: string): string {
  const base = name.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || 'retrieved';
  return `${base}.md`;
}
