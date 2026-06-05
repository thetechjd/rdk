// apps/central-api/src/health.controller.ts
import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', service: 'rdk-central', version: '1.0.0', timestamp: new Date().toISOString() };
  }
}
