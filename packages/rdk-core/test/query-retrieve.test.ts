import { describe, expect, it } from 'vitest';
import { retrieveCandidates, type RetrievalHit } from '../src/query/retrieve.js';

const hit = (chunkId: string): RetrievalHit => ({
  chunkId, title: chunkId, text: chunkId, riskScore: 0, createdAt: new Date(), retrievalCount: 0, tipCount: 0,
});

describe('RRF hybrid retrieval', () => {
  it('rewards candidates present in both fixed ranked lists', async () => {
    const result = await retrieveCandidates(
      { original: 'q', normalized: 'q', corrected: 'q', variants: [] },
      { lexical: () => [hit('lexical'), hit('both')], vector: () => [hit('both'), hit('vector')] },
    );
    expect(result.map((candidate) => candidate.chunkId)).toEqual(['both', 'lexical', 'vector']);
  });

  it('removes blocked candidates before they consume a slot', async () => {
    const blocked = { ...hit('blocked'), riskScore: 0.9 };
    const result = await retrieveCandidates(
      { original: 'q', normalized: 'q', corrected: 'q', variants: [] },
      { lexical: () => [blocked], vector: () => [] },
    );
    expect(result).toEqual([]);
  });
});
