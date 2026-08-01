import { RERANK_BATCH_SIZE, RERANK_TIMEOUT_MS } from './pipeline.constants.js';
import { RERANK_MODEL_LOAD_FAILURE } from './model.js';
import type { Candidate, RerankedCandidate, UnderstoodQuery } from './types.js';

export interface RerankModel {
  singleBatch?: boolean;
  score(pairs: Array<{ query: string; text: string }>): Promise<number[]>;
  /** Optional: load weights ahead of the first query. See QueryPipeline.warm(). */
  warm?(): Promise<void>;
}

export async function rerankCandidates(
  q: UnderstoodQuery,
  candidates: Candidate[],
  model?: RerankModel,
): Promise<RerankedCandidate[]> {
  const fallback = normalizeRrf(candidates);
  if (!model || candidates.length === 0) return fallback;
  try {
    const operation = async () => {
      if (model.singleBatch) {
        const scores = await model.score(candidates.map((c) => ({ query: q.corrected, text: rerankText(c) })));
        return candidates
          .map((candidate, i) => ({ ...candidate, rerankScore: Math.max(0, Math.min(1, scores[i] ?? 0)) }))
          .sort((a, b) => b.rerankScore - a.rerankScore);
      }
      const scores: number[] = [];
      for (let i = 0; i < candidates.length; i += RERANK_BATCH_SIZE) {
        // Local inference resolves as an already-settled promise, so without an
        // explicit yield the batch loop stays in the microtask queue and starves
        // the timeout timer — a macrotask — until every batch has finished. The
        // budget below would then never be enforceable. Yield so it can fire.
        if (i > 0) await yieldToEventLoop();
        const batch = candidates.slice(i, i + RERANK_BATCH_SIZE);
        scores.push(...await model.score(batch.map((c) => ({ query: q.corrected, text: rerankText(c) }))));
      }
      return candidates
        .map((candidate, i) => ({ ...candidate, rerankScore: sigmoid(scores[i] ?? 0) }))
        .sort((a, b) => b.rerankScore - a.rerankScore);
    };
    return await withTimeout(operation(), RERANK_TIMEOUT_MS);
  } catch (error) {
    const message = (error as Error).message;
    // Task 11: never fail the query. But a model that cannot load at all is a
    // configuration fault, and it gets an error, not a warning.
    if (message.includes(RERANK_MODEL_LOAD_FAILURE)) {
      console.error(`[rdk] rerank DISABLED — model unavailable; using RRF order: ${message}`);
    } else {
      console.warn(`[rdk] rerank failed or timed out; using RRF order: ${message}`);
    }
    return fallback;
  }
}

function normalizeRrf(candidates: Candidate[]): RerankedCandidate[] {
  const max = Math.max(...candidates.map((c) => c.rrfScore), 0);
  return candidates.map((candidate) => ({
    ...candidate,
    rerankScore: max > 0 ? candidate.rrfScore / max : 0,
  }));
}

/**
 * What the cross-encoder reads. Network candidates only ever carry a summary —
 * fetching a body settles a tip, so resolving all 50 to rank them would pay for
 * 45 chunks that get discarded. Ranking local chunks on their summaries too
 * makes the comparison fair instead of biasing toward local content, and costs
 * far less: a ~300-char summary is ~70 tokens against a body's 512-token cap.
 * Only ranking is affected — serve.ts still returns the full stored text.
 */
function rerankText(candidate: Candidate): string {
  return candidate.summary?.trim() || candidate.text;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sigmoid(value: number): number {
  if (value >= 0 && value <= 1) return value;
  return 1 / (1 + Math.exp(-value));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
