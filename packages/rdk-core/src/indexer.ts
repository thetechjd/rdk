// packages/rdk-core/src/indexer.ts
// Orchestrates: clean → chunk → embed → categorize → local store → sync to RDK Central
// Private chunks are encrypted before sync; public chunks sync as plaintext.

import crypto from 'crypto';
import { cleanText, estimateTokens } from './cleaner.js';
import { chunkText, type Chunk } from './chunker.js';
import { encrypt, type VaultKey } from './crypto.js';
import { type EmbeddingModel } from './models/embedding.js';
import { LocalStore } from './store/local-store.js';
import { categorizeChunk, scoreInformationDensity } from './taxonomy.js';
import { extractiveSummary } from './summarize.js';
import { buildChunkTitle, extractDocTitle } from './title.js';
import type { IndexResult } from './adapters/interface.js';

export interface Document {
  content: string;
  title: string;
  /** What the document calls itself — frontmatter `title:` or its H1 — as
   *  opposed to `title`, which is often just the file stem. When omitted the
   *  indexer derives it from the content. Kept as its own field so consumers
   *  stop recovering it by splitting the composite chunk title on ' — '. */
  docTitle?: string;
  sourcePath?: string;
  sourceAdapter?: string;
  domain?: string;
  categories?: string[];
  isPublic?: boolean;
  // Index for local search only — never sync to RDK Central. Used to save
  // knowledge retrieved from the network without re-uploading a duplicate.
  localOnly?: boolean;
  // ── Version context (edit → re-index) ────────────────────────────────────
  /** Chunk id (content hash) of a prior version this document replaces. */
  supersedes?: string;
  /** 1-based version number for the new chunks (series counter). */
  version?: number;
  /** Chunk id of the published chunk this content was retrieved from, when it
   *  originated on another node. Carried onto every chunk so an edit — which
   *  mints new hashes and makes the work genuinely the editor's — still records
   *  who seeded it. See StoredChunk.derivedFrom. */
  derivedFrom?: string;
}

export interface IndexerConfig {
  embeddingModel: EmbeddingModel;
  localStore: LocalStore;
  domain: string;
  syncToNetwork?: boolean;
  centralApiUrl?: string;
  centralApiKey?: string;
  vaultKey?: VaultKey;
  // Called immediately after each chunk is stored locally, before network sync.
  // Used by rdk-cli to push real-time WebSocket events to RDK Central.
  onChunkIndexed?: (chunk: { id: string; title: string; isPublic: boolean }) => void;
}

export type { IndexResult };

export interface LLMSummarizer {
  summarize(text: string, opts: { instruction: string }): Promise<string>;
}

export class RDKIndexer {
  constructor(
    private config: IndexerConfig,
    private llm?: LLMSummarizer,
  ) {}

  async indexDocument(doc: Document): Promise<IndexResult> {
    const errors: string[] = [];
    const allCategories: string[][] = [];
    let chunksIndexed = 0;
    let chunksSkipped = 0;

    try {
      // 0. Settle on what this document is called. Derived from the ORIGINAL
      // content (frontmatter/H1 survive cleaning, but this is where they mean
      // something), falling back to whatever the caller passed as `title` —
      // usually the file stem.
      const docTitle = doc.docTitle?.trim() || extractDocTitle(doc.content, doc.title);

      // 1. Clean
      const cleaned = cleanText(doc.content);
      if (cleaned.length < 50) {
        return { chunksIndexed: 0, chunksSkipped: 1, filesProcessed: 0, categories: [], errors: ['Document too short after cleaning'] };
      }

      // 2. Chunk
      const chunks = chunkText(cleaned, { strategy: 'semantic', maxChunkTokens: 512, overlapTokens: 64 });

      // 3. Process each chunk
      for (const chunk of chunks) {
        try {
          const chunkId = crypto.createHash('sha256').update(chunk.text).digest('hex');

          // Pre-score: skip low-density chunks
          const density = scoreInformationDensity(chunk.text);
          if (density < 0.15 && chunk.tokenEstimate < 20) {
            chunksSkipped++;
            continue;
          }

          // 4. Embed locally.
          // Prepend the document title + heading context to the embedded text
          // so a query that matches the title/topic scores high. The title is
          // the strongest relevance signal; embedding the body alone made an
          // exact title-match query ("Forward Deployed Engineer") score low
          // against a long article. The stored content (below) is unchanged —
          // only the vector incorporates the title.
          const chunkTitle = this.buildTitle(docTitle, chunk);
          const embedText = `${chunkTitle}\n\n${chunk.text}`;
          const embedding = await this.config.embeddingModel.embed(embedText);

          // 5. Categorize
          const domain = doc.domain ?? this.config.domain;
          const categories = doc.categories ?? categorizeChunk(chunk.text, domain);
          allCategories.push(categories);

          // 6. Generate summary (LLM call — amortized index cost).
          // Always end up with SOMETHING: for public chunks the summary is the
          // only part Central may hold, so it is what answers a query when this
          // node is offline. An LLM-less indexer used to leave it null, which
          // left offline content with no fallback at all.
          let summary: string | undefined;
          if (this.llm) {
            try {
              summary = await this.llm.summarize(chunk.text, {
                instruction: 'Summarize this for a knowledge retrieval system. Include: main topic, key facts, intended use case. Be specific. Max 100 words.',
              });
            } catch (e) {
              // Non-fatal: fall through to the extractive summary
            }
          }
          if (!summary?.trim()) {
            summary = extractiveSummary(chunk.text, { headings: chunk.headings }) || undefined;
          }

          // 7. Store locally — encrypt content if private and vault key is configured
          const isPublic = doc.isPublic ?? false;
          const isEncrypted = !isPublic && !!this.config.vaultKey;
          const contentToStore = isEncrypted
            ? encrypt(chunk.text, this.config.vaultKey!)
            : chunk.text;

          this.config.localStore.saveChunk({
            id: chunkId,
            title: chunkTitle,
            docTitle,
            content: contentToStore,
            summary,
            domain,
            categories,
            isPublic,
            isEncrypted,
            isLocalOnly: doc.localOnly ?? false,
            qualityScore: density * 100,
            sourcePath: doc.sourcePath,
            sourceAdapter: doc.sourceAdapter,
            supersedes: doc.supersedes,
            version: doc.version ?? 1,
            derivedFrom: doc.derivedFrom,
          }, embedding);

          this.config.onChunkIndexed?.({ id: chunkId, title: chunkTitle, isPublic });
          chunksIndexed++;
        } catch (e) {
          errors.push(`Chunk ${chunk.index}: ${(e as Error).message}`);
        }
      }

      // 8. Sync indexed chunks to RDK Central — embeddings + metadata ONLY.
      //    Content (public plaintext or private ciphertext) stays on this node and
      //    is served to Central on demand via the fetch_content handler.
      if (!doc.localOnly && this.config.syncToNetwork && this.config.centralApiUrl && this.config.centralApiKey) {
        await this.syncTocentral(doc.isPublic ?? false);
      }
    } catch (e) {
      errors.push(`Fatal: ${(e as Error).message}`);
    }

    return { chunksIndexed, chunksSkipped, filesProcessed: chunksIndexed, categories: allCategories, errors };
  }

  async indexBatch(docs: Document[]): Promise<{ total: IndexResult; perDoc: IndexResult[] }> {
    const perDoc: IndexResult[] = [];
    const total: IndexResult = { chunksIndexed: 0, chunksSkipped: 0, filesProcessed: 0, categories: [], errors: [] };

    for (const doc of docs) {
      const result = await this.indexDocument(doc);
      perDoc.push(result);
      total.chunksIndexed += result.chunksIndexed;
      total.chunksSkipped += result.chunksSkipped;
      total.categories.push(...result.categories);
      total.errors.push(...result.errors);
    }

    return { total, perDoc };
  }

  private buildTitle(docTitle: string, chunk: Chunk): string {
    return buildChunkTitle(docTitle, chunk.headings);
  }

  private async syncTocentral(isPublicDoc: boolean): Promise<void> {
    const unsynced = isPublicDoc
      ? this.config.localStore.getUnsyncedPublicChunks(100)
      : this.config.localStore.getUnsyncedEncryptedChunks(100);

    if (unsynced.length === 0) return;

    const payload = unsynced.map(chunk => {
      const embedding = this.config.localStore.getEmbedding(chunk.id);
      return {
        chunkHash: chunk.id,
        // Title syncs for BOTH public and private — private chunks need a routable
        // title in Central for team/cross-node search + the dashboard. Summary
        // stays on the node for private chunks (it's a content-derived gist).
        title: chunk.title,
        // Document-level title, so Central's Files view can name a document
        // without picking an arbitrary chunk title out of the group.
        docTitle: chunk.docTitle,
        summary: chunk.isPublic ? chunk.summary : undefined,
        domain: chunk.domain,
        categories: chunk.categories,
        embedding: embedding ? Array.from(embedding) : [],
        isPublic: chunk.isPublic,
        isEncrypted: !chunk.isPublic,  // derived boolean (private ⟺ encrypted) — never a SQLite int
        freshnessAt: new Date().toISOString(),
        // Version-series metadata (old centrals ignore unknown fields).
        sourcePath: chunk.sourcePath,
        sourceAdapter: chunk.sourceAdapter,
        supersedesHash: chunk.supersedes,
        version: chunk.version ?? 1,
        // NO content field — content is served on demand, never synced.
      };
    }).filter(c => c.embedding.length > 0);

    if (payload.length === 0) return;

    const response = await fetch(`${this.config.centralApiUrl}/api/v1/chunks/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.centralApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chunks: payload }),
    });

    if (response.ok) {
      // Mark synced ONLY the chunks central actually persisted. A 200 can still
      // skip chunks (plan limit, bad embedding); the rest stay pending and
      // re-push on the next sync instead of being falsely flagged synced.
      const result = await response.json().catch(() => ({})) as
        { acceptedHashes?: string[]; errors?: string[] };
      const accepted = Array.isArray(result.acceptedHashes)
        ? new Set(result.acceptedHashes)
        : new Set(
            unsynced
              .map(c => c.id)
              .filter(id => !(result.errors ?? []).some(e => e.split(':')[0]?.trim() === id)),
          );
      for (const chunk of unsynced) {
        if (accepted.has(chunk.id)) this.config.localStore.markSynced(chunk.id);
      }
    }
  }
}
