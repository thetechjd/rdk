// packages/rdk-core/src/indexer.ts
// Orchestrates: clean → chunk → embed → categorize → local store → central sync

import crypto from 'crypto';
import { cleanText, estimateTokens } from './cleaner.js';
import { chunkText, type Chunk } from './chunker.js';
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
}

export interface IndexerConfig {
  embeddingModel: EmbeddingModel;
  localStore: LocalStore;
  domain: string;
  syncToNetwork?: boolean;
  centralApiUrl?: string;
  centralApiKey?: string;
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

          // 7. Store locally
          this.config.localStore.saveChunk({
            id: chunkId,
            title: this.buildTitle(doc.title, chunk),
            content: chunk.text,
            summary,
            domain,
            categories,
            isPublic: doc.isPublic ?? false,
            qualityScore: density * 100,
            sourcePath: doc.sourcePath,
            sourceAdapter: doc.sourceAdapter,
          }, embedding);

          chunksIndexed++;
        } catch (e) {
          errors.push(`Chunk ${chunk.index}: ${(e as Error).message}`);
        }
      }

      // 8. Sync public chunks to central if configured
      if ((doc.isPublic ?? false) && this.config.syncToNetwork && this.config.centralApiUrl && this.config.centralApiKey) {
        await this.syncTocentral();
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

  private async syncTocentral(): Promise<void> {
    const unsynced = this.config.localStore.getUnsyncedPublicChunks(100);
    if (unsynced.length === 0) return;

    const payload = unsynced.map(chunk => {
      const embedding = this.config.localStore.getEmbedding(chunk.id);
      return {
        chunkHash: chunk.id,
        title: chunk.title,
        summary: chunk.summary,
        domain: chunk.domain,
        categories: chunk.categories,
        embedding: embedding ? Array.from(embedding) : [],
        isPublic: chunk.isPublic,
        freshnessAt: new Date().toISOString(),
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
