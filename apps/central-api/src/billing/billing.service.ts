// apps/central-api/src/billing/billing.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe from 'stripe';
import { Node } from '../nodes/node.entity.js';

const STRIPE_PRICE_MAP: Record<string, string> = {
  // Populated from environment or Stripe dashboard
  // 'starter:monthly': 'price_xxxxx'
};

@Injectable()
export class BillingService {
  private stripe: Stripe;
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectRepository(Node)
    private nodeRepo: Repository<Node>,
  ) {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
      apiVersion: '2025-02-24.acacia',
    });
  }

  async createCheckoutSession(
    nodeId: string,
    planId: string,
    interval: 'monthly' | 'yearly',
  ): Promise<{ checkoutUrl: string }> {
    const node = await this.nodeRepo.findOneBy({ id: nodeId });
    if (!node) throw new Error('Node not found');

    // Ensure Stripe customer exists
    let customerId = node.stripeCustomerId;
    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email: node.ownerEmail,
        metadata: { nodeId },
      });
      customerId = customer.id;
      await this.nodeRepo.update(nodeId, { stripeCustomerId: customerId });
    }

    const priceKey = `${planId}:${interval}`;
    const priceId = STRIPE_PRICE_MAP[priceKey] ?? process.env[`STRIPE_PRICE_${planId.toUpperCase()}_${interval.toUpperCase()}`];

    if (!priceId) {
      throw new Error(`No Stripe price configured for ${priceKey}. Set STRIPE_PRICE_${planId.toUpperCase()}_${interval.toUpperCase()} env var.`);
    }

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.CENTRAL_API_URL ?? 'https://app.rdk.network'}/dashboard/billing?success=1`,
      cancel_url: `${process.env.CENTRAL_API_URL ?? 'https://app.rdk.network'}/dashboard/billing?canceled=1`,
      metadata: { nodeId, planId },
    });

    return { checkoutUrl: session.url! };
  }

  async createPortalSession(nodeId: string): Promise<{ portalUrl: string }> {
    const node = await this.nodeRepo.findOneBy({ id: nodeId });
    if (!node?.stripeCustomerId) throw new Error('No billing account found');

    const session = await this.stripe.billingPortal.sessions.create({
      customer: node.stripeCustomerId,
      return_url: `${process.env.CENTRAL_API_URL ?? 'https://app.rdk.network'}/dashboard/billing`,
    });

    return { portalUrl: session.url };
  }

  async handleStripeWebhook(sig: string, rawBody: Buffer): Promise<void> {
    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET ?? '',
      );
    } catch (e) {
      this.logger.error('Stripe webhook signature verification failed');
      throw e;
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const { nodeId, planId } = session.metadata ?? {};
        if (nodeId && planId) {
          await this.nodeRepo.update(nodeId, {
            plan: planId,
            planStatus: 'active',
            stripeSubscriptionId: session.subscription as string,
          });
          this.logger.log(`Node ${nodeId} upgraded to ${planId}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customer = invoice.customer as string;
        await this.nodeRepo.update({ stripeCustomerId: customer }, { planStatus: 'past_due' });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customer = sub.customer as string;
        await this.nodeRepo.update({ stripeCustomerId: customer }, { plan: 'free', planStatus: 'active' });
        break;
      }
    }
  }
}
