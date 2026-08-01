import { describe, expect, it } from 'vitest';
import { finalScore, scoreCandidates } from '../src/query/score.js';

describe('composite query score', () => {
  it('matches the locked hand-computed weighted sum', () => {
    expect(finalScore({
      chunkId: 'x', title: 'x', text: 'x', rrfScore: 1, rerankScore: 0.5,
      authorityScore: 0.4, freshnessScore: 0.25, riskScore: 0,
      createdAt: new Date(), retrievalCount: 0, tipCount: 0,
    })).toBeCloseTo(0.4375, 8);
  });

  it('lets relevance decide when rerank scores are peaked near zero', () => {
    // What the real vault produced: nothing matches well, so every rerank score
    // is a tiny fraction. Raw, the 0.6 term separates almost nothing and the
    // freshest/most-retrieved chunk wins regardless of relevance.
    const old = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-07-01T00:00:00Z');
    const ranked = scoreCandidates([
      { chunkId: 'relevant', title: 'r', text: 'r', rrfScore: 1, rerankScore: 0.0031,
        riskScore: 0, createdAt: old, retrievalCount: 0, tipCount: 0 },
      { chunkId: 'fresh-junk', title: 'j', text: 'j', rrfScore: 1, rerankScore: 0.0003,
        riskScore: 0, createdAt: now, retrievalCount: 40, tipCount: 40 },
    ], now, 2);

    expect(ranked[0].chunkId).toBe('relevant');
    // Raw scores are preserved for logging; only the normalized value ranks.
    expect(ranked[0].rerankScore).toBe(0.0031);
    expect(ranked[0].rerankNormalized).toBe(1);
    // A 10x-weaker match is scaled against the best, not left indistinguishable.
    expect(ranked[1].rerankNormalized).toBeCloseTo(0.0968, 4);
  });

  it('lets authority break the tie when relevance is identical', () => {
    const now = new Date();
    const ranked = scoreCandidates([
      { chunkId: 'a', title: 'a', text: 'a', rrfScore: 1, rerankScore: 0.5,
        riskScore: 0, createdAt: now, retrievalCount: 0, tipCount: 0 },
      { chunkId: 'b', title: 'b', text: 'b', rrfScore: 1, rerankScore: 0.5,
        riskScore: 0, createdAt: now, retrievalCount: 40, tipCount: 40 },
    ], now, 2);

    // Identical relevance, so authority legitimately breaks the tie.
    expect(ranked.map((c) => c.rerankNormalized)).toEqual([1, 1]);
    expect(ranked[0].chunkId).toBe('b');
  });

  it('returns no more than five final candidates', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      chunkId: String(i), title: String(i), text: String(i), rrfScore: 1, rerankScore: i / 10,
      riskScore: 0, createdAt: new Date(), retrievalCount: i, tipCount: i,
    }));
    expect(scoreCandidates(rows)).toHaveLength(5);
  });
});
