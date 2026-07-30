// packages/rdk-core/src/router.ts
// Query routing: checks the LOCAL vault (private + your own public chunks) →
// public network → falls back to LLM. Your own content always answers first
// and free. This is the piece that collapses token spend 80-90%.

import { decrypt, type VaultKey } from './crypto.js';
import { type EmbeddingModel } from './models/embedding.js';
import { LocalStore, type SearchResult } from './store/local-store.js';
import { estimateTokens } from './cleaner.js';

export interface RouterConfig {
  localStore: LocalStore;
  embeddingModel: EmbeddingModel;
  centralApiUrl?: string;
  centralApiKey?: string;
  /** This node's id — used to recognize the caller's own chunks in network
   *  results so they are never tipped locally. */
  nodeId?: string;
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
  /** The CONTENT hash — identity of the content itself, identical on every node
   *  that holds it. `chunkId` is Central's row id and means nothing elsewhere.
   *  Absent from older centrals. */
  chunkHash?: string;
  /** Stable identity of the complete source document. */
  documentHash?: string;
  nodeId: string;
  providerNodeMcpEndpoint?: string;
  title: string;
  /** The document's own name, when Central knows it. Falls back to splitting
   *  `title` on the section separator. */
  docTitle?: string;
  /** The section whose embedding caused this complete document to match. */
  matchedSection?: string;
  summary?: string;
  content?: string;
  /** Central's wire name for live-fetched content: plaintext for public chunks,
   *  ciphertext for private ones. (The name is historical; it is not always
   *  encrypted.) Reading only `content` here silently dropped every network
   *  result's body. */
  contentEncrypted?: string | null;
  /** False when Central matched the chunk but could not obtain its content. */
  available?: boolean;
  /** Why the content is missing, when `available` is false (e.g. 'owner_offline'). */
  unavailableReason?: string;
  isEncrypted?: boolean;
  score: number;
  tipAmountUsdc: number;
  /** Set by central when the chunk belongs to the querying user's own account
   *  (any of their linked nodes). Own content is free — no charge, no tip. */
  isOwn?: boolean;
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
  /** Set when nothing cleared the confidence bar and these are the best local
   *  matches, returned so the caller can show something rather than nothing.
   *  Treat as a weak signal, not an answer. */
  lowConfidence?: boolean;
  /** The network step failed outright (auth, credit gate, unreachable Central).
   *  Distinct from "the network had no match" — this used to be swallowed, so a
   *  402 and a genuine miss were indistinguishable to the user. */
  networkError?: string;
  /** Central's own explanation when it returned no usable results. */
  networkMessage?: string;
  /** Matched on the network but not retrievable. The reason distinguishes an
   *  offline owner from timeout, transport, and stale-index failures. */
  unavailableChunks?: { chunkId: string; title: string; nodeId: string; reason?: string }[];
}

/**
 * The only relevance bar, and it is a NOISE FLOOR — not a quality gate.
 *
 * Central already ranks every candidate by cosine similarity and returns the
 * best ones. The client's job is to show them, not to second-guess the ranking
 * with an absolute cutoff.
 *
 * This bar used to be 0.45, which was simply wrong for all-MiniLM-L6-v2: a short
 * query against a long chunk lands in the 0.3–0.6 band (the old comment said so
 * itself), so 0.45 discarded most genuine matches. Real example from production
 * — the query "instagram clone" returned ten results, every one of them present
 * and retrievable, topping out at 0.4416. All ten were thrown away and the user
 * was told "no confident match" about their own published content.
 *
 * If a score is above this floor it is worth showing, ranked. Absolute cosine
 * values from a sentence-embedding model do not mean "good" or "bad".
 */
const RELEVANCE_FLOOR = 0.25;

/** Below this the top match is worth showing but worth hedging about. */
const CONFIDENT_MATCH = 0.45;

/** The document name — everything before the section separator. Matching the
 *  section would let "…— 9. Client State Management" answer a query about state
 *  management from entirely the wrong document. */
function docName(title: string): string {
  return (title.split(' — ')[0] ?? title).toLowerCase();
}

/**
 * Rank candidates by vector score plus how distinctively their NAME matches the
 * query, weighting each term by how rare it is among the candidates (IDF).
 *
 * Rarity is the part that matters. A first attempt counted matched terms
 * equally, and it did not work: for "discord clone" every candidate is named
 * `something-clone`, so "clone" boosted all of them identically and telegram —
 * with a marginally better vector — still won. "Discord" is the term carrying
 * all the information, and a term appearing in nearly every name carries none.
 *
 * Runs on the client, where the query text already lives, so nothing extra is
 * sent to the network.
 */
function rerank<T extends { title: string; score: number }>(query: string, items: T[]): T[] {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
  if (terms.length === 0 || items.length === 0) return items;

  const names = items.map(i => docName(i.title));
  const n = names.length;
  const idf = (t: string) => {
    const df = names.filter(name => name.includes(t)).length;
    return Math.log((n + 1) / (df + 1)); // 0 when every name has it
  };
  const weights = new Map(terms.map(t => [t, idf(t)]));
  const total = terms.reduce((s, t) => s + (weights.get(t) ?? 0), 0);
  if (total <= 0) return items; // every term is uninformative here

  return items
    .map((item, i) => {
      const matched = terms
        .filter(t => names[i].includes(t))
        .reduce((s, t) => s + (weights.get(t) ?? 0), 0);
      return { item, rank: item.score + 0.35 * (matched / total) };
    })
    .sort((a, b) => b.rank - a.rank)
    .map(x => x.item);
}

export class RDKRouter {
  constructor(private config: RouterConfig) {}

  async query(userQuery: string, overrides?: Partial<RouterConfig>): Promise<QueryResult> {
    const cfg = { ...this.config, ...overrides };
    // A noise floor, not a quality gate — see RELEVANCE_FLOOR. This was 0.45,
    // which silently discarded whole result sets that Central had already
    // ranked, fetched and confirmed available.
    const minSim = cfg.minSimilarity ?? RELEVANCE_FLOOR;
    const topK = cfg.topK ?? 5;
    const start = Date.now();

    // Step 1: Embed query locally
    const embedding = await cfg.embeddingModel.embed(userQuery);

    // Step 2: The local vault — private AND the user's own public chunks. The
    // local store only ever holds this user's own content, so everything found
    // here is theirs: answered locally, free, no network round-trip. (Previously
    // privateOnly=true hid own public chunks, forcing a charged network fetch
    // for content the user had sitting on disk.)
    const rawPrivateResults = cfg.localStore.search(embedding, topK, false);
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
        // Above the noise floor but below a confident match: worth showing,
        // worth hedging about. Lowering the floor moved these results out of
        // the step-4 near-miss path and onto this one, so the hedge has to
        // live here too or a 0.3 match would be presented as a firm answer.
        ...(bestPrivate.score < CONFIDENT_MATCH ? { lowConfidence: true } : {}),
      };
    }

    // Step 3: Network query
    let networkError: string | undefined;
    let networkMessage: string | undefined;
    let unavailableChunks: QueryResult['unavailableChunks'];
    if (cfg.centralApiUrl && cfg.centralApiKey) {
      try {
        const { results: rawNetworkResults, settledByCentral, message } =
          await this.queryNetwork(userQuery, embedding, cfg);
        networkMessage = message;

        // Chunks Central matched but couldn't fetch content for. They can't
        // answer, but the caller needs the real reason rather than a false
        // blanket claim that the owner is offline.
        unavailableChunks = rerank(userQuery, rawNetworkResults.filter(c => c.available === false))
          .map(c => ({ chunkId: c.chunkId, title: c.title, nodeId: c.nodeId, reason: c.unavailableReason }));

        // Floor first, then rank, then cut. Ordering matters: reranking before
        // the floor would let a lexically-boosted noise result displace a real
        // match, and slicing before the rerank would cut the named document out
        // of the candidate pool before its name ever counted.
        const networkResults = rerank(
          userQuery,
          rawNetworkResults.filter(c => c.available !== false && c.score >= minSim),
        )
          .slice(0, cfg.topK ?? 5)
          .map(chunk => {
            // Central names the live-fetched body `contentEncrypted` on the wire.
            const body = chunk.contentEncrypted ?? chunk.content;
            if (!chunk.isEncrypted) return { ...chunk, content: body ?? chunk.summary };
            const key = cfg.sharedVaultKeys?.[chunk.nodeId];
            if (!key) return { ...chunk, content: '[private — no decryption key]' };
            try {
              return { ...chunk, content: decrypt(body ?? '', key) };
            } catch {
              return { ...chunk, content: '[private — decryption failed]' };
            }
          });
        const bestNetwork = networkResults[0];

        if (bestNetwork) {
          const matchedNetwork = networkResults;
          const context = assembleNetworkContext(matchedNetwork);
          const latencyMs = Date.now() - start;
          cfg.localStore.logQuery({
            queryText: userQuery, source: 'network', matchedChunkId: bestNetwork.chunkId,
            matchedChunks: matchedNetwork.map(r => ({ id: r.chunkId, score: r.score })), latencyMs,
          });

          // Tips for matched network chunks. NEVER for the user's own content
          // (server isOwn flag, or provider node == this node) — own content is
          // free. tipsPaid REPORTS the query's real cost; the local enqueue
          // (on-chain x402 rail) only happens when central did NOT already
          // settle the tips server-side via RetroDeck credits — enqueueing
          // those too would double-pay.
          const tipsPaid: TipRecord[] = [];
          for (const chunk of matchedNetwork) {
            const isOwn = chunk.isOwn === true || (cfg.nodeId != null && chunk.nodeId === cfg.nodeId);
            if (chunk.tipAmountUsdc > 0 && !isOwn) {
              tipsPaid.push({ chunkId: chunk.chunkId, providerNodeId: chunk.nodeId, amountUsdc: chunk.tipAmountUsdc });
              if (settledByCentral !== true) {
                cfg.localStore.enqueueTip({
                  chunkId: chunk.chunkId,
                  providerNodeId: chunk.nodeId,
                  amountUsdc: chunk.tipAmountUsdc,
                  chain: 'base',
                });
              }
            }
          }

          return {
            source: 'network',
            chunks: networkResults.filter(r => r.score >= minSim),
            // Shown either way; the flag only lets the UI hedge its wording.
            ...(bestNetwork.score < CONFIDENT_MATCH ? { lowConfidence: true } : {}),
            context,
            tokenEstimate: estimateTokens(context),
            tipsPaid,
            latencyMs,
            ...(unavailableChunks.length ? { unavailableChunks } : {}),
          };
        }

        // Nothing retrievable cleared the bar, but Central matched chunks whose
        // owner is offline. A summary is a poor substitute for the content —
        // and a far better answer than none. Never tipped: no one served it.
        const summarised = rawNetworkResults.filter(
          r => r.available === false && r.score >= minSim && !!r.summary?.trim(),
        );
        if (summarised.length > 0) {
          const context = assembleNetworkContext(summarised);
          const latencyMs = Date.now() - start;
          cfg.localStore.logQuery({
            queryText: userQuery, source: 'network', matchedChunkId: summarised[0].chunkId,
            matchedChunks: summarised.map(r => ({ id: r.chunkId, score: r.score })), latencyMs,
          });
          return {
            source: 'network',
            chunks: summarised,
            context,
            tokenEstimate: estimateTokens(context),
            tipsPaid: [],
            latencyMs,
            lowConfidence: true,
            ...(networkMessage ? { networkMessage } : {}),
            ...(unavailableChunks.length ? { unavailableChunks } : {}),
          };
        }
      } catch (e) {
        // Record it — an empty catch here made a 402 credit gate, an expired API
        // key and an unreachable Central all look identical to "no match".
        networkError = (e as Error).message;
      }
    }

    // Step 4: nothing cleared the bar. Rather than reporting a bare miss, hand
    // back the best local matches (if any are above the noise floor) marked as
    // low confidence — the caller can show them, and a near-miss on the user's
    // own vault is far more useful than silence.
    const latencyMs = Date.now() - start;
    const nearMisses = privateResults.filter(r => r.score >= RELEVANCE_FLOOR);
    if (nearMisses.length > 0) {
      const context = assembleContext(nearMisses);
      cfg.localStore.logQuery({
        queryText: userQuery, source: 'private', matchedChunkId: nearMisses[0].id,
        matchedChunks: nearMisses.map(r => ({ id: r.id, score: r.score })), latencyMs,
      });
      return {
        source: 'private',
        chunks: nearMisses,
        context,
        tokenEstimate: estimateTokens(context),
        tipsPaid: [],
        latencyMs,
        lowConfidence: true,
        ...(networkError ? { networkError } : {}),
        ...(networkMessage ? { networkMessage } : {}),
        ...(unavailableChunks?.length ? { unavailableChunks } : {}),
      };
    }

    cfg.localStore.logQuery({ queryText: userQuery, source: 'llm_fallback', latencyMs });
    return {
      source: 'llm_fallback',
      chunks: [],
      context: '',
      tokenEstimate: 0,
      tipsPaid: [],
      latencyMs,
      ...(networkError ? { networkError } : {}),
      ...(networkMessage ? { networkMessage } : {}),
      ...(unavailableChunks?.length ? { unavailableChunks } : {}),
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

  private async queryNetwork(
    queryText: string,
    embedding: Float32Array,
    cfg: RouterConfig,
  ): Promise<{ results: NetworkChunk[]; settledByCentral?: boolean; message?: string }> {
    const jwt = await this.getJwt(cfg);
    const response = await fetch(`${cfg.centralApiUrl}/api/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Central needs the words, not only the vector. Exact normalized
        // document-title matches must outrank noisy short-query embeddings
        // (`instagram clone` === `instagram-clone`).
        queryText,
        embedding: Array.from(embedding),
        // Ask for a wider pool than we intend to show, because the re-rank below
        // can promote a chunk the vector score buried. The discord spec sat at
        // rank 11 for the query "discord clone"; a topK-sized pool would have
        // discarded it before anything could rescue it.
        topK: Math.max(20, (cfg.topK ?? 5) * 4),
        domain: cfg.domain,
        // Tell Central we can handle matched-but-unretrievable chunks, so an
        // offline owner reports as such instead of looking like "no match".
        // Older centrals ignore the flag.
        includeUnavailable: true,
      }),
    });

    if (!response.ok) {
      // Carry Central's own explanation (e.g. the 402 top-up message) rather
      // than reducing every failure to a status code.
      const detail = await response.text().catch(() => '');
      let reason = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(detail) as { message?: string };
        if (parsed.message) reason = parsed.message;
      } catch {
        if (detail.trim()) reason = detail.trim().slice(0, 200);
      }
      throw new Error(reason);
    }

    // settledByCentral: newer centrals settle tips server-side via RetroDeck
    // credits and say so; absent (older central) → the local x402 queue pays.
    const { results, settledByCentral, message } = (await response.json()) as {
      results: NetworkChunk[]; queryId: string; settledByCentral?: boolean; message?: string;
    };

    // Fetch chunk content from provider MCP endpoints where available
    const enriched = await Promise.allSettled(
      results.map(r => this.fetchChunkContent(r)),
    );

    const enrichedResults = enriched
      .map((r, i) => r.status === 'fulfilled' ? r.value : results[i])
      .filter(Boolean) as NetworkChunk[];
    return { results: enrichedResults, settledByCentral, message };
  }

  private async fetchChunkContent(chunk: NetworkChunk): Promise<NetworkChunk> {
    // Central already delivered the body — nothing to fetch.
    if (chunk.contentEncrypted ?? chunk.content) return chunk;
    // No peer endpoint to try: fall back to the summary rather than returning a
    // chunk with no body at all.
    if (!chunk.providerNodeMcpEndpoint) return { ...chunk, content: chunk.content ?? chunk.summary };
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
