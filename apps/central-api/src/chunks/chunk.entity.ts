// apps/central-api/src/chunks/chunk.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Node } from '../nodes/node.entity.js';

@Entity('chunks')
@Index(['domain', 'isPublic', 'qualityScore'])
export class Chunk {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'node_id' })
  nodeId!: string;

  @ManyToOne(() => Node, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'node_id' })
  node!: Node;

  @Column({ name: 'chunk_hash', unique: true })
  chunkHash!: string; // SHA256 of content — dedup key

  @Column({ nullable: true })
  title?: string;

  @Column({ nullable: true, type: 'text' })
  summary?: string;

  @Column({ nullable: true })
  domain?: string;

  @Column({ type: 'text', array: true, nullable: true })
  categories?: string[];

  @Column({ name: 'quality_score', type: 'decimal', precision: 4, scale: 2, default: 0 })
  qualityScore!: number;

  @Column({ name: 'retrieval_count', default: 0 })
  retrievalCount!: number;

  @Column({ name: 'last_retrieved', type: 'timestamptz', nullable: true })
  lastRetrieved?: Date;

  // Stored as raw float array via pgvector — column name 'embedding vector(384)'
  // TypeORM doesn't natively support vector type; use a raw column
  @Column({ type: 'text', nullable: true, select: false })
  embeddingRaw?: string; // JSON-serialized float32 array for pgvector INSERT

  @Column({ name: 'is_public', default: true })
  isPublic!: boolean;

  @Column({ name: 'chunk_tokens', default: 256, nullable: true })
  chunkTokens!: number;

  @Column({ name: 'freshness_at', type: 'timestamptz', nullable: true })
  freshnessAt?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
