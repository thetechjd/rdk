import { CANDIDATE_POOL_SIZE, RRF_K, RISK_SCORE_BLOCK_THRESHOLD } from './pipeline.constants.js';
import type { Candidate, UnderstoodQuery } from './types.js';

export type RetrievalHit = Omit<Candidate, 'rrfScore'>;

export interface HybridRetrievalSource {
  lexical(query: string, limit: number): Promise<RetrievalHit[]> | RetrievalHit[];
  vector(query: string, limit: number): Promise<RetrievalHit[]> | RetrievalHit[];
}

/** Distinct chunks dropped for risk during this retrieval, for the query log. */
export interface RetrievalStats {
  blocked: Set<string>;
}

export async function retrieveCandidates(
  q: UnderstoodQuery,
  source: HybridRetrievalSource,
  stats?: RetrievalStats,
): Promise<Candidate[]> {
  const queries = [q.corrected, ...q.variants];
  const lists = await Promise.all(queries.flatMap((query) => [
    Promise.resolve(source.lexical(query, CANDIDATE_POOL_SIZE)),
    Promise.resolve(source.vector(query, CANDIDATE_POOL_SIZE)),
  ]));
  const merged = new Map<string, Candidate>();
  for (const list of lists) {
    list.forEach((hit, index) => {
      if (hit.riskScore >= RISK_SCORE_BLOCK_THRESHOLD) {
        stats?.blocked.add(hit.chunkId);
        return;
      }
      const score = 1 / (RRF_K + index + 1);
      const prior = merged.get(hit.chunkId);
      if (prior) prior.rrfScore += score;
      else merged.set(hit.chunkId, { ...hit, rrfScore: score });
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, CANDIDATE_POOL_SIZE);
}
