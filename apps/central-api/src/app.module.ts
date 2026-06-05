// apps/central-api/src/app.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ScheduleModule } from '@nestjs/schedule';

import { Node } from './nodes/node.entity.js';
import { Chunk } from './chunks/chunk.entity.js';

import { NodesController } from './nodes/nodes.controller.js';
import { NodesService } from './nodes/nodes.service.js';
import { ChunksController } from './chunks/chunks.controller.js';
import { ChunksService } from './chunks/chunks.service.js';
import { QueryController } from './query/query.controller.js';
import { QueryService } from './query/query.service.js';
import { TipsController } from './tips/tips.controller.js';
import { TipsService } from './tips/tips.service.js';
import { BillingController } from './billing/billing.controller.js';
import { BillingService } from './billing/billing.service.js';
import { JwtStrategy } from './auth/jwt.strategy.js';
import { CronService } from './common/cron.service.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
      signOptions: { expiresIn: '24h' },
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [Node, Chunk],
      synchronize: false, // use migrations
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    }),
    TypeOrmModule.forFeature([Node, Chunk]),
  ],
  controllers: [
    HealthController,
    NodesController,
    ChunksController,
    QueryController,
    TipsController,
    BillingController,
  ],
  providers: [
    NodesService,
    ChunksService,
    QueryService,
    TipsService,
    BillingService,
    JwtStrategy,
    CronService,
  ],
})
export class AppModule {}
