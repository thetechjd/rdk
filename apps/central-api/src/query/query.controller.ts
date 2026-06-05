// apps/central-api/src/query/query.controller.ts
import { Controller, Post, Body, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { QueryService } from './query.service.js';
import { NodesService } from '../nodes/nodes.service.js';

export class NetworkQueryDto {
  embedding!: number[];
  domain?: string;
  topK?: number;
  excludeNodeId?: string;
}

@Controller('api/v1/query')
@UseGuards(JwtAuthGuard)
export class QueryController {
  constructor(
    private queryService: QueryService,
    private nodesService: NodesService,
  ) {}

  @Post()
  async query(
    @Request() req: { user: { id: string } },
    @Body() body: NetworkQueryDto,
  ) {
    await this.nodesService.checkPlanLimit(req.user.id, 'query_network');
    const result = await this.queryService.networkQuery(req.user.id, body);
    await this.nodesService.incrementQueryCount(req.user.id);
    return result;
  }
}
