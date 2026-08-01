import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { QueryPipeline } from '../src/query/pipeline.js';
import { queryCache } from '../src/query/cache.js';
import { ELEVATED_RISK_NOTICE } from '../src/query/pipeline.constants.js';
import type { EmbeddingModel } from '../src/models/embedding.js';
import type { LocalStore, StoredChunk } from '../src/store/local-store.js';

/**
 * Drives the real QueryPipeline — understand → cache → retrieve → rerank →
 * score → serve — rather than hand-wiring the stages as
 * query-pipeline.integration.test.ts does. That distinction matters: the
 * pipeline is where risk filtering, blocked_count, the domain-scoped cache key
 * and the authority lookup actually live.
 *
 * The store is a stub for the same reason as lineage.test.ts and
 * publish-resync.test.ts: better-sqlite3's native binding is built against a
 * different NODE_MODULE_VERSION than the vitest runner, so LocalStore cannot be
 * constructed here. The SQL itself (domain predicates, migration v2,
 * getAuthorityCounts) is therefore NOT covered by this test.
 */

const ON_TOPIC = 'Non custodial EVM wallet transaction signing key storage and browser extension architecture.';
const OFF_TOPIC = 'An unrelated team chat and messaging specification.';

function chunk(index: number): StoredChunk & { lexicalScore: number; score: number } {
  return {
    id: `chunk-${index}`,
    // chunk-0 is title bait: its title matches the query, its body does not.
    title: index === 0 ? 'MetaMask Clone' : `Wallet document ${index}`,
    docTitle: index === 0 ? 'MetaMask Clone' : `Wallet document ${index}`,
    content: index === 0 ? OFF_TOPIC : ON_TOPIC,
    summary: undefined,
    domain: index === 3 ? 'fintech' : 'engineering',
    riskScore: index === 1 ? 0.9 : index === 2 ? 0.5 : 0,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    isEncrypted: false,
    lexicalScore: 1,
    score: 1,
  } as unknown as StoredChunk & { lexicalScore: number; score: number };
}

const ROWS = Array.from({ length: 30 }, (_, index) => chunk(index));

/** Only the surface QueryPipeline actually calls. */
function stubStore(): LocalStore {
  return {
    getVocabulary: () => ({ words: ROWS.map((row) => row.title), chunkCount: ROWS.length }),
    lexicalSearch: (_query: string, limit: number, domain?: string) =>
      ROWS.filter((row) => !domain || row.domain === domain).slice(0, limit),
    search: (_embedding: Float32Array, limit: number, _privateOnly: boolean, domain?: string) =>
      [...ROWS].reverse().filter((row) => !domain || row.domain === domain).slice(0, limit),
    // chunk-4 is the only tipped/retrieved chunk, so it carries authority 1.0.
    getAuthorityCounts: (chunkId: string) =>
      chunkId === 'chunk-4' ? { retrievalCount: 40, tipCount: 12 } : { retrievalCount: 0, tipCount: 0 },
  } as unknown as LocalStore;
}

const embeddingModel = {
  embed: async () => new Float32Array([1, 0, 0]),
  embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])),
  dimensions: 3,
  modelName: 'stub',
} satisfies EmbeddingModel;

const reranker = {
  score: async (pairs: Array<{ query: string; text: string }>) =>
    pairs.map((pair) => (pair.text.includes('Non custodial EVM') ? 0.95 : 0.05)),
};

function pipeline(): QueryPipeline {
  return new QueryPipeline(stubStore(), embeddingModel, reranker);
}

/** Chunk ids in the order the envelope serves them. */
function servedOrder(text: string): string[] {
  return [...text.matchAll(/RDK_DATA_BEGIN chunk_id=(\S+) /g)].map((match) => match[1]);
}

describe('query pipeline end to end', () => {
  beforeAll(() => {
    // configureQueryVocabulary persists a compiled dictionary; keep it out of ~/.rdk.
    process.env.RDK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-e2e-'));
  });

  it('blocks high-risk chunks, flags elevated ones, and demotes title bait', async () => {
    queryCache.clear();
    const result = await pipeline().query('metamask clone');

    expect(result.text).not.toContain('chunk_id=chunk-1');
    // blocked_count is this query's dropped candidates, not every risky row in the store.
    expect(result.blockedCount).toBe(1);
    expect(result.text).toContain(ELEVATED_RISK_NOTICE);
    expect(result.candidates).toBeGreaterThan(0);
    expect(result.cacheHit).toBe(false);

    const order = servedOrder(result.text);
    expect(order).toHaveLength(5);
    // The bait's title matches the query and its RRF rank is high, so only the
    // reranker reading its off-topic body can push it out of the top 5.
    expect(order).not.toContain('chunk-0');
    // Elevated risk is a warning, not a drop: chunk-2 is still served.
    expect(order).toContain('chunk-2');
  });

  it('lets tips carry a chunk up the composite score', async () => {
    queryCache.clear();
    const result = await pipeline().query('metamask clone');
    // chunk-4 is on-topic like its peers and its rerank score ties with theirs;
    // only its tip and retrieval counts differ, so authority alone must rank it
    // first. This fails if tipCount is hardcoded to 0 again.
    expect(servedOrder(result.text)[0]).toBe('chunk-4');
  });

  it('serves the second identical query from cache', async () => {
    queryCache.clear();
    const engine = pipeline();
    await engine.query('metamask clone');
    const second = await engine.query('metamask clone');
    expect(second.cacheHit).toBe(true);
    expect(second.blockedCount).toBe(0);
  });

  it('warms the rerank model without blocking or throwing', async () => {
    let warmed = 0;
    const warming = new QueryPipeline(stubStore(), embeddingModel, {
      ...reranker,
      warm: async () => { warmed += 1; },
    });
    await warming.warm();
    expect(warmed).toBe(1);

    // A node that cannot load the model must still start and still answer.
    const failing = new QueryPipeline(stubStore(), embeddingModel, {
      ...reranker,
      warm: async () => { throw new Error('no network'); },
    });
    await expect(failing.warm()).resolves.toBeUndefined();
    queryCache.clear();
    expect(servedOrder((await failing.query('metamask clone')).text)).toHaveLength(5);
  });

  it('honours topK, caps it at the candidate pool, and keeps it out of other callers caches', async () => {
    queryCache.clear();
    const engine = pipeline();

    expect(servedOrder((await engine.query('metamask clone')).text)).toHaveLength(5);
    expect(servedOrder((await engine.query('metamask clone', { topK: 12 })).text)).toHaveLength(12);
    // A different topK must not be answered from the 5-result cached entry.
    expect((await engine.query('metamask clone', { topK: 12 })).cacheHit).toBe(true);
    expect((await engine.query('metamask clone', { topK: 3 })).cacheHit).toBe(false);

    // Asking for more than exists returns everything available, not an error.
    const huge = await engine.query('metamask clone', { topK: 9999 });
    expect(servedOrder(huge.text).length).toBeLessThanOrEqual(29);
    expect(servedOrder(huge.text).length).toBeGreaterThan(12);

    // Nonsense falls back to the locked default rather than emptying the answer.
    expect(servedOrder((await engine.query('metamask clone', { topK: 0 })).text)).toHaveLength(5);
  });

  it('does not serve a cached global answer to a domain-scoped query', async () => {
    queryCache.clear();
    const engine = pipeline();
    const unscoped = await engine.query('metamask clone');
    const scoped = await engine.query('metamask clone', { domain: 'fintech' });

    expect(scoped.cacheHit).toBe(false);
    expect(scoped.text).not.toBe(unscoped.text);
    // fintech holds only chunk-3.
    expect(scoped.text).toContain('chunk_id=chunk-3');
    expect(scoped.text).not.toContain('chunk_id=chunk-5');
  });
});
