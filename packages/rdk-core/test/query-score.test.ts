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

  it('returns no more than five final candidates', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      chunkId: String(i), title: String(i), text: String(i), rrfScore: 1, rerankScore: i / 10,
      riskScore: 0, createdAt: new Date(), retrievalCount: i, tipCount: i,
    }));
    expect(scoreCandidates(rows)).toHaveLength(5);
  });
});
