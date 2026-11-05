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

/** The bucket key the indexer charges when it isn't given a node id (NodeController doesn't give one). */
export const INDEX_RATE_DEFAULT_NODE = 'local';

/** How much indexing a node can do right now, and how long until it can index one more document. */
export interface IndexCapacity {
  perHour: number;
  burst: number;
  /** Documents the node can index now, without waiting. */
  available: number;
  /** 0 when `available >= 1`; else milliseconds until one more document can be indexed. */
  waitMs: number;
}

const refillPerMs = INDEX_RATE_LIMIT_PER_HOUR / 3_600_000;

function refilled(prior: RateLimitState | undefined, now: number): number {
  if (!prior) return INDEX_RATE_LIMIT_BURST;
  return Math.min(INDEX_RATE_LIMIT_BURST, prior.tokens + Math.max(0, now - prior.updatedAt) * refillPerMs);
}

/** Reads the bucket without charging it. */
export function indexCapacity(nodeId: string, store: Pick<RateLimitStore, 'get'>, now = Date.now()): IndexCapacity {
  const tokens = refilled(store.get(nodeId), now);
  return {
    perHour: INDEX_RATE_LIMIT_PER_HOUR,
    burst: INDEX_RATE_LIMIT_BURST,
    available: Math.floor(tokens),
    waitMs: tokens >= 1 ? 0 : Math.ceil((1 - tokens) / refillPerMs),
  };
}

export function consumeIndexToken(nodeId: string, store: RateLimitStore, now = Date.now()): void {
  const tokens = refilled(store.get(nodeId), now);
  if (tokens < 1) {
    store.set(nodeId, { tokens, updatedAt: now });
    throw new Error(`Index rate limit exceeded for node ${nodeId}`);
  }
  store.set(nodeId, { tokens: tokens - 1, updatedAt: now });
}
