import type { EmbeddingModel } from '../models/embedding.js';
import type { LocalStore, SearchResult, StoredChunk } from '../store/local-store.js';
import { decrypt, type VaultKey } from '../crypto.js';
import { queryCache } from './cache.js';
import { CANDIDATE_POOL_SIZE, FINAL_RESULT_COUNT } from './pipeline.constants.js';
import { LocalOnnxRerankModel } from './model.js';
import { packageResults } from './serve.js';
import { rerankCandidates, type RerankModel } from './rerank.js';
import { retrieveCandidates, type RetrievalHit, type RetrievalStats } from './retrieve.js';
import type { RerankedCandidate } from './types.js';
import { scoreCandidates } from './score.js';
import { configureQueryVocabulary, loadBundledEnglishFrequencies, understandQuery } from './understand.js';
import path from 'path';

export interface PipelineResult {
  text: string;
  corrected: string;
  cacheHit: boolean;
  candidates: number;
  rerankMs: number;
  totalMs: number;
  blockedCount: number;
}

export interface QueryPipelineNetwork {
  preview(query: string, limit: number, domain?: string): Promise<RetrievalHit[]>;
  resolve(candidate: RerankedCandidate, query: string): Promise<RerankedCandidate>;
}

export class QueryPipeline {
  private reranker: RerankModel;

  constructor(
    private store: LocalStore,
    private embeddingModel: EmbeddingModel,
    reranker: RerankModel = new LocalOnnxRerankModel(),
    private network?: QueryPipelineNetwork,
    private vaultKey?: VaultKey,
  ) {
    const vocabulary = store.getVocabulary();
    configureQueryVocabulary({
      ...vocabulary,
      dataDir: process.env.RDK_HOME ?? `${process.env.HOME ?? '.'}/.rdk`,
      baseFrequencies: loadBundledEnglishFrequencies(
        path.join(process.env.RDK_ASSETS_DIR ?? path.join(__dirname, '..', '..', 'assets'), 'frequency_dictionary_en_82_765.txt'),
      ),
    });
    this.reranker = reranker;
  }

  /**
   * Load the rerank weights before the first query arrives.
   *
   * The cold load is ~18s, which exceeds RERANK_TIMEOUT_MS — so without this the
   * first query after startup waits out the whole budget and then falls back to
   * RRF, ignoring the rerank weight entirely. Never rejects and never blocks:
   * a node that cannot warm still answers queries, just on RRF ordering until
   * the model arrives. Call it fire-and-forget at startup.
   */
  async warm(): Promise<void> {
    const started = Date.now();
    try {
      await this.reranker.warm?.();
      if (this.reranker.warm) console.error(`[rdk] rerank model ready in ${Date.now() - started}ms`);
    } catch (error) {
      console.error(`[rdk] rerank model warm-up failed; queries will use RRF order: ${(error as Error).message}`);
    }
  }

  async query(
    raw: string,
    opts: { includePrivate?: boolean; includeNetwork?: boolean; domain?: string; topK?: number } = {},
  ): Promise<PipelineResult> {
    const started = Date.now();
    const understood = understandQuery(raw);
    // A caller asking for more than the pool holds gets the pool; a nonsense
    // value falls back to the locked default rather than an empty answer.
    const resultLimit = Number.isFinite(opts.topK) && (opts.topK as number) > 0
      ? Math.min(Math.floor(opts.topK as number), CANDIDATE_POOL_SIZE)
      : FINAL_RESULT_COUNT;
    // Domain and topK both scope the result set, so they must scope the cache
    // key too, or the first caller's answer gets served to everyone else. A
    // normalized query cannot contain a tab, so the parts stay unambiguous.
    const cacheKey = [resultLimit, opts.domain ?? '', understood.corrected].join('\t');
    const cacheAllowed = opts.includePrivate !== false && opts.includeNetwork !== false;
    const cached = cacheAllowed ? queryCache.get(cacheKey) : undefined;
    if (cached !== undefined) {
      const result = { text: cached, corrected: understood.corrected, cacheHit: true, candidates: 0, rerankMs: 0, totalMs: Date.now() - started, blockedCount: 0 };
      this.log(result);
      return result;
    }

    const stats: RetrievalStats = { blocked: new Set<string>() };
    const networkCache = new Map<string, Promise<RetrievalHit[]>>();
    const networkHits = (query: string, limit: number) => {
      if (opts.includeNetwork === false || !this.network) return Promise.resolve([]);
      let pending = networkCache.get(query);
      if (!pending) { pending = this.network.preview(query, limit, opts.domain); networkCache.set(query, pending); }
      return pending;
    };
    const candidates = await retrieveCandidates(understood, {
      lexical: async (query, limit) => [
        ...(opts.includePrivate === false ? [] : this.store.lexicalSearch(query, limit, opts.domain).map((row) => this.hit(row))),
        ...await networkHits(query, limit),
      ],
      vector: async (query, limit) => {
        const embedding = await this.embeddingModel.embed(query);
        return [
          ...(opts.includePrivate === false ? [] : this.store.search(embedding, limit, false, opts.domain).map((row) => this.hit(row))),
          ...await networkHits(query, limit),
        ];
      },
    }, stats);
    const blockedCount = stats.blocked.size;
    const rerankStarted = Date.now();
    const reranked = await rerankCandidates(understood, candidates, this.reranker);
    const rerankMs = Date.now() - rerankStarted;
    let final = scoreCandidates(reranked, new Date(), resultLimit);
    if (this.network) {
      final = await Promise.all(final.map((candidate) =>
        candidate.nodeId ? this.network!.resolve(candidate, understood.corrected) : candidate));
    }
    const text = packageResults(final);
    if (cacheAllowed && final.length > 0) queryCache.set(cacheKey, text);
    const result = { text, corrected: understood.corrected, cacheHit: false, candidates: candidates.length, rerankMs, totalMs: Date.now() - started, blockedCount };
    this.log(result);
    return result;
  }

  private hit(row: (StoredChunk | SearchResult) & { lexicalScore?: number }): RetrievalHit {
    let text = row.content;
    if (row.isEncrypted && this.vaultKey) {
      try { text = decrypt(row.content, this.vaultKey); } catch { text = '[encrypted — cannot decrypt]'; }
    }
    const { retrievalCount, tipCount } = this.store.getAuthorityCounts(row.id);
    return {
      chunkId: row.id,
      title: row.docTitle ?? row.title,
      text,
      summary: row.summary,
      riskScore: row.riskScore ?? 0,
      createdAt: row.createdAt,
      retrievalCount,
      tipCount,
    };
  }

  private log(result: PipelineResult): void {
    console.error(JSON.stringify({
      corrected: result.corrected,
      cache_hit: result.cacheHit,
      candidates: result.candidates,
      rerank_ms: result.rerankMs,
      total_ms: result.totalMs,
      blocked_count: result.blockedCount,
    }));
  }
}
