// apps/central-api/src/chunks/chunks.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Chunk } from './chunk.entity.js';
import { NodesService } from '../nodes/nodes.service.js';
import type { SyncChunkDto } from './chunks.controller.js';

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: string[];
}

@Injectable()
export class ChunksService {
  constructor(
    @InjectRepository(Chunk)
    private chunkRepo: Repository<Chunk>,
    private nodesService: NodesService,
    private dataSource: DataSource,
  ) {}

  async syncChunks(nodeId: string, chunks: SyncChunkDto[]): Promise<SyncResult> {
    let synced = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const chunk of chunks) {
      try {
        await this.upsertChunk(nodeId, chunk);
        synced++;
      } catch (e) {
        errors.push(`${chunk.chunkHash}: ${(e as Error).message}`);
        skipped++;
      }
    }

    // Update chunk count on node
    if (synced > 0) {
      await this.nodesService.incrementChunkCount(nodeId, synced);
    }

    return { synced, skipped, errors };
  }

  private async upsertChunk(nodeId: string, dto: SyncChunkDto): Promise<void> {
    if (!dto.embedding || dto.embedding.length !== 384) {
      throw new Error('embedding must be float32[384]');
    }

    const vectorLiteral = `[${dto.embedding.join(',')}]`;

    // Use raw query for pgvector INSERT — TypeORM doesn't handle vector type
    await this.dataSource.query(`
      INSERT INTO chunks (node_id, chunk_hash, title, summary, domain, categories, embedding, is_public, freshness_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9)
      ON CONFLICT (chunk_hash) DO UPDATE SET
        title       = EXCLUDED.title,
        summary     = EXCLUDED.summary,
        domain      = EXCLUDED.domain,
        categories  = EXCLUDED.categories,
        embedding   = EXCLUDED.embedding,
        is_public   = EXCLUDED.is_public,
        freshness_at = EXCLUDED.freshness_at
    `, [
      nodeId,
      dto.chunkHash,
      dto.title ?? null,
      dto.summary ?? null,
      dto.domain ?? null,
      dto.categories ?? null,
      vectorLiteral,
      dto.isPublic ?? true,
      dto.freshnessAt ? new Date(dto.freshnessAt) : new Date(),
    ]);
  }

  async deleteChunk(nodeId: string, chunkHash: string): Promise<void> {
    await this.chunkRepo.delete({ nodeId, chunkHash });
    await this.nodesService.incrementChunkCount(nodeId, -1);
  }

  async queueBatchSync(nodeId: string, chunks: SyncChunkDto[]): Promise<{ jobId: string }> {
    // In production this would go to BullMQ — for now process inline
    // TODO: wire to BullMQ queue
    const jobId = `job_${Date.now()}_${nodeId.slice(0, 8)}`;
    setImmediate(() => this.syncChunks(nodeId, chunks));
    return { jobId };
  }

  async getJobStatus(jobId: string) {
    // TODO: implement BullMQ job status lookup
    return { jobId, status: 'completed', progress: 100, synced: 0, errors: [] };
  }

  /** Update quality score based on retrieval events */
  async updateQualityScore(chunkId: string, event: 'retrieved' | 'engaged' | 'fresh' | 'tip_settled' | 'llm_fallback' | 'stale'): Promise<void> {
    const deltas: Record<string, number> = {
      retrieved:    2.0,
      engaged:      3.0,
      fresh:        1.0,
      tip_settled:  5.0,
      llm_fallback: -1.0,
      stale:        -0.5,
    };

    const delta = deltas[event] ?? 0;
    if (delta === 0) return;

    await this.dataSource.query(`
      UPDATE chunks
      SET quality_score = GREATEST(0, LEAST(100, quality_score + $1)),
          retrieval_count = CASE WHEN $2 = 'retrieved' THEN retrieval_count + 1 ELSE retrieval_count END,
          last_retrieved  = CASE WHEN $2 IN ('retrieved', 'engaged') THEN NOW() ELSE last_retrieved END
      WHERE id = $3
    `, [delta, event, chunkId]);
  }

  /** Nightly staleness decay — run via cron */
  async applyStalenesDecay(): Promise<void> {
    // Chunks not retrieved in 30+ days get quality_score decay
    await this.dataSource.query(`
      UPDATE chunks
      SET quality_score = GREATEST(0, quality_score - 0.5)
      WHERE is_public = true
        AND (last_retrieved IS NULL OR last_retrieved < NOW() - INTERVAL '30 days')
        AND quality_score > 0
    `);
  }
}
