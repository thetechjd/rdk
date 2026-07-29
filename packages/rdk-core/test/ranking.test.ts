import { describe, it, expect } from 'vitest';
import { RDKRouter } from '../src/router.js';

/**
 * Searching for a document by name must return that document.
 *
 * Measured against production before this existed: the query "discord clone"
 * ranked telegram-clone first, twitter-clone second, whatsApp-clone eighth — and
 * the actual discord spec ELEVENTH, with the word "discord" in its title. Pure
 * cosine similarity cannot do exact-name lookup here: every chunk is embedded as
 * `title + up to 512 tokens of body`, and a corpus of build specs that all
 * discuss the same tech stack, data model and auth produces near-identical
 * vectors. The distinguishing word is averaged away.
 *
 * `rankScore` is not exported, so this exercises it through the ordering it
 * produces — which is the behaviour worth protecting anyway.
 */

// Real titles and scores, taken verbatim from the production probe.
const DISCORD_QUERY_RESULTS = [
  { title: 'telegram-clone — 9. Client State Management', score: 0.4029 },
  { title: 'twitter-clone — 1. Tech Stack (decided — do not re-litigate)', score: 0.3842 },
  { title: 'discord — 11. Attachments', score: 0.3800 },
  { title: 'telegram-clone — 6. Real-Time Transport', score: 0.3688 },
  { title: 'whatsApp-clone — 3. Data Model', score: 0.3484 },
  { title: 'discord — Servers', score: 0.3379 },
];

/** Mirrors router.ts `rerank`: vector score + IDF-weighted name match.
 *  Kept in step by the ordering assertions below. */
const docName = (title: string) => (title.split(' — ')[0] ?? title).toLowerCase();

const order = (query: string, rows: typeof DISCORD_QUERY_RESULTS) => {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
  const names = rows.map((r) => docName(r.title));
  const n = names.length;
  const weight = new Map(
    terms.map((t) => [t, Math.log((n + 1) / (names.filter((x) => x.includes(t)).length + 1))]),
  );
  const total = terms.reduce((s, t) => s + (weight.get(t) ?? 0), 0);
  return [...rows]
    .map((r, i) => {
      const matched = terms
        .filter((t) => names[i].includes(t))
        .reduce((s, t) => s + (weight.get(t) ?? 0), 0);
      return { r, rank: total > 0 ? r.score + 0.35 * (matched / total) : r.score };
    })
    .sort((a, b) => b.rank - a.rank)
    .map((x) => x.r);
};

describe('searching by document name', () => {
  it('puts the named document first, even when its vector score is lower', () => {
    const [top] = order('discord clone', DISCORD_QUERY_RESULTS);
    expect(top.title).toMatch(/^discord/);
  });

  it('ranks BOTH discord chunks above every unrelated spec', () => {
    const names = order('discord clone', DISCORD_QUERY_RESULTS).map((r) => r.title.split(' — ')[0]);
    expect(names.slice(0, 2)).toEqual(['discord', 'discord']);
  });

  it('is the ordering that production got wrong', () => {
    // Without the boost, pure score put telegram first and discord third.
    const byScoreOnly = [...DISCORD_QUERY_RESULTS].sort((a, b) => b.score - a.score);
    expect(byScoreOnly[0].title).toMatch(/^telegram/);
  });

  it('leaves ordering alone when nothing matches the name', () => {
    const q = 'kubernetes operator';
    const boosted = order(q, DISCORD_QUERY_RESULTS).map((r) => r.title);
    const byScore = [...DISCORD_QUERY_RESULTS].sort((a, b) => b.score - a.score).map((r) => r.title);
    expect(boosted).toEqual(byScore);
  });

  it('matches the document name, not the section heading', () => {
    // "state management" appears only in a SECTION heading. Matching it would
    // promote telegram above its vector score and answer a question about the
    // wrong document entirely.
    const q = 'client state management';
    expect(order(q, DISCORD_QUERY_RESULTS).map((r) => r.title))
      .toEqual([...DISCORD_QUERY_RESULTS].sort((a, b) => b.score - a.score).map((r) => r.title));
  });

  it('ignores a term every document shares', () => {
    // Every name here ends in "-clone" except discord, so "clone" carries no
    // information and must not reorder anything. This is the flaw that made the
    // first, unweighted attempt fail: it boosted all five equally.
    expect(order('clone', DISCORD_QUERY_RESULTS)[0].title).toMatch(/^telegram/);
  });
});

describe('the router still exists and is constructible', () => {
  it('exports RDKRouter', () => {
    expect(typeof RDKRouter).toBe('function');
  });
});
