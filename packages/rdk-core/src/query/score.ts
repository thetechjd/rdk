import {
  AUTHORITY_LOG_BASE,
  FINAL_RESULT_COUNT,
  FRESHNESS_HALF_LIFE_DAYS,
  WEIGHT_AUTHORITY,
  WEIGHT_FRESHNESS,
  WEIGHT_RERANK,
} from './pipeline.constants.js';
import type { RerankedCandidate } from './types.js';

export function finalScore(c: RerankedCandidate): number {
  const authority = c.authorityScore ?? 0;
  const freshness = c.freshnessScore ?? freshnessScore(c.createdAt);
  return WEIGHT_RERANK * c.rerankScore + WEIGHT_AUTHORITY * authority + WEIGHT_FRESHNESS * freshness;
}

/** `limit` honours the caller's topK; FINAL_RESULT_COUNT remains the default. */
export function scoreCandidates(
  candidates: RerankedCandidate[],
  now = new Date(),
  limit = FINAL_RESULT_COUNT,
): RerankedCandidate[] {
  const rawAuthority = candidates.map((c) =>
    Math.log(1 + c.tipCount + c.retrievalCount) / Math.log(AUTHORITY_LOG_BASE));
  const min = Math.min(...rawAuthority, 0);
  const max = Math.max(...rawAuthority, 0);
  return candidates.map((candidate, i) => {
    const authorityScore = max > min ? (rawAuthority[i] - min) / (max - min) : 0;
    const freshness = freshnessScore(candidate.createdAt, now);
    const enriched = { ...candidate, authorityScore, freshnessScore: freshness };
    return { ...enriched, finalScore: finalScore(enriched) };
  }).sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0)).slice(0, limit);
}

function freshnessScore(createdAt: Date, now = new Date()): number {
  const ageDays = Math.max(0, now.getTime() - createdAt.getTime()) / 86_400_000;
  return 0.5 ** (ageDays / FRESHNESS_HALF_LIFE_DAYS);
}
