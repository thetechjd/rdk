// packages/rdk-core/src/router.ts
// Query routing: checks private chunks → public network → falls back to LLM.
// "Private chunks" = encrypted on RDK Central, decrypted locally at query time.
// This is the piece that collapses token spend 80-90%.

import { decrypt, type VaultKey } from './crypto.js';
import { type EmbeddingModel } from './models/embedding.js';
import { LocalStore, type SearchResult } from './store/local-store.js';
import { estimateTokens } from './cleaner.js';

export interface RouterConfig {
  localStore: LocalStore;
  embeddingModel: EmbeddingModel;
  centralApiUrl?: string;
  centralApiKey?: string;
  topK?: number;
  minSimilarity?: number;
  maxPrivateChunks?: number;
  fallbackToLLM?: boolean;
  domain?: string;
  vaultKey?: VaultKey;
  sharedVaultKeys?: Record<string, VaultKey>;
}

export interface NetworkChunk {
  chunkId: string;
  nodeId: string;
  providerNodeMcpEndpoint?: string;
  title: string;
  summary?: string;
  content?: string;
  isEncrypted?: boolean;
  score: number;
  tipAmountUsdc: number;
  domain?: string;
  categories: string[];
}

export interface TipRecord {
  chunkId: string;
  providerNodeId: string;
  amountUsdc: number;
  txHash?: string;
}

export interface QueryResult {
  source: 'private' | 'network' | 'llm_fallback';
  chunks: (SearchResult | NetworkChunk)[];
  context: string;
  tokenEstimate: number;
  tipsPaid: TipRecord[];
  latencyMs: number;
}

export class RDKRouter {
  constructor(private config: RouterConfig) {}

  async query(userQuery: string, overrides?: Partial<RouterConfig>): Promise<QueryResult> {
    const cfg = { ...this.config, ...overrides };
    // all-MiniLM-L6-v2 cosine scores for genuinely relevant matches land
    // ~0.3–0.6 (short query vs longer chunk), so a 0.72 bar meant the router
    // almost never answered from indexed knowledge and always fell back to the
    // LLM — defeating the point. 0.45 is a confident-match bar for this model.
    const minSim = cfg.minSimilarity ?? 0.45;
    const topK = cfg.topK ?? 5;
    const start = Date.now();

    // Step 1: Embed query locally
    const embedding = await cfg.embeddingModel.embed(userQuery);

    // Step 2: Private vault
    const rawPrivateResults = cfg.localStore.search(embedding, topK, true);
    const privateResults = rawPrivateResults.map(chunk => {
      if (!chunk.isEncrypted || !cfg.vaultKey) return chunk;
      try {
        return { ...chunk, content: decrypt(chunk.content, cfg.vaultKey) };
      } catch {
        return { ...chunk, content: '[encrypted — cannot decrypt]' };
      }
    });
    const bestPrivate = privateResults[0];

    if (bestPrivate && bestPrivate.score >= minSim) {
      const matched = privateResults.filter(r => r.score >= minSim);
      const context = assembleContext(matched);
      const latencyMs = Date.now() - start;
      cfg.localStore.logQuery({
        queryText: userQuery, source: 'private', matchedChunkId: bestPrivate.id,
        matchedChunks: matched.map(r => ({ id: r.id, score: r.score })), latencyMs,
      });
      return {
        source: 'private',
        chunks: privateResults.filter(r => r.score >= minSim),
        context,
        tokenEstimate: estimateTokens(context),
        tipsPaid: [],
        latencyMs,
      };
    }

    // Step 3: Network query
    if (cfg.centralApiUrl && cfg.centralApiKey) {
      try {
        const rawNetworkResults = await this.queryNetwork(embedding, cfg);
        const networkResults = rawNetworkResults.map(chunk => {
          if (!chunk.isEncrypted) return chunk;
          const key = cfg.sharedVaultKeys?.[chunk.nodeId];
          if (!key) return { ...chunk, content: '[private — no decryption key]' };
          try {
            return { ...chunk, content: decrypt(chunk.content ?? '', key) };
          } catch {
            return { ...chunk, content: '[private — decryption failed]' };
          }
        });
        const bestNetwork = networkResults[0];

        if (bestNetwork && bestNetwork.score >= minSim) {
          const matchedNetwork = networkResults.filter(r => r.score >= minSim);
          const context = assembleNetworkContext(matchedNetwork);
          const latencyMs = Date.now() - start;
          cfg.localStore.logQuery({
            queryText: userQuery, source: 'network', matchedChunkId: bestNetwork.chunkId,
            matchedChunks: matchedNetwork.map(r => ({ id: r.chunkId, score: r.score })), latencyMs,
          });

          // Enqueue tips for matched network chunks
          const tipsPaid: TipRecord[] = [];
          for (const chunk of matchedNetwork) {
            if (chunk.tipAmountUsdc > 0) {
              cfg.localStore.enqueueTip({
                chunkId: chunk.chunkId,
                providerNodeId: chunk.nodeId,
                amountUsdc: chunk.tipAmountUsdc,
                chain: 'base',
              });
              tipsPaid.push({ chunkId: chunk.chunkId, providerNodeId: chunk.nodeId, amountUsdc: chunk.tipAmountUsdc });
            }
          }

          return {
            source: 'network',
            chunks: networkResults.filter(r => r.score >= minSim),
            context,
            tokenEstimate: estimateTokens(context),
            tipsPaid,
            latencyMs,
          };
        }
      } catch (e) {
        // Network failure → fall through to LLM
      }
    }

    // Step 4: LLM fallback signal
    const latencyMs = Date.now() - start;
    cfg.localStore.logQuery({ queryText: userQuery, source: 'llm_fallback', latencyMs });
    return {
      source: 'llm_fallback',
      chunks: [],
      context: '',
      tokenEstimate: 0,
      tipsPaid: [],
      latencyMs,
    };
  }

  private jwtToken?: string;
  private jwtExpiry = 0;

  private async getJwt(cfg: RouterConfig): Promise<string> {
    if (this.jwtToken && Date.now() < this.jwtExpiry) return this.jwtToken;
    const authRes = await fetch(`${cfg.centralApiUrl}/api/v1/nodes/auth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.centralApiKey}` },
    });
    if (!authRes.ok) throw new Error(`Auth failed: ${authRes.status}`);
    const { jwtToken } = await authRes.json() as { jwtToken: string };
    this.jwtToken = jwtToken;
    this.jwtExpiry = Date.now() + 55 * 60 * 1000; // refresh 5 min before 1h expiry
    return jwtToken;
  }

  private async queryNetwork(embedding: Float32Array, cfg: RouterConfig): Promise<NetworkChunk[]> {
    const jwt = await this.getJwt(cfg);
    const response = await fetch(`${cfg.centralApiUrl}/api/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        embedding: Array.from(embedding),
        topK: cfg.topK ?? 5,
        domain: cfg.domain,
      }),
    });

    if (!response.ok) throw new Error(`Network query failed: ${response.status}`);

    const { results } = (await response.json()) as { results: NetworkChunk[]; queryId: string };

    // Fetch chunk content from provider MCP endpoints where available
    const enriched = await Promise.allSettled(
      results.map(r => this.fetchChunkContent(r)),
    );

    return enriched
      .map((r, i) => r.status === 'fulfilled' ? r.value : results[i])
      .filter(Boolean) as NetworkChunk[];
  }

  private async fetchChunkContent(chunk: NetworkChunk): Promise<NetworkChunk> {
    if (!chunk.providerNodeMcpEndpoint) return chunk;
    try {
      const res = await fetch(`${chunk.providerNodeMcpEndpoint}/chunks/${chunk.chunkId}`, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = (await res.json()) as { content?: string };
        return { ...chunk, content: data.content };
      }
    } catch {}
    // Degrade gracefully — use summary only
    return { ...chunk, content: chunk.summary };
  }
}

function assembleContext(chunks: SearchResult[]): string {
  return chunks
    .map((c, i) => `[${i + 1}] ${c.title}\n${c.content}`)
    .join('\n\n---\n\n');
}

function assembleNetworkContext(chunks: NetworkChunk[]): string {
  return chunks
    .map((c, i) => `[${i + 1}] ${c.title}\n${c.content ?? c.summary ?? ''}`)
    .join('\n\n---\n\n');
}
