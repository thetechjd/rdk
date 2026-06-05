// apps/central-api/src/nodes/nodes.service.ts
import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Node } from './node.entity.js';

export const PLANS: Record<string, {
  maxChunks: number;
  maxQueriesDay: number;
  maxTeamNodes: number;
  canContribute: boolean;
  canConsume: boolean;
  hasOverage: boolean;
}> = {
  free:       { maxChunks: 1000,    maxQueriesDay: 100,   maxTeamNodes: 0, canContribute: false, canConsume: true,  hasOverage: false },
  starter:    { maxChunks: 10000,   maxQueriesDay: 1000,  maxTeamNodes: 0, canContribute: true,  canConsume: true,  hasOverage: false },
  pro:        { maxChunks: 100000,  maxQueriesDay: 10000, maxTeamNodes: 0, canContribute: true,  canConsume: true,  hasOverage: false },
  enterprise: { maxChunks: 1000000, maxQueriesDay: 50000, maxTeamNodes: 9, canContribute: true,  canConsume: true,  hasOverage: true  },
};

@Injectable()
export class NodesService {
  constructor(
    @InjectRepository(Node)
    private nodeRepo: Repository<Node>,
    private jwtService: JwtService,
  ) {}

  async register(data: {
    email: string;
    displayName: string;
    contributionDomain?: string;
    nodeRole?: string;
    walletAddress?: string;
    walletChain?: string;
  }): Promise<{ nodeId: string; apiKey: string }> {
    // Generate API key (shown ONCE, then only hash stored)
    const apiKey = `rdk_live_${crypto.randomBytes(24).toString('hex')}`;
    const apiKeyHash = await bcrypt.hash(apiKey, 10);

    const node = this.nodeRepo.create({
      apiKeyHash,
      ownerEmail: data.email,
      displayName: data.displayName,
      contributionDomain: data.contributionDomain,
      nodeRole: data.nodeRole ?? 'both',
      walletAddress: data.walletAddress,
      walletChain: data.walletChain ?? 'base',
      plan: 'free',
    });

    await this.nodeRepo.save(node);

    return { nodeId: node.id, apiKey };
  }

  async authenticateApiKey(apiKey: string): Promise<{ nodeId: string; plan: string; planStatus: string; jwtToken: string }> {
    if (!apiKey?.startsWith('rdk_')) {
      throw new UnauthorizedException('Invalid API key format');
    }

    // Must check all active nodes — bcrypt.compare is per-record
    // Optimization: store first 8 chars as lookup prefix to avoid full table scan
    const prefix = apiKey.slice(0, 12);
    const nodes = await this.nodeRepo.find({ where: { isActive: true } });

    for (const node of nodes) {
      const match = await bcrypt.compare(apiKey, node.apiKeyHash);
      if (match) {
        // Update last_seen
        await this.nodeRepo.update(node.id, { lastSeen: new Date() });

        const jwtToken = this.jwtService.sign({ sub: node.id, plan: node.plan });
        return { nodeId: node.id, plan: node.plan, planStatus: node.planStatus, jwtToken };
      }
    }

    throw new UnauthorizedException('Invalid API key');
  }

  async getNodeProfile(nodeId: string) {
    const node = await this.nodeRepo.findOneBy({ id: nodeId });
    if (!node) throw new UnauthorizedException();

    const plan = PLANS[node.plan];
    return {
      nodeId: node.id,
      displayName: node.displayName,
      ownerEmail: node.ownerEmail,
      domain: node.domain,
      mcpEndpoint: node.mcpEndpoint,
      walletAddress: node.walletAddress,
      walletChain: node.walletChain,
      contributionDomain: node.contributionDomain,
      nodeRole: node.nodeRole,
      plan: node.plan,
      planStatus: node.planStatus,
      stats: {
        chunkCount: node.chunkCount,
        queriesToday: node.queriesToday,
        chunkLimit: plan?.maxChunks,
        queryLimit: plan?.maxQueriesDay,
      },
      lastSeen: node.lastSeen,
      createdAt: node.createdAt,
    };
  }

  async updateNode(nodeId: string, data: Partial<Node>) {
    await this.nodeRepo.update(nodeId, data);
    return this.getNodeProfile(nodeId);
  }

  async listPublicNodes(domain?: string, limit = 20, offset = 0) {
    const qb = this.nodeRepo.createQueryBuilder('n')
      .where('n.is_active = true')
      .andWhere('n.mcp_endpoint IS NOT NULL')
      .select(['n.id', 'n.display_name', 'n.domain', 'n.mcp_endpoint', 'n.contribution_domain'])
      .limit(limit)
      .offset(offset);

    if (domain) qb.andWhere('n.contribution_domain = :domain', { domain });

    const nodes = await qb.getMany();
    return { nodes, total: nodes.length, offset, limit };
  }

  async checkPlanLimit(nodeId: string, operation: 'sync_chunk' | 'query_network' | 'contribute'): Promise<{ allowed: boolean; overage: boolean }> {
    const node = await this.nodeRepo.findOneBy({ id: nodeId });
    if (!node) return { allowed: false, overage: false };

    const plan = PLANS[node.plan];
    if (!plan) return { allowed: false, overage: false };

    if (operation === 'sync_chunk') {
      if (node.chunkCount >= plan.maxChunks) {
        if (plan.hasOverage) return { allowed: true, overage: true };
        throw Object.assign(new Error('Chunk limit reached'), { statusCode: 429, upgradeRequired: true });
      }
    }

    if (operation === 'query_network') {
      if (!plan.canConsume) throw Object.assign(new Error('Network queries require Starter plan'), { statusCode: 403 });
      if (node.queriesToday >= plan.maxQueriesDay) {
        if (plan.hasOverage) return { allowed: true, overage: true };
        throw Object.assign(new Error('Daily query limit reached. Resets midnight UTC.'), { statusCode: 429 });
      }
    }

    if (operation === 'contribute') {
      if (!plan.canContribute) throw Object.assign(new Error('Contributing requires Starter plan'), { statusCode: 403 });
    }

    return { allowed: true, overage: false };
  }

  async incrementChunkCount(nodeId: string, delta = 1) {
    await this.nodeRepo.increment({ id: nodeId }, 'chunkCount', delta);
  }

  async incrementQueryCount(nodeId: string) {
    await this.nodeRepo.increment({ id: nodeId }, 'queriesToday', 1);
  }

  /** Called by nightly cron — reset queries_today for all nodes */
  async resetDailyQueryCounts() {
    await this.nodeRepo.update({}, { queriesToday: 0 });
  }
}
