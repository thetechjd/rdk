import { describe, expect, it } from 'vitest';
import { assertNotDuplicate, minHash } from '../src/index/dedup.js';
import { retrieveCandidates, type RetrievalHit } from '../src/query/retrieve.js';
import { rerankCandidates } from '../src/query/rerank.js';
import { scoreCandidates } from '../src/query/score.js';
import { packageResults } from '../src/query/serve.js';
import { understandQuery } from '../src/query/understand.js';
import { ELEVATED_RISK_NOTICE } from '../src/query/pipeline.constants.js';

describe('query pipeline integration', () => {
  it('rejects duplicates, blocks dangerous content, warns on elevated risk, and demotes title bait', async () => {
    const originalText = 'A non custodial EVM wallet architecture with transaction signing and secure key storage.';
    const embedding = new Float32Array([1, 0, 0]);
    const existing = [{ chunkId: 'original', signature: minHash(originalText), embedding }];
    expect(() => assertNotDuplicate({ text: originalText, embedding, existing })).toThrow(/Near-duplicate/);
    expect(() => assertNotDuplicate({ text: `${originalText} Extra.`, embedding, existing })).toThrow(/Near-duplicate/);

    const rows: RetrievalHit[] = Array.from({ length: 30 }, (_, index) => ({
      chunkId: `chunk-${index}`,
      title: index === 0 ? 'MetaMask Clone' : `Wallet document ${index}`,
      text: index === 0
        ? 'An unrelated team chat and messaging specification.'
        : 'Non custodial EVM wallet transaction signing key storage and browser extension architecture.',
      riskScore: index === 1 ? 0.9 : index === 2 ? 0.5 : 0,
      createdAt: new Date('2026-07-01T00:00:00Z'),
      retrievalCount: 0,
      tipCount: 0,
    }));
    const query = understandQuery('metamask clone');
    const candidates = await retrieveCandidates(query, {
      lexical: () => rows,
      vector: () => [...rows].reverse(),
    });
    expect(candidates.some((candidate) => candidate.chunkId === 'chunk-1')).toBe(false);

    const reranked = await rerankCandidates(query, candidates, {
      score: async (pairs) => pairs.map((pair) => pair.text.includes('Non custodial EVM') ? 0.95 : 0.05),
    });
    const final = scoreCandidates(reranked, new Date('2026-07-01T00:00:00Z'));
    expect(final.findIndex((candidate) => candidate.chunkId === 'chunk-0')).not.toBe(0);
    const packaged = packageResults(final);
    expect(packaged).not.toContain('chunk_id=chunk-1');
    expect(packaged).toContain(ELEVATED_RISK_NOTICE);
  });
});
