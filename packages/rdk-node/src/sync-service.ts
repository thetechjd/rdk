// packages/rdk-node/src/sync-service.ts
// Background sync loop: every N minutes, push unsynced chunks' embedding+metadata
// to RDK Central (only content stays on-node). Moved here from @retrodeck/mcp so
// the CLI, MCP, and desktop share one implementation. UI-agnostic: output goes
// through an injectable `log` callback (defaults to console.error, which is what
// mcp:serve needs — stdout there is JSON-RPC).

import { LocalStore } from '@rdk/core';

export interface SyncConfig {
  enabled: boolean;
  intervalMinutes: number;
  centralApiUrl: string;
  centralApiKey: string;
  /** Progress/diagnostic sink. Defaults to console.error. */
  log?: (message: string) => void;
}

export class SyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private jwtToken?: string;
  private jwtExpiry = 0;
  private readonly log: (message: string) => void;

  constructor(private config: SyncConfig, private store: LocalStore) {
    this.log = config.log ?? ((m) => console.error(m));
  }

  start(): void {
    if (!this.config.enabled) {
      this.log('[sync] auto-sync disabled');
      return;
    }
    this.log(`[sync] starting — every ${this.config.intervalMinutes} minutes`);
    this.syncOnce().catch(e => this.log(`[sync] initial sync failed: ${e}`));
    this.timer = setInterval(
      () => this.syncOnce().catch(e => this.log(`[sync] error: ${e}`)),
      this.config.intervalMinutes * 60 * 1000,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log('[sync] stopped');
  }

  async syncOnce(): Promise<{ synced: number; errors: number }> {
    if (this.syncing) return { synced: 0, errors: 0 };
    this.syncing = true;

    let synced = 0;
    let errors = 0;

    try {
      // Public AND private chunks sync (embedding + metadata); only content stays on-node.
      const unsynced = this.store.getUnsyncedChunks(100);
      if (unsynced.length === 0) return { synced: 0, errors: 0 };

      this.log(`[sync] ${unsynced.length} unsynced chunk(s) found`);

      const jwt = await this.getJwt();

      const payload = [];
      for (const chunk of unsynced) {
        const embedding = this.store.getEmbedding(chunk.id);
        if (!embedding) continue;
        payload.push({
          chunkHash: chunk.id,
          title: chunk.title,                                  // sent for public AND private
          summary: chunk.isPublic ? chunk.summary : undefined, // private summary stays on-node
          domain: chunk.domain,
          categories: chunk.categories,
          embedding: Array.from(embedding),
          isPublic: chunk.isPublic,
          isEncrypted: !chunk.isPublic,  // derived boolean (private ⟺ encrypted) — never a SQLite int
          freshnessAt: chunk.updatedAt.toISOString(),
          chunkTokens: Math.ceil(chunk.content.length / 4),
        });
      }

      if (payload.length === 0) return { synced: 0, errors: 0 };

      const batchSize = 50;
      for (let i = 0; i < payload.length; i += batchSize) {
        const batch = payload.slice(i, i + batchSize);
        try {
          const res = await fetch(`${this.config.centralApiUrl}/api/v1/chunks/sync`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${jwt}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ chunks: batch }),
            signal: AbortSignal.timeout(30_000),
          });

          if (res.ok) {
            const result = await res.json() as { synced: number; errors: string[] };
            synced += result.synced;
            errors += result.errors.length;
            for (const chunk of batch) this.store.markSynced(chunk.chunkHash);
            this.log(`[sync] batch synced: ${result.synced} chunk(s)`);
          } else {
            const errorText = await res.text();
            this.log(`[sync] batch failed: HTTP ${res.status} — ${errorText}`);
            errors += batch.length;
          }
        } catch (e) {
          this.log(`[sync] batch request failed: ${(e as Error).message}`);
          errors += batch.length;
        }
      }
    } finally {
      this.syncing = false;
    }

    return { synced, errors };
  }

  getStatus(): { enabled: boolean; intervalMinutes: number; running: boolean } {
    return {
      enabled: this.config.enabled,
      intervalMinutes: this.config.intervalMinutes,
      running: this.timer !== null,
    };
  }

  private async getJwt(): Promise<string> {
    if (this.jwtToken && Date.now() < this.jwtExpiry) return this.jwtToken;
    const res = await fetch(`${this.config.centralApiUrl}/api/v1/nodes/auth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.centralApiKey}` },
    });
    if (!res.ok) throw new Error(`Auth failed: HTTP ${res.status}`);
    const { jwtToken } = await res.json() as { jwtToken: string };
    this.jwtToken = jwtToken;
    this.jwtExpiry = Date.now() + 55 * 60 * 1000;
    return jwtToken;
  }
}
