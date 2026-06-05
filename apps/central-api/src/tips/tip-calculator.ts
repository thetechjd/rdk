// apps/central-api/src/tips/tip-calculator.ts
// Network-calculated tip amounts — operators don't set prices, the network measures value delivered.

export interface RetrievalMetrics {
  cosineSimilarity: number;   // 0.0–1.0  — how well the chunk matched
  qualityScore: number;       // 0–100    — chunk quality (retrieval history, density)
  chunkTokens: number;        // 1–512    — size of the chunk served
  rankPosition: number;       // 1–10     — where it appeared in results (1 = best)
  freshnessScore: number;     // 0.0–1.0  — recency of indexing (1 = just indexed)
}

export interface TipResult {
  amountUsdc: number;
  breakdown: {
    baseRate: number;
    similarityFactor: number;
    qualityFactor: number;
    rankFactor: number;
    sizeFactor: number;
    freshnessFactor: number;
  };
}

// Target: ~10-15% of the token cost saved by a typical retrieval.
// GPT-4o input: ~$0.005/1K tokens. A 512-token chunk = $0.0025 cost avoided.
// 10% of that = $0.00025. Round up to $0.001 as base for a perfect retrieval.
const BASE_RATE_USDC = 0.001;

export function calculateTip(metrics: RetrievalMetrics): TipResult {
  // Below 0.72 we don't retrieve at all (router threshold).
  // Scale 0.72–1.0 → 0.0–1.0
  const similarityFactor = Math.max(0, (metrics.cosineSimilarity - 0.72) / 0.28);

  const qualityFactor = metrics.qualityScore / 100;

  // Position 1 = 1.0, position 2 = 0.65, position 3 = 0.45, etc.
  const rankFactor = 1 / Math.log2(metrics.rankPosition + 1);

  // Full 512-token chunk is worth more than a 50-token fragment
  const sizeFactor = Math.min(metrics.chunkTokens / 512, 1.0);

  // Decays from 1.0 (just indexed) to 0.5 (30+ days old) — never zero
  const freshnessFactor = 0.5 + (0.5 * metrics.freshnessScore);

  const amount = BASE_RATE_USDC
    * similarityFactor
    * qualityFactor
    * rankFactor
    * sizeFactor
    * freshnessFactor;

  // Floor: don't process tips under $0.0001 — gas cost exceeds value
  // Ceiling: hard cap at autonomous threshold — above $0.05 requires user approval
  const amountUsdc = Math.min(
    Math.max(amount, amount > 0 ? 0.0001 : 0),
    0.049,
  );

  return {
    amountUsdc: Math.round(amountUsdc * 1_000_000) / 1_000_000, // 6 decimal precision
    breakdown: {
      baseRate: BASE_RATE_USDC,
      similarityFactor,
      qualityFactor,
      rankFactor,
      sizeFactor,
      freshnessFactor,
    },
  };
}

export function computeFreshnessScore(freshnessAt: Date): number {
  const ageMs = Date.now() - freshnessAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays <= 7) return 1.0;
  if (ageDays <= 30) return 1.0 - ((ageDays - 7) / 23);
  return 0.0;
}
