// apps/central-api/src/migrations/002_tip_calculator.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class TipCalculator002 implements MigrationInterface {
  name = 'TipCalculator002';

  async up(qr: QueryRunner): Promise<void> {
    // Add chunk_tokens — needed for the size factor in calculateTip()
    // Populated at sync time; defaults to 256 for existing chunks
    await qr.query(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunk_tokens INTEGER DEFAULT 256`);

    // Remove operator-set tip price — tips are now network-calculated
    await qr.query(`ALTER TABLE nodes DROP COLUMN IF EXISTS tip_price_usdc`);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE nodes ADD COLUMN tip_price_usdc DECIMAL(10,6) DEFAULT 0.005`);
    await qr.query(`ALTER TABLE chunks DROP COLUMN IF EXISTS chunk_tokens`);
  }
}
