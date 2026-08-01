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
  // Cross-encoder output is extremely peaked — ~0.98 for a true match and
  // ~0.0003 for everything else. Left raw, a pool with no strong match has
  // near-identical rerank scores, the 0.6 term stops separating anything, and
  // authority + freshness (the other 40%) silently decide the ranking. So the
  // pool-normalized value is used when scoreCandidates has computed one.
  const rerank = c.rerankNormalized ?? c.rerankScore;
  const authority = c.authorityScore ?? 0;
  const freshness = c.freshnessScore ?? freshnessScore(c.createdAt);
  return WEIGHT_RERANK * rerank + WEIGHT_AUTHORITY * authority + WEIGHT_FRESHNESS * freshness;
}

/** Scales to 0..1 against the strongest candidate, anchored at zero exactly as
 *  authority is. Equally-scored candidates all land on 1 and let the remaining
 *  signals break the tie; an all-zero pool contributes nothing. */
function normalize(values: number[]): number[] {
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  return values.map((value) => (max > min ? (value - min) / (max - min) : 0));
}

/** `limit` honours the caller's topK; FINAL_RESULT_COUNT remains the default. */
export function scoreCandidates(
  candidates: RerankedCandidate[],
  now = new Date(),
  limit = FINAL_RESULT_COUNT,
): RerankedCandidate[] {
  const authorityScores = normalize(candidates.map((c) =>
    Math.log(1 + c.tipCount + c.retrievalCount) / Math.log(AUTHORITY_LOG_BASE)));
  const rerankScores = normalize(candidates.map((c) => c.rerankScore));
  return candidates.map((candidate, i) => {
    const freshness = freshnessScore(candidate.createdAt, now);
    const enriched = {
      ...candidate,
      authorityScore: authorityScores[i],
      rerankNormalized: rerankScores[i],
      freshnessScore: freshness,
    };
    return { ...enriched, finalScore: finalScore(enriched) };
  }).sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0)).slice(0, limit);
}

function freshnessScore(createdAt: Date, now = new Date()): number {
  const ageDays = Math.max(0, now.getTime() - createdAt.getTime()) / 86_400_000;
  return 0.5 ** (ageDays / FRESHNESS_HALF_LIFE_DAYS);
}
