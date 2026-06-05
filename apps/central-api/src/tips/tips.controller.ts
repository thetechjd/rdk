// apps/central-api/src/tips/tips.controller.ts
import { Controller, Post, Get, Body, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { TipsService } from './tips.service.js';

export class RecordTipDto {
  queryId!: string;
  chunkId!: string;
  txHash!: string;
  amountUsdc!: number;
  chain!: string;
}

@Controller('api/v1/tips')
@UseGuards(JwtAuthGuard)
export class TipsController {
  constructor(private tipsService: TipsService) {}

  @Post('record')
  async recordTip(
    @Request() req: { user: { id: string } },
    @Body() body: RecordTipDto,
  ) {
    return this.tipsService.recordTip(req.user.id, body);
  }

  @Get('earnings')
  async getEarnings(@Request() req: { user: { id: string } }) {
    return this.tipsService.getEarnings(req.user.id);
  }

  @Get('spent')
  async getSpent(@Request() req: { user: { id: string } }) {
    return this.tipsService.getSpent(req.user.id);
  }
}
