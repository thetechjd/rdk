// apps/central-api/src/common/cron.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NodesService } from '../nodes/nodes.service.js';
import { ChunksService } from '../chunks/chunks.service.js';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private nodesService: NodesService,
    private chunksService: ChunksService,
  ) {}

  /** Reset queries_today for all nodes at midnight UTC */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async resetDailyQueryCounts() {
    await this.nodesService.resetDailyQueryCounts();
    this.logger.log('Reset daily query counts for all nodes');
  }

  /** Nightly staleness decay — penalize chunks not retrieved in 30+ days */
  @Cron('0 1 * * *') // 1:00 AM UTC
  async applyStalenesDecay() {
    await this.chunksService.applyStalenesDecay();
    this.logger.log('Applied staleness decay to stale chunks');
  }
}
