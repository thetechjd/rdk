import {
  INDEX_RATE_LIMIT_BURST,
  INDEX_RATE_LIMIT_PER_HOUR,
} from '../query/pipeline.constants.js';

export interface RateLimitState {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitStore {
  get(nodeId: string): RateLimitState | undefined;
  set(nodeId: string, state: RateLimitState): void;
}

export function consumeIndexToken(nodeId: string, store: RateLimitStore, now = Date.now()): void {
  const prior = store.get(nodeId) ?? { tokens: INDEX_RATE_LIMIT_BURST, updatedAt: now };
  const refillPerMs = INDEX_RATE_LIMIT_PER_HOUR / 3_600_000;
  const tokens = Math.min(INDEX_RATE_LIMIT_BURST, prior.tokens + Math.max(0, now - prior.updatedAt) * refillPerMs);
  if (tokens < 1) {
    store.set(nodeId, { tokens, updatedAt: now });
    throw new Error(`Index rate limit exceeded for node ${nodeId}`);
  }
  store.set(nodeId, { tokens: tokens - 1, updatedAt: now });
}
