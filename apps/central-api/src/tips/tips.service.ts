// apps/central-api/src/tips/tips.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import crypto from 'crypto';
import type { RecordTipDto } from './tips.controller.js';

@Injectable()
export class TipsService {
  constructor(private dataSource: DataSource) {}

  async recordTip(consumerNodeId: string, dto: RecordTipDto) {
    // Look up provider node from the chunk
    const chunkRow = await this.dataSource.query(
      `SELECT node_id FROM chunks WHERE id = $1`,
      [dto.chunkId],
    ) as { node_id: string }[];

    if (!chunkRow.length) {
      return { error: 'Chunk not found' };
    }

    const providerNodeId = chunkRow[0].node_id;
    const tipId = crypto.randomUUID();

    await this.dataSource.query(`
      INSERT INTO tips (id, chunk_id, consumer_node_id, provider_node_id, amount_usdc, chain, tx_hash, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'settled')
    `, [tipId, dto.chunkId, consumerNodeId, providerNodeId, dto.amountUsdc, dto.chain, dto.txHash]);

    // Update chunk quality score — tip settled is the strongest signal
    await this.dataSource.query(`
      UPDATE chunks
      SET quality_score = LEAST(100, quality_score + 5.0)
      WHERE id = $1
    `, [dto.chunkId]);

    return { tipId, providerNodeId, status: 'settled' };
  }

  async getEarnings(nodeId: string) {
    const rows = await this.dataSource.query(`
      SELECT
        COALESCE(SUM(amount_usdc), 0)                                           AS total_usdc,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_usdc END), 0)     AS pending_usdc,
        COALESCE(SUM(CASE WHEN status = 'settled' THEN amount_usdc END), 0)     AS settled_usdc
      FROM tips
      WHERE provider_node_id = $1
    `, [nodeId]) as { total_usdc: string; pending_usdc: string; settled_usdc: string }[];

    const history = await this.dataSource.query(`
      SELECT id, chunk_id, consumer_node_id, amount_usdc, chain, tx_hash, status, created_at
      FROM tips
      WHERE provider_node_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [nodeId]);

    return {
      totalUsdc: parseFloat(rows[0].total_usdc),
      pendingUsdc: parseFloat(rows[0].pending_usdc),
      settledUsdc: parseFloat(rows[0].settled_usdc),
      tipHistory: history,
    };
  }

  async getSpent(nodeId: string) {
    const rows = await this.dataSource.query(`
      SELECT COALESCE(SUM(amount_usdc), 0) AS total_usdc
      FROM tips WHERE consumer_node_id = $1
    `, [nodeId]) as { total_usdc: string }[];

    const history = await this.dataSource.query(`
      SELECT id, chunk_id, provider_node_id, amount_usdc, chain, tx_hash, status, created_at
      FROM tips WHERE consumer_node_id = $1
      ORDER BY created_at DESC LIMIT 50
    `, [nodeId]);

    return { totalUsdc: parseFloat(rows[0].total_usdc), history };
  }
}
