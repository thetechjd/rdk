// packages/rdk-core/src/title.ts
// One place that decides what a document is called.
//
// Every indexing entry point used to invent its own answer, and most of them
// stopped at `path.basename` — so a spec whose first line reads
// "# Discord Clone — Build-Ready Technical Specification" was filed under
// "discord". The H1 was sitting in the content the whole time.
//
// Precedence: frontmatter `title:` (an explicit choice by the author) → the
// first H1 (what the document calls itself) → the caller's fallback (file stem,
// HTML <title>, URL).

/** Extract a frontmatter `title:` from a leading `---` block, if present. */
export function frontmatterTitle(raw: string): string | undefined {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return undefined;
  const line = /^title:\s*(.+)$/m.exec(match[1]);
  if (!line) return undefined;
  return unquote(line[1]) || undefined;
}

/** Extract the first level-1 markdown heading, if the document has one. */
export function firstH1(raw: string): string | undefined {
  // Skip a frontmatter block so a `# comment` inside it can't be mistaken for
  // the heading, and skip fenced code so a shell comment can't either.
  const body = stripFrontmatter(raw);
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const title = collapse(heading[1]);
      if (title) return title;
    }
  }
  return undefined;
}

/**
 * The document's own title, or `fallback` when it doesn't declare one.
 *
 * `raw` should be the ORIGINAL content — run this before `cleanText`, which
 * strips nothing relevant but is not guaranteed to preserve frontmatter.
 */
export function extractDocTitle(raw: string, fallback: string): string {
  return frontmatterTitle(raw) ?? firstH1(raw) ?? fallback;
}

/**
 * A chunk's title: `<document> — <section>`, where the section is the deepest
 * heading the chunk sits under.
 *
 * The section alone is meaningless out of context ("2. Overall Architecture"),
 * and the document alone doesn't locate the chunk — so a chunk is named by both.
 * The H1 is normally `headings[0]` and normally IS the document title, so it is
 * not repeated.
 */
export function buildChunkTitle(docTitle: string, headings: readonly string[]): string {
  const section = headings.filter(Boolean).pop();
  if (!section || normalize(section) === normalize(docTitle)) return docTitle;
  return `${docTitle} — ${section}`;
}

/** Loose comparison for "these two headings name the same thing". */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function unquote(value: string): string {
  const trimmed = collapse(value);
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  return quoted ? quoted[2].trim() : trimmed;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
