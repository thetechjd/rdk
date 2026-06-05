// apps/central-api/src/query/query.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import crypto from 'crypto';
import type { NetworkQueryDto } from './query.controller.js';
import { calculateTip, computeFreshnessScore } from '../tips/tip-calculator.js';

interface QueryResultRow {
  chunk_id: string;
  node_id: string;
  mcp_endpoint: string;
  title: string;
  summary: string;
  score: number;
  quality_score: number;
  chunk_tokens: number;
  freshness_at: string;
  domain: string;
  categories: string[];
}

@Injectable()
export class QueryService {
  constructor(private dataSource: DataSource) {}

  async networkQuery(
    consumerNodeId: string,
    dto: NetworkQueryDto,
  ): Promise<{ results: unknown[]; queryId: string }> {
    if (!dto.embedding || dto.embedding.length !== 384) {
      return { results: [], queryId: '' };
    }

    const topK = dto.topK ?? 5;
    const vectorLiteral = `[${dto.embedding.join(',')}]`;

    // pgvector cosine distance (<=> operator), lower = more similar
    let sql = `
      SELECT
        c.id                   AS chunk_id,
        c.node_id,
        n.mcp_endpoint         AS provider_node_mcp_endpoint,
        c.title,
        c.summary,
        (1 - (c.embedding <=> $1::vector)) AS score,
        c.quality_score,
        COALESCE(c.chunk_tokens, 256) AS chunk_tokens,
        c.freshness_at,
        c.domain,
        c.categories
      FROM chunks c
      JOIN nodes n ON n.id = c.node_id
      WHERE c.is_public = true
        AND n.is_active = true
        AND c.embedding IS NOT NULL
    `;

    const params: unknown[] = [vectorLiteral];
    let paramIdx = 2;

    if (dto.domain) {
      sql += ` AND c.domain = $${paramIdx}`;
      params.push(dto.domain);
      paramIdx++;
    }

    if (dto.excludeNodeId) {
      sql += ` AND c.node_id != $${paramIdx}`;
      params.push(dto.excludeNodeId);
      paramIdx++;
    }

    sql += `
      ORDER BY c.embedding <=> $1::vector
      LIMIT $${paramIdx}
    `;
    params.push(topK);

    const rows = await this.dataSource.query(sql, params) as QueryResultRow[];

    // Log query for analytics + quality scoring
    const queryId = crypto.randomUUID();
    await this.logQuery(consumerNodeId, dto.embedding, rows[0]?.chunk_id, !!rows.length, queryId);

    const results = rows.map((r, index) => {
      const freshnessScore = computeFreshnessScore(new Date(r.freshness_at));
      const tipResult = calculateTip({
        cosineSimilarity: parseFloat(String(r.score)),
        qualityScore: parseFloat(String(r.quality_score)),
        chunkTokens: r.chunk_tokens ?? 256,
        rankPosition: index + 1,
        freshnessScore,
      });

      return {
        chunkId: r.chunk_id,
        nodeId: r.node_id,
        providerNodeMcpEndpoint: r.mcp_endpoint,
        title: r.title,
        summary: r.summary,
        score: parseFloat(String(r.score)),
        tipAmountUsdc: tipResult.amountUsdc,
        domain: r.domain,
        categories: r.categories,
      };
    });

    return { results, queryId };
  }

  private async logQuery(
    consumerNodeId: string,
    embedding: number[],
    matchedChunkId: string | undefined,
    matched: boolean,
    queryId: string,
  ): Promise<void> {
    const vectorLiteral = `[${embedding.join(',')}]`;
    await this.dataSource.query(`
      INSERT INTO query_log (id, consumer_node_id, query_embedding, matched_chunk_id, matched, latency_ms)
      VALUES ($1, $2, $3::vector, $4, $5, $6)
    `, [queryId, consumerNodeId, vectorLiteral, matchedChunkId ?? null, matched, 0]);
  }
}
