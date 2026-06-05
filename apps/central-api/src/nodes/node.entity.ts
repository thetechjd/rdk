// apps/central-api/src/nodes/node.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';

@Entity('nodes')
export class Node {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'api_key_hash', unique: true })
  apiKeyHash!: string;

  @Column({ name: 'owner_email' })
  ownerEmail!: string;

  @Column({ name: 'display_name' })
  displayName!: string;

  @Column({ nullable: true })
  domain?: string;

  @Column({ name: 'mcp_endpoint', nullable: true })
  mcpEndpoint?: string;

  @Column({ name: 'wallet_address', nullable: true })
  walletAddress?: string;

  @Column({ name: 'wallet_chain', default: 'base' })
  walletChain!: string;

  @Column({ default: 'free' })
  plan!: string;

  @Column({ name: 'plan_status', default: 'active' })
  planStatus!: string;

  @Column({ name: 'stripe_customer_id', nullable: true })
  stripeCustomerId?: string;

  @Column({ name: 'stripe_subscription_id', nullable: true })
  stripeSubscriptionId?: string;

  @Column({ name: 'stripe_meter_id', nullable: true })
  stripeMiterId?: string;

  @Column({ name: 'parent_node_id', nullable: true })
  parentNodeId?: string;

  @Column({ name: 'team_seat_count', default: 0 })
  teamSeatCount!: number;

  @Column({ name: 'chunk_count', default: 0 })
  chunkCount!: number;

  @Column({ name: 'queries_today', default: 0 })
  queriesToday!: number;

  @Column({ name: 'overage_chunks_this_month', default: 0 })
  overageChunksThisMonth!: number;

  @Column({ name: 'overage_queries_this_month', default: 0 })
  overageQueriesThisMonth!: number;

  @Column({ name: 'contribution_domain', nullable: true })
  contributionDomain?: string;

  @Column({ name: 'node_role', default: 'both' })
  nodeRole!: string; // contributor | consumer | both

  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ name: 'last_seen', type: 'timestamptz', nullable: true })
  lastSeen?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
