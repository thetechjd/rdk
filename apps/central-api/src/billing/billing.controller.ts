// apps/central-api/src/billing/billing.controller.ts
import {
  Controller, Post, Body, Headers, RawBodyRequest,
  UseGuards, Request, Req,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { BillingService } from './billing.service.js';

@Controller('api/v1/billing')
export class BillingController {
  constructor(private billingService: BillingService) {}

  @UseGuards(JwtAuthGuard)
  @Post('checkout')
  async createCheckout(
    @Request() req: { user: { id: string } },
    @Body() body: { planId: string; interval: 'monthly' | 'yearly' },
  ) {
    return this.billingService.createCheckoutSession(req.user.id, body.planId, body.interval);
  }

  @UseGuards(JwtAuthGuard)
  @Post('portal')
  async createPortal(@Request() req: { user: { id: string } }) {
    return this.billingService.createPortalSession(req.user.id);
  }

  /** Stripe webhook — no JWT, verified by Stripe signature */
  @Post('webhook')
  async handleWebhook(
    @Headers('stripe-signature') sig: string,
    @Req() req: RawBodyRequest<ExpressRequest>,
  ) {
    return this.billingService.handleStripeWebhook(sig, req.rawBody as Buffer);
  }
}
