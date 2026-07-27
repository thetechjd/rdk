// packages/rdk-core/src/summarize.ts
// A summary for every chunk, with or without an LLM.
//
// Summaries are the one piece of a chunk that Central is allowed to hold for
// public content, which makes them the fallback that answers when the owning
// node is offline. Generating them only when an LLM happened to be wired into
// the indexer meant that in practice no chunk had one, and an offline node's
// content degraded to nothing at all rather than to a gist.
//
// This is deliberately extractive (no model, no network, no cost): the leading
// sentences are almost always the topic sentence for a semantically-chunked
// block, and a wrong-but-present gist beats a missing one.

export interface ExtractiveSummaryOptions {
  /** Upper bound on the returned summary. Sentence boundaries are respected
   *  where possible, so the result is usually shorter. */
  maxChars?: number;
  /** Heading trail for the chunk (`chunk.headings`), used as a topic prefix so
   *  the summary reads as being *about* something. */
  headings?: string[];
}

const DEFAULT_MAX_CHARS = 300;

/**
 * A short, deterministic gist of `text`. Returns an empty string for content
 * with nothing worth extracting, so callers can keep `summary` undefined.
 */
export function extractiveSummary(text: string, opts: ExtractiveSummaryOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  // Drop heading lines, list bullets and code fences from consideration — they
  // make poor prose. If that leaves nothing, fall back to the raw text so a
  // list-only chunk still gets a summary.
  const stripped = text
    .split('\n')
    .filter(line => !/^\s*(#{1,6}\s|```)/.test(line))
    .map(line => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''))
    .join(' ');
  const body = collapse(stripped) || collapse(text);
  if (!body) return '';

  const prefix = topicPrefix(opts.headings);
  const budget = Math.max(0, maxChars - prefix.length);
  const gist = firstSentences(body, budget);
  if (!gist) return '';

  return `${prefix}${gist}`;
}

/** The deepest heading available, as a "Topic — " prefix. */
function topicPrefix(headings?: string[]): string {
  const deepest = headings?.filter(Boolean).pop();
  if (!deepest) return '';
  const trimmed = collapse(deepest);
  return trimmed ? `${trimmed} — ` : '';
}

/** Whole sentences up to `budget` chars; a hard-truncated clause if even the
 *  first sentence doesn't fit. */
function firstSentences(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (text.length <= budget) return text;

  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [text];
  // Accumulate raw (each match keeps its trailing space, which is the separator)
  // and trim only once at the end — trimming per iteration welds the sentences
  // together.
  let out = '';
  for (const sentence of sentences) {
    const next = out + sentence;
    if (next.trimEnd().length > budget) break;
    out = next;
  }
  if (out.trim()) return out.trimEnd();

  // First sentence alone overflows — cut at a word boundary and mark it.
  const cut = text.slice(0, budget);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
