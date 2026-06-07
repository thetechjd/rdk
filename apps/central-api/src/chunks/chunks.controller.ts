// apps/central-api/src/chunks/chunks.controller.ts
import {
  Controller, Post, Delete, Get, Body, Param, UseGuards, Request,
} from '@nestjs/common';
import {
  IsString, IsOptional, IsArray, IsBoolean, IsNumber, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ChunksService } from './chunks.service.js';
import { NodesService } from '../nodes/nodes.service.js';

export class SyncChunkDto {
  @IsString()
  chunkHash!: string;

  @IsOptional() @IsString()
  title?: string;

  @IsOptional() @IsString()
  summary?: string;

  @IsOptional() @IsString()
  domain?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  categories?: string[];

  @IsArray() @IsNumber({}, { each: true })
  embedding!: number[];

  @IsOptional() @IsNumber()
  chunkTokens?: number;

  @IsOptional() @IsBoolean()
  isPublic?: boolean;

  @IsOptional() @IsString()
  freshnessAt?: string;
}

export class SyncChunksDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncChunkDto)
  chunks!: SyncChunkDto[];
}

@Controller('api/v1/chunks')
@UseGuards(JwtAuthGuard)
export class ChunksController {
  constructor(
    private chunksService: ChunksService,
    private nodesService: NodesService,
  ) {}

  @Post('sync')
  async syncChunks(
    @Request() req: { user: { id: string } },
    @Body() body: SyncChunksDto,
  ) {
    // Check plan limit before accepting sync
    await this.nodesService.checkPlanLimit(req.user.id, 'sync_chunk');
    return this.chunksService.syncChunks(req.user.id, body.chunks);
  }

  @Post('sync/batch')
  async syncBatch(
    @Request() req: { user: { id: string } },
    @Body() body: SyncChunksDto,
  ) {
    await this.nodesService.checkPlanLimit(req.user.id, 'sync_chunk');
    return this.chunksService.queueBatchSync(req.user.id, body.chunks);
  }

  @Get('sync/job/:jobId')
  async getJobStatus(@Param('jobId') jobId: string) {
    return this.chunksService.getJobStatus(jobId);
  }

  @Delete(':chunkHash')
  async deleteChunk(
    @Request() req: { user: { id: string } },
    @Param('chunkHash') chunkHash: string,
  ) {
    return this.chunksService.deleteChunk(req.user.id, chunkHash);
  }
}
