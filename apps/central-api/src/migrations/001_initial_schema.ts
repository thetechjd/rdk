// apps/central-api/src/migrations/001_initial_schema.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema001 implements MigrationInterface {
  name = 'InitialSchema001';

  async up(qr: QueryRunner): Promise<void> {
    // Enable pgvector extension
    await qr.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await qr.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // Plans (seed data table)
    await qr.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id                        TEXT PRIMARY KEY,
        name                      TEXT NOT NULL,
        price_monthly             DECIMAL(8,2),
        price_yearly              DECIMAL(8,2),
        max_chunks                INTEGER NOT NULL,
        max_queries_day           INTEGER NOT NULL,
        max_team_nodes            INTEGER NOT NULL DEFAULT 0,
        overage_per_1k_chunks     DECIMAL(8,4),
        overage_per_1k_queries    DECIMAL(8,4),
        can_contribute            BOOLEAN DEFAULT true,
        can_consume               BOOLEAN DEFAULT true,
        stripe_price_id_monthly   TEXT,
        stripe_price_id_yearly    TEXT
      )
    `);

    await qr.query(`
      INSERT INTO plans (id,name,price_monthly,price_yearly,max_chunks,max_queries_day,max_team_nodes,overage_per_1k_chunks,overage_per_1k_queries,can_contribute,can_consume)
      VALUES
        ('free',       'Free',        0,    0,    1000,    100,   0, NULL,  NULL,  false, true),
        ('starter',    'Starter',     29,   290,  10000,   1000,  0, NULL,  NULL,  true,  true),
        ('pro',        'Pro',         97,   970,  100000,  10000, 0, NULL,  NULL,  true,  true),
        ('enterprise', 'Enterprise',  297,  2970, 1000000, 50000, 9, 0.50,  0.10,  true,  true)
      ON CONFLICT (id) DO NOTHING
    `);

    // Nodes
    await qr.query(`
      CREATE TABLE IF NOT EXISTS nodes (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        api_key_hash                TEXT UNIQUE NOT NULL,
        owner_email                 TEXT NOT NULL,
        display_name                TEXT NOT NULL,
        domain                      TEXT,
        mcp_endpoint                TEXT,
        wallet_address              TEXT,
        wallet_chain                TEXT DEFAULT 'base',
        tip_price_usdc              DECIMAL(10,6) DEFAULT 0.005,
        plan                        TEXT DEFAULT 'free' REFERENCES plans(id),
        plan_status                 TEXT DEFAULT 'active',
        stripe_customer_id          TEXT,
        stripe_subscription_id      TEXT,
        stripe_meter_id             TEXT,
        parent_node_id              UUID REFERENCES nodes(id),
        team_seat_count             INTEGER DEFAULT 0,
        chunk_count                 INTEGER DEFAULT 0,
        queries_today               INTEGER DEFAULT 0,
        overage_chunks_this_month   INTEGER DEFAULT 0,
        overage_queries_this_month  INTEGER DEFAULT 0,
        contribution_domain         TEXT,
        node_role                   TEXT DEFAULT 'both',
        is_active                   BOOLEAN DEFAULT true,
        last_seen                   TIMESTAMPTZ,
        created_at                  TIMESTAMPTZ DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await qr.query(`CREATE INDEX IF NOT EXISTS idx_nodes_plan ON nodes(plan, plan_status)`);
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_nodes_domain ON nodes(contribution_domain)`);

    // Chunks — pgvector column
    await qr.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        node_id          UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        chunk_hash       TEXT UNIQUE NOT NULL,
        title            TEXT,
        summary          TEXT,
        domain           TEXT,
        categories       TEXT[],
        quality_score    DECIMAL(4,2) DEFAULT 0.0,
        retrieval_count  INTEGER DEFAULT 0,
        last_retrieved   TIMESTAMPTZ,
        embedding        vector(384),
        is_public        BOOLEAN DEFAULT true,
        freshness_at     TIMESTAMPTZ DEFAULT NOW(),
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // IVFFlat index — start with lists=100, migrate to HNSW at 1M+ chunks
    await qr.query(`
      CREATE INDEX IF NOT EXISTS idx_chunks_embedding
        ON chunks USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
    `);
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_chunks_domain ON chunks(domain, is_public, quality_score DESC)`);
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_chunks_node ON chunks(node_id, is_public)`);
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_chunks_freshness ON chunks(freshness_at, is_public)`);

    // Tips ledger
    await qr.query(`
      CREATE TABLE IF NOT EXISTS tips (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chunk_id          UUID REFERENCES chunks(id),
        consumer_node_id  UUID REFERENCES nodes(id),
        provider_node_id  UUID REFERENCES nodes(id),
        amount_usdc       DECIMAL(10,6) NOT NULL,
        chain             TEXT NOT NULL,
        tx_hash           TEXT,
        status            TEXT DEFAULT 'pending',
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await qr.query(`CREATE INDEX IF NOT EXISTS idx_tips_provider ON tips(provider_node_id, status)`);
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_tips_consumer ON tips(consumer_node_id, created_at DESC)`);

    // Query log
    await qr.query(`
      CREATE TABLE IF NOT EXISTS query_log (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        consumer_node_id  UUID REFERENCES nodes(id),
        query_embedding   vector(384),
        matched_chunk_id  UUID REFERENCES chunks(id),
        matched           BOOLEAN,
        latency_ms        INTEGER,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS query_log`);
    await qr.query(`DROP TABLE IF EXISTS tips`);
    await qr.query(`DROP TABLE IF EXISTS chunks`);
    await qr.query(`DROP TABLE IF EXISTS nodes`);
    await qr.query(`DROP TABLE IF EXISTS plans`);
  }
}
