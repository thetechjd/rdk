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
import type { IndexResult } from './adapters/interface.js';

export interface Document {
  content: string;
  title: string;
  sourcePath?: string;
  sourceAdapter?: string;
  domain?: string;
  categories?: string[];
  isPublic?: boolean;
  // Index for local search only — never sync to RDK Central. Used to save
  // knowledge retrieved from the network without re-uploading a duplicate.
  localOnly?: boolean;
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

          // 4. Embed locally
          const embedding = await this.config.embeddingModel.embed(chunk.text);

          // 5. Categorize
          const domain = doc.domain ?? this.config.domain;
          const categories = doc.categories ?? categorizeChunk(chunk.text, domain);
          allCategories.push(categories);

          // 6. Generate summary (LLM call — amortized index cost)
          let summary: string | undefined;
          if (this.llm) {
            try {
              summary = await this.llm.summarize(chunk.text, {
                instruction: 'Summarize this for a knowledge retrieval system. Include: main topic, key facts, intended use case. Be specific. Max 100 words.',
              });
            } catch (e) {
              // Non-fatal: continue without summary
            }
          }

          // 7. Store locally — encrypt content if private and vault key is configured
          const isPublic = doc.isPublic ?? false;
          const isEncrypted = !isPublic && !!this.config.vaultKey;
          const contentToStore = isEncrypted
            ? encrypt(chunk.text, this.config.vaultKey!)
            : chunk.text;

          const chunkTitle = this.buildTitle(doc.title, chunk);
          this.config.localStore.saveChunk({
            id: chunkId,
            title: chunkTitle,
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
    if (chunk.headings.length > 0) {
      const lastHeading = chunk.headings.filter(Boolean).pop();
      if (lastHeading) return `${docTitle} — ${lastHeading}`;
    }
    return docTitle;
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
        summary: chunk.isPublic ? chunk.summary : undefined,
        domain: chunk.domain,
        categories: chunk.categories,
        embedding: embedding ? Array.from(embedding) : [],
        isPublic: chunk.isPublic,
        isEncrypted: !chunk.isPublic,  // derived boolean (private ⟺ encrypted) — never a SQLite int
        freshnessAt: new Date().toISOString(),
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
      for (const chunk of unsynced) {
        this.config.localStore.markSynced(chunk.id);
      }
    }
  }
}
